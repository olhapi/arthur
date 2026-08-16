use super::{VaultError, fs, names::validate_basename};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    os::fd::OwnedFd,
};

pub(super) const WORKSPACE_NAME: &str = ".arthur-workspace-v1";
pub(super) const SLOT_COUNT: usize = 4;
pub(super) const MAX_MEDIA_PER_SAVE: usize = 4096;
const WORKSPACE_OWNER: &str = "owner";
const JOURNAL_A: &str = "journal-a";
const JOURNAL_B: &str = "journal-b";
pub(super) const NEW_NOTE: &str = "new-note";
pub(super) const OLD_BACKUP: &str = "old-backup";
const MAX_JOURNAL_BYTES: usize = 1024 * 1024;
const WORKSPACE_MARKER: &[u8] = b"arthur-workspace-owner-v1\nslots=4\nmedia=4096\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum JournalPhase {
    Empty,
    Preparing,
    ExchangePending,
    Committed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct JournalPayload {
    version: u8,
    pub generation: u64,
    pub phase: JournalPhase,
    pub target: Option<String>,
    pub old: Option<fs::FileFingerprint>,
    pub backup: Option<fs::FileFingerprint>,
    pub new: Option<fs::FileFingerprint>,
    owner: fs::FileIdentity,
    journal_a: fs::FileIdentity,
    journal_b: fs::FileIdentity,
    pub new_note: fs::FileIdentity,
    pub old_backup: fs::FileIdentity,
    pub media: BTreeMap<usize, fs::FileIdentity>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalEnvelope {
    payload: JournalPayload,
    checksum: String,
}

pub(super) struct Slot {
    index: usize,
    root: OwnedFd,
    workspace: OwnedFd,
    workspace_owner: File,
    pub directory: OwnedFd,
    owner: File,
    journal_a: File,
    journal_b: File,
    new_note: Option<File>,
    pub old_backup: File,
    pub media: BTreeMap<usize, File>,
    pub journal: JournalPayload,
    quarantined: bool,
    #[cfg(test)]
    fail_next_reset: bool,
}

pub(super) struct Workspace {
    slots: Vec<Slot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoteState {
    Missing,
    Old,
    Backup,
    New,
    Unknown,
    Unsafe,
}

fn note_state(
    directory: &OwnedFd,
    name: &str,
    old: Option<&fs::FileFingerprint>,
    backup: Option<&fs::FileFingerprint>,
    new: &fs::FileFingerprint,
) -> NoteState {
    let fingerprint = match fs::classify_child(directory, name) {
        Ok(fs::ChildKind::Missing) => return NoteState::Missing,
        Ok(fs::ChildKind::Symlink | fs::ChildKind::Fifo) => return NoteState::Unknown,
        Ok(fs::ChildKind::HardLinkedRegular | fs::ChildKind::Other) | Err(_) => {
            return NoteState::Unsafe;
        }
        Ok(fs::ChildKind::OneLinkRegular) => match fs::fingerprint_regular_file(directory, name) {
            Ok(fingerprint) => fingerprint,
            Err(_) => return NoteState::Unsafe,
        },
    };
    if old.is_some_and(|value| fingerprint == *value) {
        NoteState::Old
    } else if backup.is_some_and(|value| fingerprint == *value) {
        NoteState::Backup
    } else if fingerprint == *new {
        NoteState::New
    } else {
        NoteState::Unknown
    }
}

fn slot_name(index: usize) -> String {
    format!("slot-{index}")
}

fn slot_marker(index: usize) -> Vec<u8> {
    format!("arthur-slot-owner-v1\nslot={index}\n").into_bytes()
}

fn media_name(index: usize) -> String {
    format!("media-{index}")
}

fn checksum(payload: &JournalPayload) -> Result<String, VaultError> {
    let bytes = serde_json::to_vec(payload).map_err(|_| VaultError::Io)?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn encode_journal(payload: JournalPayload) -> Result<Vec<u8>, VaultError> {
    let checksum = checksum(&payload)?;
    let bytes =
        serde_json::to_vec(&JournalEnvelope { payload, checksum }).map_err(|_| VaultError::Io)?;
    if bytes.len() > MAX_JOURNAL_BYTES {
        return Err(VaultError::MediaLimitExceeded);
    }
    Ok(bytes)
}

fn decode_journal(file: &mut File) -> Option<JournalPayload> {
    let bytes = fs::read_open_file_prefix(file, MAX_JOURNAL_BYTES + 1).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_JOURNAL_BYTES {
        return None;
    }
    let envelope: JournalEnvelope = serde_json::from_slice(&bytes).ok()?;
    if envelope.checksum.len() != 64 || checksum(&envelope.payload).ok()? != envelope.checksum {
        return None;
    }
    let canonical = encode_journal(envelope.payload.clone()).ok()?;
    if canonical != bytes {
        return None;
    }
    Some(envelope.payload)
}

fn valid_journal_semantics(payload: &JournalPayload) -> bool {
    payload.version == 1
        && payload.generation != u64::MAX
        && payload
            .target
            .as_deref()
            .is_none_or(|target| validate_basename(target).is_ok() && target.ends_with(".md"))
        && payload.media.len() <= MAX_MEDIA_PER_SAVE
        && payload
            .media
            .keys()
            .all(|index| *index < MAX_MEDIA_PER_SAVE)
        && fixed_identities_are_distinct(payload)
        && match payload.phase {
            JournalPhase::Empty | JournalPhase::Preparing => {
                payload.target.is_none()
                    && payload.old.is_none()
                    && payload.backup.is_none()
                    && payload.new.is_none()
            }
            JournalPhase::ExchangePending | JournalPhase::Committed => {
                let (Some(target), Some(new)) = (payload.target.as_deref(), payload.new.as_ref())
                else {
                    return false;
                };
                if validate_basename(target).is_err()
                    || !target.ends_with(".md")
                    || !valid_fingerprint(new)
                {
                    return false;
                }
                let new_matches_fixed_note = fingerprint_matches_identity(new, &payload.new_note);
                let valid_new_phase_identity = match payload.phase {
                    JournalPhase::ExchangePending => new_matches_fixed_note,
                    JournalPhase::Committed => {
                        !fingerprint_matches_any_fixed_identity(new, payload)
                    }
                    JournalPhase::Empty | JournalPhase::Preparing => false,
                };
                if !valid_new_phase_identity {
                    return false;
                }
                match (payload.old.as_ref(), payload.backup.as_ref()) {
                    (None, None) => true,
                    (Some(old), Some(backup)) => {
                        valid_fingerprint(old)
                            && valid_fingerprint(backup)
                            && same_content(old, backup)
                            && !same_fingerprint_identity(old, backup)
                            && !same_fingerprint_identity(new, old)
                            && !same_fingerprint_identity(new, backup)
                            && fingerprint_matches_identity(backup, &payload.old_backup)
                            && match payload.phase {
                                JournalPhase::ExchangePending => {
                                    !fingerprint_matches_any_fixed_identity(old, payload)
                                }
                                JournalPhase::Committed => {
                                    fingerprint_matches_identity(old, &payload.new_note)
                                }
                                JournalPhase::Empty | JournalPhase::Preparing => false,
                            }
                    }
                    _ => false,
                }
            }
        }
}

fn create_fixed_file(directory: &OwnedFd, name: &str, bytes: &[u8]) -> Result<File, VaultError> {
    let mut file = fs::create_exclusive_file(directory, name)?;
    fs::reset_file(&mut file, bytes)?;
    fs::sync_owned_directory(directory)?;
    Ok(file)
}

fn read_exact_marker(file: &mut File, expected: &[u8]) -> bool {
    fs::read_open_file_prefix(file, expected.len() + 1).is_ok_and(|bytes| bytes == expected)
}

fn held_marker_matches(file: &File, expected: &[u8]) -> bool {
    file.try_clone()
        .ok()
        .is_some_and(|mut clone| read_exact_marker(&mut clone, expected))
}

fn valid_fingerprint(value: &fs::FileFingerprint) -> bool {
    value.device != 0
        && value.inode != 0
        && value.links == 1
        && value.sha256.len() == 64
        && value
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn same_fingerprint_identity(left: &fs::FileFingerprint, right: &fs::FileFingerprint) -> bool {
    left.device == right.device && left.inode == right.inode
}

fn fingerprint_matches_identity(
    fingerprint: &fs::FileFingerprint,
    identity: &fs::FileIdentity,
) -> bool {
    fingerprint.device == identity.device && fingerprint.inode == identity.inode
}

fn fingerprint_matches_any_fixed_identity(
    fingerprint: &fs::FileFingerprint,
    payload: &JournalPayload,
) -> bool {
    [
        &payload.owner,
        &payload.journal_a,
        &payload.journal_b,
        &payload.new_note,
        &payload.old_backup,
    ]
    .into_iter()
    .chain(payload.media.values())
    .any(|identity| fingerprint_matches_identity(fingerprint, identity))
}

fn same_content(left: &fs::FileFingerprint, right: &fs::FileFingerprint) -> bool {
    left.size == right.size && left.sha256 == right.sha256
}

fn valid_identity(value: &fs::FileIdentity) -> bool {
    value.device != 0 && value.inode != 0
}

fn fixed_identities_are_distinct(payload: &JournalPayload) -> bool {
    let mut identities = BTreeSet::new();
    for identity in [
        &payload.owner,
        &payload.journal_a,
        &payload.journal_b,
        &payload.new_note,
        &payload.old_backup,
    ]
    .into_iter()
    .chain(payload.media.values())
    {
        if !valid_identity(identity) || !identities.insert((identity.device, identity.inode)) {
            return false;
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn fixed_payload(
    generation: u64,
    phase: JournalPhase,
    target: Option<String>,
    old: Option<fs::FileFingerprint>,
    backup: Option<fs::FileFingerprint>,
    new: Option<fs::FileFingerprint>,
    owner: &File,
    journal_a: &File,
    journal_b: &File,
    new_note: &File,
    old_backup: &File,
    media: &BTreeMap<usize, File>,
) -> Result<JournalPayload, VaultError> {
    Ok(JournalPayload {
        version: 1,
        generation,
        phase,
        target,
        old,
        backup,
        new,
        owner: fs::identity_open_regular_file(owner)?,
        journal_a: fs::identity_open_regular_file(journal_a)?,
        journal_b: fs::identity_open_regular_file(journal_b)?,
        new_note: fs::identity_open_regular_file(new_note)?,
        old_backup: fs::identity_open_regular_file(old_backup)?,
        media: media
            .iter()
            .map(|(index, file)| Ok((*index, fs::identity_open_regular_file(file)?)))
            .collect::<Result<_, VaultError>>()?,
    })
}

fn initialize_slot(
    root: &OwnedFd,
    workspace: &OwnedFd,
    workspace_owner: &File,
    index: usize,
) -> Result<Slot, VaultError> {
    let (directory, created) =
        fs::open_or_create_persistent_child_directory(workspace, &slot_name(index))?;
    if !created {
        return Err(VaultError::UnsafeChild);
    }
    let owner = create_fixed_file(&directory, WORKSPACE_OWNER, &slot_marker(index))?;
    let mut journal_a = create_fixed_file(&directory, JOURNAL_A, b"")?;
    let mut journal_b = create_fixed_file(&directory, JOURNAL_B, b"")?;
    let new_note = create_fixed_file(&directory, NEW_NOTE, b"")?;
    let old_backup = create_fixed_file(&directory, OLD_BACKUP, b"")?;
    let media = BTreeMap::new();
    let first = fixed_payload(
        0,
        JournalPhase::Empty,
        None,
        None,
        None,
        None,
        &owner,
        &journal_a,
        &journal_b,
        &new_note,
        &old_backup,
        &media,
    )?;
    fs::reset_file(&mut journal_a, &encode_journal(first)?)?;
    let journal = fixed_payload(
        1,
        JournalPhase::Empty,
        None,
        None,
        None,
        None,
        &owner,
        &journal_a,
        &journal_b,
        &new_note,
        &old_backup,
        &media,
    )?;
    fs::reset_file(&mut journal_b, &encode_journal(journal.clone())?)?;
    Ok(Slot {
        index,
        root: root.try_clone().map_err(|_| VaultError::Io)?,
        workspace: workspace.try_clone().map_err(|_| VaultError::Io)?,
        workspace_owner: workspace_owner.try_clone().map_err(|_| VaultError::Io)?,
        directory,
        owner,
        journal_a,
        journal_b,
        new_note: Some(new_note),
        old_backup,
        media,
        journal,
        quarantined: false,
        #[cfg(test)]
        fail_next_reset: false,
    })
}

fn open_slot(
    workspace: &OwnedFd,
    workspace_owner: &File,
    destination: &OwnedFd,
    index: usize,
) -> Result<Slot, VaultError> {
    let directory = fs::open_child_directory(workspace, &slot_name(index))?;
    if !fs::child_directory_matches(workspace, &slot_name(index), &directory)? {
        return Err(VaultError::UnsafeChild);
    }
    let children = fs::direct_children_strict(&directory)?;
    if children.iter().any(|name| {
        !matches!(
            name.as_str(),
            WORKSPACE_OWNER | JOURNAL_A | JOURNAL_B | NEW_NOTE | OLD_BACKUP
        ) && !name.strip_prefix("media-").is_some_and(|suffix| {
            suffix
                .parse::<usize>()
                .is_ok_and(|index| index < MAX_MEDIA_PER_SAVE && suffix == index.to_string())
        })
    }) {
        return Err(VaultError::UnsafeChild);
    }
    let mut owner = fs::open_regular_file(&directory, WORKSPACE_OWNER)?;
    if !read_exact_marker(&mut owner, &slot_marker(index)) {
        return Err(VaultError::UnsafeChild);
    }
    let mut journal_a = fs::open_regular_file_for_update(&directory, JOURNAL_A)?;
    let mut journal_b = fs::open_regular_file_for_update(&directory, JOURNAL_B)?;
    let decoded_a = decode_journal(&mut journal_a);
    let decoded_b = decode_journal(&mut journal_b);
    let valid = [decoded_a, decoded_b]
        .into_iter()
        .enumerate()
        .filter_map(|(copy, journal)| journal.map(|journal| (copy, journal)))
        .collect::<Vec<_>>();
    if valid.is_empty()
        || valid
            .iter()
            .any(|(copy, journal)| journal.generation % 2 != *copy as u64)
        || valid
            .iter()
            .any(|(_, journal)| !valid_journal_semantics(journal))
        || (valid.len() == 2 && valid[0].1.generation.abs_diff(valid[1].1.generation) != 1)
    {
        return Err(VaultError::UnsafeChild);
    }
    let journal = valid
        .into_iter()
        .map(|(_, journal)| journal)
        .max_by_key(|journal| journal.generation)
        .ok_or(VaultError::UnsafeChild)?;
    let new_note = match fs::classify_child(&directory, NEW_NOTE)? {
        fs::ChildKind::OneLinkRegular => {
            Some(fs::open_regular_file_for_update(&directory, NEW_NOTE)?)
        }
        fs::ChildKind::Missing if journal_allows_missing_new_note(&journal) => None,
        _ => return Err(VaultError::UnsafeChild),
    };
    let old_backup = fs::open_regular_file_for_update(&directory, OLD_BACKUP)?;
    let mut media = BTreeMap::new();
    for name in children {
        if let Some(suffix) = name.strip_prefix("media-") {
            let media_index = suffix
                .parse::<usize>()
                .map_err(|_| VaultError::UnsafeChild)?;
            media.insert(
                media_index,
                fs::open_regular_file_for_update(&directory, &name)?,
            );
        }
    }
    let slot = Slot {
        index,
        root: destination.try_clone().map_err(|_| VaultError::Io)?,
        workspace: workspace.try_clone().map_err(|_| VaultError::Io)?,
        workspace_owner: workspace_owner.try_clone().map_err(|_| VaultError::Io)?,
        directory,
        owner,
        journal_a,
        journal_b,
        new_note,
        old_backup,
        media,
        journal,
        quarantined: false,
        #[cfg(test)]
        fail_next_reset: false,
    };
    if !slot.inspect_authority(destination)? {
        return Err(VaultError::UnsafeChild);
    }
    Ok(slot)
}

impl Workspace {
    pub(super) fn open(destination: &OwnedFd) -> Result<Self, VaultError> {
        let exists =
            fs::child_exists(destination, WORKSPACE_NAME).map_err(|_| VaultError::UnsafeChild)?;
        let (directory, created) =
            fs::open_or_create_persistent_child_directory(destination, WORKSPACE_NAME)?;
        if exists && created {
            return Err(VaultError::UnsafeChild);
        }
        if created {
            let owner = create_fixed_file(&directory, WORKSPACE_OWNER, WORKSPACE_MARKER)?;
            fs::sync_owned_directory(&directory)?;
            let mut slots = Vec::with_capacity(SLOT_COUNT);
            for index in 0..SLOT_COUNT {
                slots.push(initialize_slot(destination, &directory, &owner, index)?);
            }
            fs::sync_owned_directory(&directory)?;
            return Ok(Self { slots });
        }
        let owner = fs::open_regular_file(&directory, WORKSPACE_OWNER)?;
        if !workspace_authority_is_valid(destination, &directory, &owner)? {
            return Err(VaultError::UnsafeChild);
        }
        // Opening a slot is strictly inspection: no scratch reset, rename, or
        // exchange runs until every slot has had its descriptor and journal
        // authority checked. An invalid slot is quarantined by excluding it
        // from the recovered set; its descriptor tree and destination target
        // are never mutated. Valid slots remain usable after the complete
        // inspection pass.
        let mut inspected = Vec::with_capacity(SLOT_COUNT);
        for index in 0..SLOT_COUNT {
            if let Ok(slot) = open_slot(&directory, &owner, destination, index) {
                inspected.push(slot);
            }
        }
        let slots = inspected
            .into_iter()
            .filter_map(|mut slot| {
                slot.recover(destination)
                    .ok()
                    .filter(|()| !slot.quarantined)
                    .map(|()| slot)
            })
            .collect::<Vec<_>>();
        if slots.is_empty() {
            return Err(VaultError::UnsafeChild);
        }
        Ok(Self { slots })
    }

    pub(super) fn claim(mut self) -> Result<Slot, VaultError> {
        self.slots
            .drain(..)
            .find(|slot| slot.journal.phase == JournalPhase::Empty && !slot.quarantined)
            .ok_or(VaultError::UnsafeChild)
    }
}

fn journal_allows_missing_new_note(payload: &JournalPayload) -> bool {
    payload.phase == JournalPhase::ExchangePending
        && payload.target.is_some()
        && payload.old.is_none()
        && payload.backup.is_none()
        && payload.new.is_some()
}

fn workspace_layout_is_exact(directory: &OwnedFd) -> Result<bool, VaultError> {
    let actual = fs::direct_children_strict(directory)?
        .into_iter()
        .collect::<BTreeSet<_>>();
    let expected = std::iter::once(WORKSPACE_OWNER.to_owned())
        .chain((0..SLOT_COUNT).map(slot_name))
        .collect::<BTreeSet<_>>();
    Ok(actual == expected)
}

fn workspace_authority_is_valid(
    destination: &OwnedFd,
    directory: &OwnedFd,
    owner: &File,
) -> Result<bool, VaultError> {
    Ok(workspace_layout_is_exact(directory)?
        && fs::child_directory_matches(destination, WORKSPACE_NAME, directory)?
        && fs::regular_path_matches_open_file(directory, WORKSPACE_OWNER, owner)?
        && held_marker_matches(owner, WORKSPACE_MARKER))
}

impl Slot {
    fn current_layout_is_exact(&self, allows_missing_new_note: bool) -> Result<bool, VaultError> {
        if !workspace_layout_is_exact(&self.workspace)? {
            return Ok(false);
        }
        let actual = fs::direct_children_strict(&self.directory)?
            .into_iter()
            .collect::<BTreeSet<_>>();
        let mut expected = [WORKSPACE_OWNER, JOURNAL_A, JOURNAL_B, OLD_BACKUP]
            .into_iter()
            .map(str::to_owned)
            .collect::<BTreeSet<_>>();
        if !allows_missing_new_note {
            expected.insert(NEW_NOTE.to_owned());
        }
        expected.extend(self.media.keys().map(|index| media_name(*index)));
        Ok(actual == expected)
    }

    fn journal_fixed_authority_matches(&self) -> Result<bool, VaultError> {
        let new_note_matches = match &self.new_note {
            Some(file) => {
                let current = fs::identity_open_regular_file(file)?;
                self.journal.phase == JournalPhase::ExchangePending
                    || self.journal.new_note == current
            }
            None => journal_allows_missing_new_note(&self.journal),
        };
        Ok(new_note_matches
            && self.journal.owner == fs::identity_open_regular_file(&self.owner)?
            && self.journal.journal_a == fs::identity_open_regular_file(&self.journal_a)?
            && self.journal.journal_b == fs::identity_open_regular_file(&self.journal_b)?
            && self.journal.old_backup == fs::identity_open_regular_file(&self.old_backup)?
            && self.journal.media
                == self
                    .media
                    .iter()
                    .map(|(index, file)| Ok((*index, fs::identity_open_regular_file(file)?)))
                    .collect::<Result<BTreeMap<_, _>, VaultError>>()?)
    }

    fn fixed_paths_match(&self, allows_missing_new_note: bool) -> Result<bool, VaultError> {
        let new_note_matches = match &self.new_note {
            Some(file) => fs::regular_path_matches_open_file(&self.directory, NEW_NOTE, file)?,
            None => allows_missing_new_note,
        };
        Ok(self.current_layout_is_exact(allows_missing_new_note)?
            && fs::child_directory_matches(&self.root, WORKSPACE_NAME, &self.workspace)?
            && fs::regular_path_matches_open_file(
                &self.workspace,
                WORKSPACE_OWNER,
                &self.workspace_owner,
            )?
            && held_marker_matches(&self.workspace_owner, WORKSPACE_MARKER)
            && fs::child_directory_matches(
                &self.workspace,
                &slot_name(self.index),
                &self.directory,
            )?
            && fs::regular_path_matches_open_file(&self.directory, WORKSPACE_OWNER, &self.owner)?
            && held_marker_matches(&self.owner, &slot_marker(self.index))
            && fs::regular_path_matches_open_file(&self.directory, JOURNAL_A, &self.journal_a)?
            && fs::regular_path_matches_open_file(&self.directory, JOURNAL_B, &self.journal_b)?
            && new_note_matches
            && fs::regular_path_matches_open_file(&self.directory, OLD_BACKUP, &self.old_backup)?
            && self.media.iter().all(|(index, file)| {
                fs::regular_path_matches_open_file(&self.directory, &media_name(*index), file)
                    .unwrap_or(false)
            }))
    }

    fn recovery_states_are_authoritative(&self, destination: &OwnedFd) -> bool {
        match self.journal.phase {
            JournalPhase::Empty | JournalPhase::Preparing => true,
            JournalPhase::ExchangePending => {
                let (Some(target), Some(new)) =
                    (self.journal.target.as_deref(), self.journal.new.as_ref())
                else {
                    return false;
                };
                let target_state = note_state(
                    destination,
                    target,
                    self.journal.old.as_ref(),
                    self.journal.backup.as_ref(),
                    new,
                );
                let staged_state = match &self.new_note {
                    Some(_) => note_state(
                        &self.directory,
                        NEW_NOTE,
                        self.journal.old.as_ref(),
                        self.journal.backup.as_ref(),
                        new,
                    ),
                    None => NoteState::Missing,
                };
                if target_state == NoteState::Unsafe || staged_state == NoteState::Unsafe {
                    return false;
                }
                match (self.journal.old.as_ref(), self.journal.backup.as_ref()) {
                    (None, None) => matches!(
                        (target_state, staged_state),
                        (NoteState::Missing, NoteState::New) | (NoteState::New, NoteState::Missing)
                    ),
                    (Some(old), Some(backup)) => {
                        let backup_state =
                            note_state(&self.directory, OLD_BACKUP, Some(old), Some(backup), new);
                        !matches!(backup_state, NoteState::Unsafe)
                            && backup_state == NoteState::Backup
                            && matches!(staged_state, NoteState::New | NoteState::Old)
                    }
                    _ => false,
                }
            }
            JournalPhase::Committed => {
                let (Some(target), Some(new)) =
                    (self.journal.target.as_deref(), self.journal.new.as_ref())
                else {
                    return false;
                };
                if note_state(
                    destination,
                    target,
                    self.journal.old.as_ref(),
                    self.journal.backup.as_ref(),
                    new,
                ) != NoteState::New
                {
                    return false;
                }
                match self.journal.old.as_ref() {
                    Some(old) => {
                        self.new_note.as_ref().is_some()
                            && note_state(
                                &self.directory,
                                NEW_NOTE,
                                Some(old),
                                self.journal.backup.as_ref(),
                                new,
                            ) == NoteState::Old
                    }
                    None => self.new_note.is_some(),
                }
            }
        }
    }

    fn inspect_authority(&self, destination: &OwnedFd) -> Result<bool, VaultError> {
        let allows_missing_new_note = journal_allows_missing_new_note(&self.journal);
        Ok(valid_journal_semantics(&self.journal)
            && self.fixed_paths_match(allows_missing_new_note)?
            && self.journal_fixed_authority_matches()?
            && self.recovery_states_are_authoritative(destination))
    }

    fn recover(&mut self, destination: &OwnedFd) -> Result<(), VaultError> {
        if !self.inspect_authority(destination).unwrap_or(false) {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        match self.journal.phase {
            JournalPhase::Empty => Ok(()),
            JournalPhase::Preparing => self.reset_to_empty(),
            JournalPhase::ExchangePending => self.recover_exchange(destination),
            JournalPhase::Committed => {
                let target = self
                    .journal
                    .target
                    .as_deref()
                    .ok_or(VaultError::UnsafeChild)?;
                let new = self.journal.new.as_ref().ok_or(VaultError::UnsafeChild)?;
                if note_state(
                    destination,
                    target,
                    self.journal.old.as_ref(),
                    self.journal.backup.as_ref(),
                    new,
                ) != NoteState::New
                    || !self.verify_fixed_paths()?
                {
                    self.quarantine();
                    return Err(VaultError::UnsafeChild);
                }
                fs::sync_owned_directory(destination)?;
                self.reset_to_empty()
            }
        }
    }

    fn recover_exchange(&mut self, destination: &OwnedFd) -> Result<(), VaultError> {
        let target = self.journal.target.clone().ok_or(VaultError::UnsafeChild)?;
        let new = self.journal.new.clone().ok_or(VaultError::UnsafeChild)?;
        let old = self.journal.old.clone();
        let backup = self.journal.backup.clone();
        let target_state = note_state(destination, &target, old.as_ref(), backup.as_ref(), &new);
        let staged_state = match self.new_note.as_ref() {
            Some(_) => note_state(
                &self.directory,
                NEW_NOTE,
                old.as_ref(),
                backup.as_ref(),
                &new,
            ),
            None => NoteState::Missing,
        };
        if target_state == NoteState::Unsafe || staged_state == NoteState::Unsafe {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        if old.is_none() {
            return match (target_state, staged_state) {
                (NoteState::Missing, NoteState::New) => self.reset_to_empty(),
                (NoteState::New, NoteState::Missing) => {
                    self.recreate_new_note()?;
                    fs::sync_owned_directory(destination)?;
                    self.persist(JournalPhase::Committed, Some(target), None, None, Some(new))?;
                    self.reset_to_empty()
                }
                _ => {
                    self.quarantine();
                    Err(VaultError::UnsafeChild)
                }
            };
        }
        let old = old.ok_or(VaultError::UnsafeChild)?;
        let backup = backup.ok_or(VaultError::UnsafeChild)?;
        let backup_state = note_state(&self.directory, OLD_BACKUP, Some(&old), Some(&backup), &new);
        if backup_state == NoteState::Unsafe {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        match (target_state, staged_state, backup_state) {
            (NoteState::Old, NoteState::New, NoteState::Backup) => self.reset_to_empty(),
            (NoteState::New, NoteState::Old, NoteState::Backup) => {
                fs::sync_owned_directory(destination)?;
                self.reopen_new_note(&old)?;
                self.persist(
                    JournalPhase::Committed,
                    Some(target),
                    Some(old),
                    Some(backup),
                    Some(new),
                )?;
                self.reset_to_empty()
            }
            (NoteState::Missing, _, NoteState::Backup) => {
                fs::rename_no_replace_between(&self.directory, OLD_BACKUP, destination, &target)?;
                fs::sync_owned_directory(destination)?;
                self.quarantine();
                Err(VaultError::UnsafeChild)
            }
            (NoteState::Unknown, _, NoteState::Backup) => {
                fs::rename_exchange_between(&self.directory, OLD_BACKUP, destination, &target)?;
                fs::sync_owned_directory(&self.directory)?;
                fs::sync_owned_directory(destination)?;
                self.quarantine();
                Err(VaultError::UnsafeChild)
            }
            _ => {
                self.quarantine();
                Err(VaultError::UnsafeChild)
            }
        }
    }

    pub(super) fn fixed_media_name(index: usize) -> Result<String, VaultError> {
        if index >= MAX_MEDIA_PER_SAVE {
            return Err(VaultError::MediaLimitExceeded);
        }
        Ok(media_name(index))
    }

    pub(super) fn persist(
        &mut self,
        phase: JournalPhase,
        target: Option<String>,
        old: Option<fs::FileFingerprint>,
        backup: Option<fs::FileFingerprint>,
        new: Option<fs::FileFingerprint>,
    ) -> Result<(), VaultError> {
        if self.quarantined {
            return Err(VaultError::UnsafeChild);
        }
        if !self.verify_fixed_paths()? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        let generation = self
            .journal
            .generation
            .checked_add(1)
            .ok_or(VaultError::Io)?;
        let payload = fixed_payload(
            generation,
            phase,
            target,
            old,
            backup,
            new,
            &self.owner,
            &self.journal_a,
            &self.journal_b,
            self.new_note_file()?,
            &self.old_backup,
            &self.media,
        )?;
        let bytes = encode_journal(payload.clone())?;
        let journal_file = if generation % 2 == 0 {
            &mut self.journal_a
        } else {
            &mut self.journal_b
        };
        fs::reset_file(journal_file, &bytes)?;
        fs::sync_owned_directory(&self.directory)?;
        self.journal = payload;
        Ok(())
    }

    pub(super) fn verify_fixed_paths(&self) -> Result<bool, VaultError> {
        self.fixed_paths_match(false)
    }

    pub(super) fn new_note_file(&self) -> Result<&File, VaultError> {
        self.new_note.as_ref().ok_or(VaultError::UnsafeChild)
    }

    pub(super) fn new_note_file_mut(&mut self) -> Result<&mut File, VaultError> {
        self.new_note.as_mut().ok_or(VaultError::UnsafeChild)
    }

    #[cfg(test)]
    pub(super) fn index(&self) -> usize {
        self.index
    }

    pub(super) fn quarantine(&mut self) {
        self.quarantined = true;
    }

    pub(super) fn is_quarantined(&self) -> bool {
        self.quarantined
    }

    pub(super) fn restore_old_visibility(
        &mut self,
        destination: &OwnedFd,
        target: &str,
        old: &fs::FileFingerprint,
        backup: &fs::FileFingerprint,
        new: &fs::FileFingerprint,
    ) -> Result<bool, VaultError> {
        if note_state(destination, target, Some(old), Some(backup), new) == NoteState::Old {
            self.quarantine();
            return Ok(true);
        }
        if note_state(&self.directory, OLD_BACKUP, Some(old), Some(backup), new)
            != NoteState::Backup
        {
            self.quarantine();
            return Ok(false);
        }
        match note_state(destination, target, Some(old), Some(backup), new) {
            NoteState::Missing => {
                fs::rename_no_replace_between(&self.directory, OLD_BACKUP, destination, target)?
            }
            NoteState::New | NoteState::Unknown | NoteState::Backup => {
                fs::rename_exchange_between(&self.directory, OLD_BACKUP, destination, target)?;
                fs::sync_owned_directory(&self.directory)?;
                fs::sync_owned_directory(destination)?;
            }
            NoteState::Unsafe => {
                self.quarantine();
                return Ok(false);
            }
            NoteState::Old => unreachable!(),
        }
        self.quarantine();
        Ok(note_state(destination, target, Some(old), Some(backup), new) == NoteState::Backup)
    }

    pub(super) fn begin(&mut self) -> Result<(), VaultError> {
        if !self.verify_fixed_paths()? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        fs::reset_file(self.new_note_file_mut()?, b"")?;
        fs::reset_file(&mut self.old_backup, b"")?;
        for file in self.media.values_mut() {
            fs::reset_file(file, b"")?;
        }
        self.persist(JournalPhase::Preparing, None, None, None, None)
    }

    pub(super) fn ensure_media(&mut self, index: usize) -> Result<&mut File, VaultError> {
        let name = Self::fixed_media_name(index)?;
        if self.media.contains_key(&index) {
            let matches = {
                let file = self.media.get(&index).expect("checked media file");
                fs::regular_path_matches_open_file(&self.directory, &name, file)?
            };
            if !matches {
                self.quarantine();
                return Err(VaultError::UnsafeChild);
            }
            let file = self.media.get_mut(&index).expect("checked media file");
            fs::reset_file(file, b"")?;
            return Ok(file);
        }
        if fs::child_exists(&self.directory, &name)? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        let mut file = fs::create_exclusive_file(&self.directory, &name)?;
        fs::reset_file(&mut file, b"")?;
        fs::sync_owned_directory(&self.directory)?;
        self.media.insert(index, file);
        self.persist(JournalPhase::Preparing, None, None, None, None)?;
        Ok(self.media.get_mut(&index).expect("inserted media file"))
    }

    pub(super) fn media_file(&self, index: usize) -> Result<&File, VaultError> {
        self.media.get(&index).ok_or(VaultError::InvalidTransition)
    }

    pub(super) fn media_file_mut(&mut self, index: usize) -> Result<&mut File, VaultError> {
        let name = Self::fixed_media_name(index)?;
        let matches = self.media.get(&index).is_some_and(|file| {
            fs::regular_path_matches_open_file(&self.directory, &name, file).unwrap_or(false)
        });
        if !matches {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        self.media
            .get_mut(&index)
            .ok_or(VaultError::InvalidTransition)
    }

    pub(super) fn media_path_matches(&self, index: usize) -> Result<bool, VaultError> {
        let file = self.media_file(index)?;
        fs::regular_path_matches_open_file(&self.directory, &Self::fixed_media_name(index)?, file)
    }

    pub(super) fn recreate_media(&mut self, index: usize) -> Result<(), VaultError> {
        let name = Self::fixed_media_name(index)?;
        if fs::child_exists(&self.directory, &name)? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        let mut file = fs::create_exclusive_file(&self.directory, &name)?;
        fs::reset_file(&mut file, b"")?;
        fs::sync_owned_directory(&self.directory)?;
        self.media.insert(index, file);
        self.persist(
            self.journal.phase,
            self.journal.target.clone(),
            self.journal.old.clone(),
            self.journal.backup.clone(),
            self.journal.new.clone(),
        )
    }

    pub(super) fn write_new_note(
        &mut self,
        bytes: &[u8],
    ) -> Result<fs::FileFingerprint, VaultError> {
        if !fs::regular_path_matches_open_file(&self.directory, NEW_NOTE, self.new_note_file()?)? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        fs::reset_file(self.new_note_file_mut()?, bytes)?;
        fs::fingerprint_open_regular_file(self.new_note_file_mut()?)
    }

    pub(super) fn copy_old_note(
        &mut self,
        source: &mut File,
    ) -> Result<fs::FileFingerprint, VaultError> {
        if !fs::regular_path_matches_open_file(&self.directory, OLD_BACKUP, &self.old_backup)? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        fs::copy_file(source, &mut self.old_backup)?;
        fs::fingerprint_open_regular_file(&mut self.old_backup)
    }

    pub(super) fn recreate_new_note(&mut self) -> Result<(), VaultError> {
        if fs::child_exists(&self.directory, NEW_NOTE)? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        let mut file = fs::create_exclusive_file(&self.directory, NEW_NOTE)?;
        fs::reset_file(&mut file, b"")?;
        fs::sync_owned_directory(&self.directory)?;
        self.new_note = Some(file);
        Ok(())
    }

    pub(super) fn reopen_new_note(
        &mut self,
        expected: &fs::FileFingerprint,
    ) -> Result<(), VaultError> {
        let mut file = fs::open_regular_file_for_update(&self.directory, NEW_NOTE)?;
        if fs::fingerprint_open_regular_file(&mut file)? != *expected
            || !fs::regular_file_matches_fingerprint(&self.directory, NEW_NOTE, expected)?
        {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        self.new_note = Some(file);
        Ok(())
    }

    pub(super) fn reset_to_empty(&mut self) -> Result<(), VaultError> {
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_reset) {
            return Err(VaultError::Io);
        }
        if !self.verify_fixed_paths()? {
            self.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        fs::reset_file(self.new_note_file_mut()?, b"")?;
        fs::reset_file(&mut self.old_backup, b"")?;
        for file in self.media.values_mut() {
            fs::reset_file(file, b"")?;
        }
        self.persist(JournalPhase::Empty, None, None, None, None)
    }

    #[cfg(test)]
    pub(super) fn fail_next_reset(&mut self) {
        self.fail_next_reset = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs as stdfs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static COUNT: AtomicU64 = AtomicU64::new(0);

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "arthur-workspace-{}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        ));
        stdfs::create_dir(&path).unwrap();
        path
    }

    fn alternate_inode(base: u64, excluded: &[u64]) -> u64 {
        let mut candidate = base;
        loop {
            candidate = candidate.wrapping_add(1);
            if candidate != 0 && !excluded.contains(&candidate) {
                return candidate;
            }
        }
    }

    #[test]
    fn note_state_fails_closed_on_classifier_and_fingerprint_errors_and_only_allows_known_opaque_substitutes()
     {
        use std::os::unix::fs::symlink;

        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let target = "Article.md";
        let unmatched = fs::FileFingerprint {
            device: 1,
            inode: 2,
            links: 1,
            size: 0,
            sha256: "a".repeat(64),
        };
        stdfs::write(path.join(target), b"one-link substitute").unwrap();

        fs::fail_next_child_classification();
        assert_eq!(
            note_state(&destination, target, None, None, &unmatched),
            NoteState::Unsafe
        );
        fs::fail_next_regular_file_fingerprint();
        assert_eq!(
            note_state(&destination, target, None, None, &unmatched),
            NoteState::Unsafe
        );

        stdfs::remove_file(path.join(target)).unwrap();
        stdfs::create_dir(path.join(target)).unwrap();
        assert_eq!(
            note_state(&destination, target, None, None, &unmatched),
            NoteState::Unsafe
        );
        stdfs::remove_dir(path.join(target)).unwrap();

        let outside = path.join("outside");
        stdfs::write(&outside, b"outside").unwrap();
        symlink(&outside, path.join(target)).unwrap();
        assert_eq!(
            note_state(&destination, target, None, None, &unmatched),
            NoteState::Unknown
        );
        stdfs::remove_file(path.join(target)).unwrap();

        assert!(
            std::process::Command::new("mkfifo")
                .arg(path.join(target))
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(
            note_state(&destination, target, None, None, &unmatched),
            NoteState::Unknown
        );

        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn injected_fingerprint_error_quarantines_only_its_slot_without_mutating_target_or_backup() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        stdfs::write(path.join("Article.md"), b"old").unwrap();
        let old = fs::fingerprint_regular_file(&destination, "Article.md").unwrap();
        let new = slot.write_new_note(b"new").unwrap();
        let mut source = fs::open_regular_file(&destination, "Article.md").unwrap();
        let backup = slot.copy_old_note(&mut source).unwrap();
        slot.persist(
            JournalPhase::ExchangePending,
            Some("Article.md".to_owned()),
            Some(old),
            Some(backup),
            Some(new),
        )
        .unwrap();
        drop(source);
        drop(slot);
        drop(destination);

        let workspace = path.join(WORKSPACE_NAME).join("slot-0");
        let target = path.join("Article.md");
        let backup = workspace.join(OLD_BACKUP);
        stdfs::rename(&target, path.join("displaced-article")).unwrap();
        stdfs::write(&target, b"unrelated target").unwrap();
        let target_before = stdfs::read(&target).unwrap();
        let backup_before = stdfs::read(&backup).unwrap();

        fs::fail_next_regular_file_fingerprint();
        let destination = fs::open_destination(&path).unwrap();
        let next = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(next.index(), 1);
        assert_eq!(stdfs::read(&target).unwrap(), target_before);
        assert_eq!(stdfs::read(&backup).unwrap(), backup_before);

        drop(next);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn recovery_does_not_exchange_a_known_symlink_when_the_staged_classifier_errors() {
        use std::os::unix::fs::symlink;

        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        stdfs::write(path.join("Article.md"), b"old").unwrap();
        let old = fs::fingerprint_regular_file(&destination, "Article.md").unwrap();
        let new = slot.write_new_note(b"new").unwrap();
        let mut source = fs::open_regular_file(&destination, "Article.md").unwrap();
        let backup = slot.copy_old_note(&mut source).unwrap();
        slot.persist(
            JournalPhase::ExchangePending,
            Some("Article.md".to_owned()),
            Some(old),
            Some(backup),
            Some(new),
        )
        .unwrap();
        drop(source);

        let target = path.join("Article.md");
        let outside = path.join("outside");
        stdfs::rename(&target, path.join("displaced-article")).unwrap();
        stdfs::write(&outside, b"outside").unwrap();
        symlink(&outside, &target).unwrap();
        let backup = path.join(WORKSPACE_NAME).join("slot-0").join(OLD_BACKUP);
        let backup_before = stdfs::read(&backup).unwrap();

        // The target is a deliberately recoverable opaque substitute. The
        // injected failure is for the staged fixed child classifier; recovery
        // must not exchange the backup merely because the target is opaque.
        fs::fail_next_regular_file_fingerprint();
        assert_eq!(
            slot.recover_exchange(&destination),
            Err(VaultError::UnsafeChild)
        );
        assert!(
            stdfs::symlink_metadata(&target)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(stdfs::read(&outside).unwrap(), b"outside");
        assert_eq!(stdfs::read(&backup).unwrap(), backup_before);

        drop(slot);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn torn_newest_journal_falls_back_to_the_prior_valid_generation() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        assert_eq!(slot.journal.generation, 2);
        drop(slot);
        drop(destination);
        stdfs::write(
            path.join(WORKSPACE_NAME).join("slot-0").join(JOURNAL_A),
            b"torn",
        )
        .unwrap();

        let destination = fs::open_destination(&path).unwrap();
        let slot = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(slot.index, 0);
        assert_eq!(slot.journal.phase, JournalPhase::Empty);
        drop(slot);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn later_invalid_slot_is_inspected_before_earlier_preparing_slot_recovers() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        slot.write_new_note(b"earlier staged note").unwrap();
        let first_scratch = path.join(WORKSPACE_NAME).join("slot-0").join(NEW_NOTE);
        let later_owner = path
            .join(WORKSPACE_NAME)
            .join("slot-3")
            .join(WORKSPACE_OWNER);
        drop(slot);
        drop(destination);

        stdfs::write(&later_owner, b"later substitute").unwrap();

        let destination = fs::open_destination(&path).unwrap();
        let next = Workspace::open(&destination).unwrap().claim().unwrap();

        assert_eq!(next.index(), 0);
        assert_eq!(stdfs::read(&first_scratch).unwrap(), b"");
        assert_eq!(stdfs::read(&later_owner).unwrap(), b"later substitute");

        drop(next);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn reopening_after_opaque_substitute_recovery_uses_another_valid_slot() {
        use std::os::unix::fs::symlink;

        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        let target = path.join("Article.md");
        let displaced = path.join("displaced-article");
        let outside = path.join("outside");
        stdfs::write(&target, b"old").unwrap();
        let old = fs::fingerprint_regular_file(&destination, "Article.md").unwrap();
        let new = slot.write_new_note(b"new").unwrap();
        let mut source = fs::open_regular_file(&destination, "Article.md").unwrap();
        let backup = slot.copy_old_note(&mut source).unwrap();
        slot.persist(
            JournalPhase::ExchangePending,
            Some("Article.md".to_owned()),
            Some(old),
            Some(backup),
            Some(new),
        )
        .unwrap();
        let backup_path = path.join(WORKSPACE_NAME).join("slot-0").join(OLD_BACKUP);
        stdfs::rename(&target, &displaced).unwrap();
        stdfs::write(&outside, b"outside").unwrap();
        symlink(&outside, &target).unwrap();
        drop(source);
        drop(slot);
        drop(destination);

        let destination = fs::open_destination(&path).unwrap();
        let first = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(first.index(), 1);
        assert_eq!(stdfs::read(&target).unwrap(), b"old");
        assert!(
            stdfs::symlink_metadata(&backup_path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        drop(first);
        drop(destination);

        let destination = fs::open_destination(&path).unwrap();
        let second = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(second.index(), 1);
        assert_eq!(stdfs::read(&target).unwrap(), b"old");
        assert!(
            stdfs::symlink_metadata(&backup_path)
                .unwrap()
                .file_type()
                .is_symlink()
        );

        drop(second);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn corrupted_journals_quarantine_each_slot_and_fail_when_all_four_are_bad() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        drop(Workspace::open(&destination).unwrap());
        drop(destination);
        for index in 0..SLOT_COUNT {
            let slot = path.join(WORKSPACE_NAME).join(format!("slot-{index}"));
            stdfs::write(slot.join(JOURNAL_A), b"bad-a").unwrap();
            stdfs::write(slot.join(JOURNAL_B), b"bad-b").unwrap();
        }
        let destination = fs::open_destination(&path).unwrap();
        assert!(matches!(
            Workspace::open(&destination),
            Err(VaultError::UnsafeChild)
        ));
        drop(destination);
        for index in 0..SLOT_COUNT {
            let slot = path.join(WORKSPACE_NAME).join(format!("slot-{index}"));
            assert_eq!(stdfs::read(slot.join(JOURNAL_A)).unwrap(), b"bad-a");
            assert_eq!(stdfs::read(slot.join(JOURNAL_B)).unwrap(), b"bad-b");
        }
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn checksum_valid_semantic_mismatch_and_generation_gap_quarantine_only_their_slot() {
        for gap in [false, true] {
            let path = temp();
            let destination = fs::open_destination(&path).unwrap();
            let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
            slot.begin().unwrap();
            let mut invalid = slot.journal.clone();
            if gap {
                invalid.generation = 4;
            } else {
                invalid.target = Some("must-not-fallback.md".to_owned());
            }
            drop(slot);
            drop(destination);
            stdfs::write(
                path.join(WORKSPACE_NAME).join("slot-0").join(JOURNAL_A),
                encode_journal(invalid).unwrap(),
            )
            .unwrap();

            let destination = fs::open_destination(&path).unwrap();
            let next = Workspace::open(&destination).unwrap().claim().unwrap();
            assert_eq!(next.index(), 1);
            drop(next);
            drop(destination);
            stdfs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn journal_semantics_reject_old_backup_alias_content_and_link_count_mismatches() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        let new = slot.write_new_note(b"new").unwrap();
        let mut payload = slot.journal.clone();
        payload.phase = JournalPhase::ExchangePending;
        payload.target = Some("Article.md".to_owned());
        payload.new = Some(new);

        let old = fs::FileFingerprint {
            device: 7,
            inode: 11,
            size: 3,
            sha256: "a".repeat(64),
            links: 1,
        };
        let distinct_backup = fs::FileFingerprint {
            device: 7,
            inode: 12,
            size: 3,
            sha256: "a".repeat(64),
            links: 1,
        };

        payload.old = Some(old.clone());
        payload.backup = Some(old.clone());
        assert!(
            !valid_journal_semantics(&payload),
            "old and backup must never identify the same inode"
        );

        payload.backup = Some(fs::FileFingerprint {
            sha256: "b".repeat(64),
            ..distinct_backup.clone()
        });
        assert!(
            !valid_journal_semantics(&payload),
            "old and backup must be byte-identical"
        );

        payload.backup = Some(fs::FileFingerprint {
            size: 4,
            ..distinct_backup.clone()
        });
        assert!(
            !valid_journal_semantics(&payload),
            "old and backup must have the same size"
        );

        payload.backup = Some(distinct_backup.clone());
        payload.old = Some(fs::FileFingerprint {
            links: 2,
            ..old.clone()
        });
        assert!(
            !valid_journal_semantics(&payload),
            "journal fingerprints require one visible link"
        );

        payload.old = None;
        assert!(
            !valid_journal_semantics(&payload),
            "old and backup must be present together"
        );

        payload.old = Some(old);
        payload.phase = JournalPhase::Committed;
        assert!(
            !valid_journal_semantics(&payload),
            "a committed new note must no longer identify the fixed new-note child"
        );

        payload.phase = JournalPhase::Preparing;
        assert!(
            !valid_journal_semantics(&payload),
            "preparing journals forbid recovery fingerprints and targets"
        );

        drop(slot);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn journal_semantics_bind_phase_fingerprints_to_fixed_files() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        stdfs::write(path.join("Article.md"), b"old").unwrap();
        let old = fs::fingerprint_regular_file(&destination, "Article.md").unwrap();
        let new = slot.write_new_note(b"new").unwrap();
        let mut source = fs::open_regular_file(&destination, "Article.md").unwrap();
        let backup = slot.copy_old_note(&mut source).unwrap();
        drop(source);
        slot.persist(
            JournalPhase::ExchangePending,
            Some("Article.md".to_owned()),
            Some(old.clone()),
            Some(backup.clone()),
            Some(new.clone()),
        )
        .unwrap();

        let mut exchange_pending = slot.journal.clone();
        assert!(valid_journal_semantics(&exchange_pending));
        let mut forged_backup = backup.clone();
        forged_backup.inode = alternate_inode(backup.inode, &[old.inode, new.inode]);
        exchange_pending.backup = Some(forged_backup);
        assert!(
            !valid_journal_semantics(&exchange_pending),
            "exchange-pending backups must identify the fixed old-backup file"
        );

        fs::rename_exchange_between(&slot.directory, NEW_NOTE, &destination, "Article.md").unwrap();
        slot.reopen_new_note(&old).unwrap();
        slot.persist(
            JournalPhase::Committed,
            Some("Article.md".to_owned()),
            Some(old.clone()),
            Some(backup.clone()),
            Some(new.clone()),
        )
        .unwrap();

        let mut committed = slot.journal.clone();
        assert!(valid_journal_semantics(&committed));
        let mut forged_old = old.clone();
        forged_old.inode = alternate_inode(old.inode, &[backup.inode, new.inode]);
        committed.old = Some(forged_old);
        assert!(
            !valid_journal_semantics(&committed),
            "committed old notes must identify the fixed new-note file"
        );

        drop(slot);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn checksum_valid_impossible_journal_quarantines_its_slot_without_resetting_scratch() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        stdfs::write(path.join("Article.md"), b"old").unwrap();
        let old = fs::fingerprint_regular_file(&destination, "Article.md").unwrap();
        let new = slot.write_new_note(b"new").unwrap();
        fs::reset_file(&mut slot.old_backup, b"different backup").unwrap();
        let backup = fs::fingerprint_open_regular_file(&mut slot.old_backup).unwrap();
        let mut impossible = slot.journal.clone();
        impossible.generation = impossible.generation.checked_add(1).unwrap();
        impossible.phase = JournalPhase::ExchangePending;
        impossible.target = Some("Article.md".to_owned());
        impossible.old = Some(old);
        impossible.backup = Some(backup);
        impossible.new = Some(new);
        let journal = encode_journal(impossible).unwrap();
        fs::reset_file(&mut slot.journal_b, &journal).unwrap();
        let slot_path = path.join(WORKSPACE_NAME).join("slot-0");
        drop(slot);
        drop(destination);

        let destination = fs::open_destination(&path).unwrap();
        let next = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(next.index(), 1);
        assert_eq!(stdfs::read(slot_path.join(NEW_NOTE)).unwrap(), b"new");
        assert_eq!(
            stdfs::read(slot_path.join(OLD_BACKUP)).unwrap(),
            b"different backup"
        );
        assert_eq!(stdfs::read(slot_path.join(JOURNAL_B)).unwrap(), journal);
        drop(next);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn recovery_only_exchanges_safe_regular_substitutes_and_preserves_unsafe_targets() {
        use std::os::unix::fs::FileTypeExt;

        #[derive(Clone, Copy)]
        enum Substitute {
            Regular,
            Symlink,
            Fifo,
            HardLink,
        }

        for substitute in [
            Substitute::Regular,
            Substitute::Symlink,
            Substitute::Fifo,
            Substitute::HardLink,
        ] {
            let path = temp();
            let destination = fs::open_destination(&path).unwrap();
            let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
            slot.begin().unwrap();
            let target = path.join("Article.md");
            let displaced = path.join("displaced-article");
            let outside = path.join("outside");
            stdfs::write(&target, b"old").unwrap();
            let old = fs::fingerprint_regular_file(&destination, "Article.md").unwrap();
            let new = slot.write_new_note(b"new").unwrap();
            let mut source = fs::open_regular_file(&destination, "Article.md").unwrap();
            let backup = slot.copy_old_note(&mut source).unwrap();
            slot.persist(
                JournalPhase::ExchangePending,
                Some("Article.md".to_owned()),
                Some(old),
                Some(backup),
                Some(new),
            )
            .unwrap();
            let slot_path = path.join(WORKSPACE_NAME).join("slot-0");

            match substitute {
                Substitute::Regular => {
                    stdfs::rename(&target, &displaced).unwrap();
                    stdfs::write(&target, b"regular substitute").unwrap();
                }
                Substitute::Symlink => {
                    stdfs::rename(&target, &displaced).unwrap();
                    stdfs::write(&outside, b"outside").unwrap();
                    std::os::unix::fs::symlink(&outside, &target).unwrap();
                }
                Substitute::Fifo => {
                    stdfs::rename(&target, &displaced).unwrap();
                    assert!(
                        std::process::Command::new("mkfifo")
                            .arg(&target)
                            .status()
                            .unwrap()
                            .success()
                    );
                }
                Substitute::HardLink => {
                    stdfs::hard_link(&target, path.join("article-alias")).unwrap();
                }
            }
            drop(source);
            drop(slot);
            drop(destination);

            let destination = fs::open_destination(&path).unwrap();
            let opened = Workspace::open(&destination);
            match substitute {
                Substitute::Regular => {
                    let next = opened.unwrap().claim().unwrap();
                    assert_eq!(next.index(), 1);
                    assert_eq!(stdfs::read(&target).unwrap(), b"old");
                    assert_eq!(
                        stdfs::read(slot_path.join(OLD_BACKUP)).unwrap(),
                        b"regular substitute"
                    );
                    drop(next);
                }
                Substitute::Symlink => {
                    let next = opened.unwrap().claim().unwrap();
                    assert_eq!(next.index(), 1);
                    assert_eq!(stdfs::read(&target).unwrap(), b"old");
                    assert_eq!(stdfs::read(&outside).unwrap(), b"outside");
                    assert!(
                        stdfs::symlink_metadata(slot_path.join(OLD_BACKUP))
                            .unwrap()
                            .file_type()
                            .is_symlink()
                    );
                    drop(next);
                }
                Substitute::Fifo => {
                    let next = opened.unwrap().claim().unwrap();
                    assert_eq!(next.index(), 1);
                    assert_eq!(stdfs::read(&target).unwrap(), b"old");
                    assert!(
                        stdfs::symlink_metadata(slot_path.join(OLD_BACKUP))
                            .unwrap()
                            .file_type()
                            .is_fifo()
                    );
                    drop(next);
                }
                Substitute::HardLink => {
                    let next = opened.unwrap().claim().unwrap();
                    assert_eq!(next.index(), 1);
                    assert_eq!(stdfs::read(&target).unwrap(), b"old");
                    assert_eq!(stdfs::read(path.join("article-alias")).unwrap(), b"old");
                    assert_eq!(stdfs::read(slot_path.join(OLD_BACKUP)).unwrap(), b"old");
                    drop(next);
                }
            }
            assert_eq!(stdfs::read(slot_path.join(NEW_NOTE)).unwrap(), b"new");
            drop(destination);
            stdfs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn preparing_recovery_resets_verified_scratch_and_keeps_the_prior_note() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        stdfs::write(path.join("Article.md"), b"old").unwrap();
        slot.write_new_note(b"new").unwrap();
        let mut old = fs::open_regular_file(&destination, "Article.md").unwrap();
        slot.copy_old_note(&mut old).unwrap();
        let slot_path = path.join(WORKSPACE_NAME).join("slot-0");
        drop(old);
        drop(slot);
        drop(destination);

        let destination = fs::open_destination(&path).unwrap();
        let next = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(next.index(), 0);
        assert_eq!(next.journal.phase, JournalPhase::Empty);
        assert_eq!(stdfs::read(path.join("Article.md")).unwrap(), b"old");
        assert_eq!(stdfs::read(slot_path.join(NEW_NOTE)).unwrap(), b"");
        assert_eq!(stdfs::read(slot_path.join(OLD_BACKUP)).unwrap(), b"");
        drop(next);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn committed_recovery_keeps_the_new_note_and_resets_exact_scratch() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        let new = slot.write_new_note(b"new").unwrap();
        fs::rename_no_replace_between(&slot.directory, NEW_NOTE, &destination, "Article.md")
            .unwrap();
        slot.recreate_new_note().unwrap();
        slot.persist(
            JournalPhase::Committed,
            Some("Article.md".to_owned()),
            None,
            None,
            Some(new),
        )
        .unwrap();
        let slot_path = path.join(WORKSPACE_NAME).join("slot-0");
        drop(slot);
        drop(destination);

        let destination = fs::open_destination(&path).unwrap();
        let next = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(next.index(), 0);
        assert_eq!(next.journal.phase, JournalPhase::Empty);
        assert_eq!(stdfs::read(path.join("Article.md")).unwrap(), b"new");
        assert_eq!(stdfs::read(slot_path.join(NEW_NOTE)).unwrap(), b"");
        assert_eq!(stdfs::read(slot_path.join(OLD_BACKUP)).unwrap(), b"");
        drop(next);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn unknown_new_note_substitute_is_never_adopted_or_truncated() {
        for committed in [false, true] {
            let path = temp();
            let destination = fs::open_destination(&path).unwrap();
            let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
            slot.begin().unwrap();
            let new = slot.write_new_note(b"new note").unwrap();
            slot.persist(
                JournalPhase::ExchangePending,
                Some("Created.md".to_owned()),
                None,
                None,
                Some(new.clone()),
            )
            .unwrap();
            fs::rename_no_replace_between(&slot.directory, NEW_NOTE, &destination, "Created.md")
                .unwrap();
            let fixed = path.join(WORKSPACE_NAME).join("slot-0").join(NEW_NOTE);
            if committed {
                slot.recreate_new_note().unwrap();
                slot.persist(
                    JournalPhase::Committed,
                    Some("Created.md".to_owned()),
                    None,
                    None,
                    Some(new),
                )
                .unwrap();
                stdfs::rename(&fixed, fixed.with_extension("arthur-owned")).unwrap();
            }
            stdfs::write(&fixed, b"unrelated substitute").unwrap();
            drop(slot);
            drop(destination);

            let destination = fs::open_destination(&path).unwrap();
            let next = Workspace::open(&destination).unwrap().claim().unwrap();
            assert_eq!(next.index(), 1);
            assert_eq!(stdfs::read(&fixed).unwrap(), b"unrelated substitute");
            assert_eq!(stdfs::read(path.join("Created.md")).unwrap(), b"new note");
            drop(next);
            drop(destination);
            stdfs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn checksum_valid_noncanonical_fingerprint_quarantines_only_its_slot() {
        let path = temp();
        let destination = fs::open_destination(&path).unwrap();
        let mut slot = Workspace::open(&destination).unwrap().claim().unwrap();
        slot.begin().unwrap();
        let mut invalid = slot.journal.clone();
        invalid.phase = JournalPhase::ExchangePending;
        invalid.target = Some("Target.md".to_owned());
        invalid.new = Some(fs::FileFingerprint {
            device: 1,
            inode: 2,
            links: 1,
            size: 0,
            sha256: "A".repeat(64),
        });
        drop(slot);
        drop(destination);
        stdfs::write(
            path.join(WORKSPACE_NAME).join("slot-0").join(JOURNAL_A),
            encode_journal(invalid).unwrap(),
        )
        .unwrap();

        let destination = fs::open_destination(&path).unwrap();
        let next = Workspace::open(&destination).unwrap().claim().unwrap();
        assert_eq!(next.index(), 1);
        drop(next);
        drop(destination);
        stdfs::remove_dir_all(path).unwrap();
    }
}
