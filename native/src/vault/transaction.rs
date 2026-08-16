use super::{
    Vault, VaultError, frontmatter, fs,
    names::{
        self, content_addressed_name, media_stem_and_extension, normalize_source, sanitize_stem,
        validate_basename,
    },
};
use crate::protocol::MediaKind;
use crate::validation::zod_uuid;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::Write, os::fd::OwnedFd, path::PathBuf};

const STAGE_PREFIX: &str = ".arthur-stage-";
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const IMAGE_LIMIT: u64 = 100 * 1024 * 1024;
const AUDIO_VIDEO_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const TOTAL_MEDIA_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const FALLBACK_CODE: &str = "media_fallback";
const FALLBACK_MESSAGE: &str = "Media transfer was incomplete; original link was retained.";
const MAX_EXCHANGE_JOURNAL_BYTES: usize = 2048;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExchangeJournal {
    target: String,
    temporary: String,
    backup: String,
    old: fs::FileFingerprint,
    new: fs::FileFingerprint,
}

enum RecoveryDisposition {
    ReadyToReap,
    FinalizedPreserve,
    Preserve,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NoteIdentity {
    Missing,
    Old,
    New,
    Unknown,
}

fn note_identity(
    root: &OwnedFd,
    name: &str,
    old: &fs::FileFingerprint,
    new: &fs::FileFingerprint,
) -> NoteIdentity {
    if fs::regular_file_matches_fingerprint(root, name, old).unwrap_or(false) {
        NoteIdentity::Old
    } else if fs::regular_file_matches_fingerprint(root, name, new).unwrap_or(false) {
        NoteIdentity::New
    } else if fs::child_exists(root, name).is_ok_and(|exists| !exists) {
        NoteIdentity::Missing
    } else {
        NoteIdentity::Unknown
    }
}

#[derive(Debug, Clone)]
pub struct SaveSpec {
    pub session_id: String,
    pub title: String,
    pub source: String,
    pub markdown: String,
}

#[derive(Debug, Clone)]
pub struct MediaSpec {
    pub media_id: String,
    pub source: String,
    pub kind: MediaKind,
    pub content_type: String,
    pub declared_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaDisposition {
    Saved,
    Fallback {
        code: &'static str,
        message: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedNote {
    pub display_path: PathBuf,
}

struct ActiveMedia {
    source: String,
    declared_bytes: Option<u64>,
    reserved_bytes: u64,
    maximum_bytes: u64,
    temp_name: String,
    file: File,
    hasher: Sha256,
    bytes: u64,
    next_sequence: u64,
    stem: String,
    extension: String,
}

struct FinishedMedia {
    temp_name: Option<String>,
    attachment_name: String,
    digest: String,
    staged_file: File,
    retained: Option<VerifiedAttachment>,
}

struct VerifiedAttachment {
    file: File,
    fingerprint: fs::FileFingerprint,
}

enum MediaState {
    Active(ActiveMedia),
    Finished(FinishedMedia),
    Fallback { source: String, awaiting_end: bool },
}

pub struct VaultTransaction {
    destination: OwnedFd,
    attachments: OwnedFd,
    canonical_destination: PathBuf,
    stage: OwnedFd,
    stage_name: String,
    save: SaveSpec,
    media: HashMap<String, MediaState>,
    next_temp: u64,
    total_bytes: u64,
    declared_total: u64,
    stage_live: bool,
    #[cfg(test)]
    commit_fault: Option<CommitFault>,
    #[cfg(test)]
    partial_write_after: Option<usize>,
    #[cfg(test)]
    fail_media_sync: bool,
    #[cfg(test)]
    source_replacement_target: Option<PathBuf>,
}

fn utf16_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn exact_placeholder_id_length(value: &str) -> Option<usize> {
    const UUID_BYTES: usize = 36;
    let id = value.get(..UUID_BYTES)?;
    if !zod_uuid(id) {
        return None;
    }
    if value
        .as_bytes()
        .get(UUID_BYTES)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return None;
    }
    Some(UUID_BYTES)
}

fn stage_name(session_id: &str) -> Result<String, VaultError> {
    if !zod_uuid(session_id) {
        return Err(VaultError::InvalidTransition);
    }
    Ok(format!("{STAGE_PREFIX}{session_id}"))
}

fn is_stage_name(value: &str) -> bool {
    value.strip_prefix(STAGE_PREFIX).is_some_and(zod_uuid)
}

fn is_reaper_name(value: &str) -> bool {
    value.strip_prefix(".arthur-reap-").is_some_and(|value| {
        value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn trim_required(value: String, maximum: usize) -> Result<String, VaultError> {
    let value = value.trim().to_owned();
    if value.is_empty() || utf16_length(&value) > maximum {
        return Err(VaultError::InvalidName);
    }
    Ok(value)
}

fn normalize_save_spec(mut spec: SaveSpec) -> Result<SaveSpec, VaultError> {
    stage_name(&spec.session_id)?;
    spec.title = trim_required(spec.title, 512)?;
    if utf16_length(&spec.markdown) > 10 * 1024 * 1024 {
        return Err(VaultError::InvalidName);
    }
    spec.source = normalize_source(&spec.source)?;
    Ok(spec)
}

fn normalize_content_type(value: String) -> Result<String, VaultError> {
    let value = value.trim().to_owned();
    if value.is_empty()
        || utf16_length(&value) > 255
        || value.matches('/').count() != 1
        || !value
            .split_once('/')
            .is_some_and(|(left, right)| !left.is_empty() && !right.is_empty())
        || value.chars().any(char::is_whitespace)
    {
        return Err(VaultError::InvalidName);
    }
    Ok(value)
}

fn maximum_media_bytes(kind: &MediaKind) -> u64 {
    match kind {
        MediaKind::Image => IMAGE_LIMIT,
        MediaKind::Audio | MediaKind::Video => AUDIO_VIDEO_LIMIT,
    }
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn verified_attachment(
    root: &OwnedFd,
    name: &str,
    digest: &str,
) -> Result<VerifiedAttachment, VaultError> {
    let mut file = fs::open_regular_file(root, name)?;
    let fingerprint = fs::fingerprint_open_regular_file(&mut file)?;
    if fingerprint.sha256 != digest
        || !fs::regular_file_matches_fingerprint(root, name, &fingerprint)?
    {
        return Err(VaultError::AttachmentConflict);
    }
    Ok(VerifiedAttachment { file, fingerprint })
}

pub(super) fn remove_stale_stages(destination: &OwnedFd) -> Result<(), VaultError> {
    for name in fs::direct_children(destination)? {
        if is_stage_name(&name) || is_reaper_name(&name) {
            reclaim_stale_stage(destination, &name);
        }
    }
    Ok(())
}

fn generated_note_name(value: &str) -> bool {
    ["note-", "old-note-"].iter().any(|prefix| {
        value.strip_prefix(prefix).is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
    })
}

fn valid_fingerprint(value: &fs::FileFingerprint) -> bool {
    value.sha256.len() == 64 && value.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_exchange_journal(value: &ExchangeJournal) -> bool {
    validate_basename(&value.target).is_ok()
        && value.target.ends_with(".md")
        && validate_basename(&value.temporary).is_ok()
        && generated_note_name(&value.temporary)
        && validate_basename(&value.backup).is_ok()
        && value.backup.starts_with("old-note-")
        && generated_note_name(&value.backup)
        && value.backup != value.temporary
        && valid_fingerprint(&value.old)
        && valid_fingerprint(&value.new)
}

fn write_exchange_journal(stage: &OwnedFd, journal: &ExchangeJournal) -> Result<(), VaultError> {
    let bytes = serde_json::to_vec(&journal).map_err(|_| VaultError::Io)?;
    if bytes.len() > MAX_EXCHANGE_JOURNAL_BYTES {
        return Err(VaultError::Io);
    }
    fs::write_private_metadata(stage, fs::EXCHANGE_JOURNAL, &bytes)
}

fn restore_old_visibility(
    destination: &OwnedFd,
    stage: &OwnedFd,
    journal: &ExchangeJournal,
    target: NoteIdentity,
    temporary: NoteIdentity,
    backup: NoteIdentity,
) -> Result<bool, VaultError> {
    if target == NoteIdentity::Old {
        return Ok(true);
    }
    let old_name = if temporary == NoteIdentity::Old {
        Some(journal.temporary.as_str())
    } else if backup == NoteIdentity::Old {
        Some(journal.backup.as_str())
    } else {
        None
    };
    let Some(old_name) = old_name else {
        return Ok(false);
    };
    match target {
        NoteIdentity::Missing => {
            fs::rename_no_replace_between(stage, old_name, destination, &journal.target)?
        }
        NoteIdentity::New | NoteIdentity::Unknown => {
            fs::rename_exchange_between(stage, old_name, destination, &journal.target)?;
            fs::sync_owned_directory(stage)?;
            fs::sync_owned_directory(destination)?;
        }
        NoteIdentity::Old => return Ok(true),
    }
    Ok(
        note_identity(destination, &journal.target, &journal.old, &journal.new)
            == NoteIdentity::Old,
    )
}

fn recover_exchange_journal(
    destination: &OwnedFd,
    reaper: &fs::ReaperedStage,
) -> RecoveryDisposition {
    let exists = match fs::child_exists(&reaper.directory, fs::EXCHANGE_JOURNAL) {
        Ok(exists) => exists,
        Err(_) => return RecoveryDisposition::Preserve,
    };
    if !exists {
        return RecoveryDisposition::ReadyToReap;
    }
    let mut journal_file = match fs::open_regular_file(&reaper.directory, fs::EXCHANGE_JOURNAL) {
        Ok(file) => file,
        Err(_) => return RecoveryDisposition::Preserve,
    };
    let bytes = match fs::read_open_file_prefix(&mut journal_file, MAX_EXCHANGE_JOURNAL_BYTES + 1) {
        Ok(bytes) if bytes.len() <= MAX_EXCHANGE_JOURNAL_BYTES => bytes,
        _ => return RecoveryDisposition::Preserve,
    };
    let journal: ExchangeJournal = match serde_json::from_slice(&bytes) {
        Ok(journal) if valid_exchange_journal(&journal) => journal,
        _ => return RecoveryDisposition::Preserve,
    };
    let children = match fs::direct_children(&reaper.directory) {
        Ok(children) => children,
        Err(_) => return RecoveryDisposition::Preserve,
    };
    if children.len() != 4
        || ![
            fs::STAGE_OWNER_MARKER,
            fs::EXCHANGE_JOURNAL,
            &journal.temporary,
            &journal.backup,
        ]
        .iter()
        .all(|expected| children.iter().any(|child| child == expected))
    {
        return RecoveryDisposition::Preserve;
    }
    let target = note_identity(destination, &journal.target, &journal.old, &journal.new);
    let staged = note_identity(
        &reaper.directory,
        &journal.temporary,
        &journal.old,
        &journal.new,
    );
    let backup = note_identity(
        &reaper.directory,
        &journal.backup,
        &journal.old,
        &journal.new,
    );

    if target == NoteIdentity::Old && staged == NoteIdentity::New && backup == NoteIdentity::Old {
        return RecoveryDisposition::FinalizedPreserve;
    }
    if target == NoteIdentity::New && staged == NoteIdentity::Old && backup == NoteIdentity::Old {
        // A visible new target is finalized before the old, rollback-copy
        // note can be destroyed. This is required even when the original
        // process failed after the exchange but before its directory sync.
        return fs::sync_owned_directory(destination)
            .map(|()| RecoveryDisposition::FinalizedPreserve)
            .unwrap_or(RecoveryDisposition::Preserve);
    }
    let _ = restore_old_visibility(
        destination,
        &reaper.directory,
        &journal,
        target,
        staged,
        backup,
    );
    RecoveryDisposition::Preserve
}

fn reclaim_stale_stage(destination: &OwnedFd, name: &str) {
    let already_reaper = is_reaper_name(name);
    let expected_session = name.strip_prefix(STAGE_PREFIX);
    let Ok(Some(reaper)) =
        fs::claim_marked_stage_reaper(destination, name, already_reaper, None, expected_session)
    else {
        return;
    };
    if !matches!(
        recover_exchange_journal(destination, &reaper),
        RecoveryDisposition::ReadyToReap
    ) || fs::remove_owned_stage_payload(&reaper.directory).is_err()
    {
        return;
    }
    let _ = fs::finish_marked_stage_reap(destination, reaper, None, expected_session);
}

impl VaultTransaction {
    pub(super) fn new(vault: Vault, spec: SaveSpec) -> Result<Self, VaultError> {
        let save = normalize_save_spec(spec)?;
        let stage_name = stage_name(&save.session_id)?;
        let stage = fs::create_private_child_directory(&vault.destination, &stage_name)?;
        if let Err(error) = fs::create_stage_ownership_marker(&stage, &save.session_id) {
            drop(stage);
            let _ = fs::remove_empty_child_directory(&vault.destination, &stage_name);
            return Err(error);
        }
        Ok(Self {
            destination: vault.destination,
            attachments: vault.attachments,
            canonical_destination: vault.canonical_destination,
            stage,
            stage_name,
            save,
            media: HashMap::new(),
            next_temp: 0,
            total_bytes: 0,
            declared_total: 0,
            stage_live: true,
            #[cfg(test)]
            commit_fault: None,
            #[cfg(test)]
            partial_write_after: None,
            #[cfg(test)]
            fail_media_sync: false,
            #[cfg(test)]
            source_replacement_target: None,
        })
    }

    fn temp_name(&mut self, prefix: &str) -> String {
        let value = format!("{prefix}-{}", self.next_temp);
        self.next_temp = self
            .next_temp
            .checked_add(1)
            .expect("temp counter overflow");
        value
    }

    pub fn begin_media(&mut self, mut spec: MediaSpec) -> Result<(), VaultError> {
        if !zod_uuid(&spec.media_id) {
            return Err(VaultError::InvalidName);
        }
        if self.media.contains_key(&spec.media_id) {
            return Err(VaultError::InvalidTransition);
        }
        spec.source = normalize_source(&spec.source)?;
        spec.content_type = normalize_content_type(spec.content_type)?;
        let maximum_bytes = maximum_media_bytes(&spec.kind);
        if spec
            .declared_bytes
            .is_some_and(|value| value > maximum_bytes)
        {
            return Err(VaultError::MediaLimitExceeded);
        }
        let next_declared_total = match spec.declared_bytes {
            Some(declared) => {
                let next_declared_total = self
                    .declared_total
                    .checked_add(declared)
                    .ok_or(VaultError::MediaLimitExceeded)?;
                let projected_total = self
                    .total_bytes
                    .checked_add(next_declared_total)
                    .ok_or(VaultError::MediaLimitExceeded)?;
                if projected_total > TOTAL_MEDIA_LIMIT {
                    return Err(VaultError::MediaLimitExceeded);
                }
                next_declared_total
            }
            None => self.declared_total,
        };
        let (stem, extension) = media_stem_and_extension(&spec.source, &spec.content_type)?;
        let temp_name = self.temp_name("media");
        let file = fs::create_exclusive_file(&self.stage, &temp_name)?;
        self.declared_total = next_declared_total;
        self.media.insert(
            spec.media_id,
            MediaState::Active(ActiveMedia {
                source: spec.source,
                declared_bytes: spec.declared_bytes,
                reserved_bytes: spec.declared_bytes.unwrap_or_default(),
                maximum_bytes,
                temp_name,
                file,
                hasher: Sha256::new(),
                bytes: 0,
                next_sequence: 0,
                stem,
                extension,
            }),
        );
        Ok(())
    }

    pub fn append_chunk(
        &mut self,
        media_id: &str,
        sequence: u64,
        bytes: &[u8],
    ) -> Result<(), VaultError> {
        if bytes.len() > MAX_CHUNK_BYTES {
            return Err(VaultError::InvalidChunk);
        }
        let state = self
            .media
            .remove(media_id)
            .ok_or(VaultError::InvalidChunk)?;
        let MediaState::Active(mut media) = state else {
            self.media.insert(media_id.to_owned(), state);
            return Err(VaultError::InvalidChunk);
        };
        if sequence != media.next_sequence {
            self.media
                .insert(media_id.to_owned(), MediaState::Active(media));
            return Err(VaultError::InvalidChunk);
        }
        let Some(next_media_bytes) = media.bytes.checked_add(bytes.len() as u64) else {
            self.media
                .insert(media_id.to_owned(), MediaState::Active(media));
            return Err(VaultError::MediaLimitExceeded);
        };
        let Some(next_total_bytes) = self.total_bytes.checked_add(bytes.len() as u64) else {
            self.media
                .insert(media_id.to_owned(), MediaState::Active(media));
            return Err(VaultError::MediaLimitExceeded);
        };
        if next_media_bytes > media.maximum_bytes || next_total_bytes > TOTAL_MEDIA_LIMIT {
            self.media
                .insert(media_id.to_owned(), MediaState::Active(media));
            return Err(VaultError::MediaLimitExceeded);
        }
        // The total is cumulative for this save, including chunks that later
        // fall back after a failed write. Otherwise a sequence of failures
        // could keep retrying until it bypassed the per-save budget.
        self.total_bytes = next_total_bytes;
        let write_result = {
            #[cfg(test)]
            {
                if let Some(partial) = self.partial_write_after.take() {
                    match media.file.write_all(&bytes[..partial.min(bytes.len())]) {
                        Ok(()) => Err(std::io::Error::other("injected partial write failure")),
                        Err(error) => Err(error),
                    }
                } else {
                    media.file.write_all(bytes)
                }
            }
            #[cfg(not(test))]
            {
                media.file.write_all(bytes)
            }
        };
        if write_result.is_err() {
            self.fallback_media(media_id, media, true);
            return Err(VaultError::Io);
        }
        media.hasher.update(bytes);
        media.bytes = next_media_bytes;
        let Some(next_sequence) = media.next_sequence.checked_add(1) else {
            self.fallback_media(media_id, media, true);
            return Err(VaultError::InvalidChunk);
        };
        media.next_sequence = next_sequence;
        let released = media.reserved_bytes.min(bytes.len() as u64);
        media.reserved_bytes -= released;
        self.declared_total = self
            .declared_total
            .checked_sub(released)
            .expect("active media reservation is tracked");
        self.media
            .insert(media_id.to_owned(), MediaState::Active(media));
        Ok(())
    }

    pub fn finish_media(
        &mut self,
        media_id: &str,
        chunks: u64,
    ) -> Result<MediaDisposition, VaultError> {
        let state = self
            .media
            .remove(media_id)
            .ok_or(VaultError::InvalidChunk)?;
        let media = match state {
            MediaState::Active(media) => media,
            MediaState::Fallback {
                source,
                awaiting_end: true,
            } => {
                self.media.insert(
                    media_id.to_owned(),
                    MediaState::Fallback {
                        source,
                        awaiting_end: false,
                    },
                );
                return Ok(MediaDisposition::Fallback {
                    code: FALLBACK_CODE,
                    message: FALLBACK_MESSAGE,
                });
            }
            state => {
                self.media.insert(media_id.to_owned(), state);
                return Err(VaultError::InvalidChunk);
            }
        };
        let should_fallback = chunks != media.next_sequence
            || media
                .declared_bytes
                .is_some_and(|declared| declared != media.bytes);
        if should_fallback {
            self.fallback_media(media_id, media, false);
            return Ok(MediaDisposition::Fallback {
                code: FALLBACK_CODE,
                message: FALLBACK_MESSAGE,
            });
        }
        #[cfg(test)]
        let sync_result = if std::mem::take(&mut self.fail_media_sync) {
            Err(VaultError::Io)
        } else {
            fs::sync_file(&media.file)
        };
        #[cfg(not(test))]
        let sync_result = fs::sync_file(&media.file);
        if sync_result.is_err() {
            self.fallback_media(media_id, media, false);
            return Ok(MediaDisposition::Fallback {
                code: FALLBACK_CODE,
                message: FALLBACK_MESSAGE,
            });
        }
        self.declared_total = self
            .declared_total
            .checked_sub(media.reserved_bytes)
            .expect("active media reservation is tracked");
        let digest = hex_digest(media.hasher.finalize());
        let attachment_name = content_addressed_name(&media.stem, &digest, &media.extension)?;
        self.media.insert(
            media_id.to_owned(),
            MediaState::Finished(FinishedMedia {
                temp_name: Some(media.temp_name),
                attachment_name,
                digest,
                staged_file: media.file,
                retained: None,
            }),
        );
        Ok(MediaDisposition::Saved)
    }

    fn fallback_media(&mut self, media_id: &str, media: ActiveMedia, awaiting_end: bool) {
        let ActiveMedia {
            source,
            reserved_bytes,
            temp_name,
            file,
            ..
        } = media;
        drop(file);
        self.declared_total = self.declared_total.saturating_sub(reserved_bytes);
        let _ = fs::remove_child(&self.stage, &temp_name);
        self.media.insert(
            media_id.to_owned(),
            MediaState::Fallback {
                source,
                awaiting_end,
            },
        );
    }

    fn rendered_markdown(&self) -> Result<String, VaultError> {
        let mut rendered = String::with_capacity(self.save.markdown.len());
        let mut remaining = self.save.markdown.as_str();
        while let Some(index) = remaining.find("arthur-media://") {
            rendered.push_str(&remaining[..index]);
            let tail = &remaining[index + "arthur-media://".len()..];
            let id_length = exact_placeholder_id_length(tail);
            let Some(id_length) = id_length else {
                rendered.push_str("arthur-media://");
                remaining = tail;
                continue;
            };
            let media_id = &tail[..id_length];
            if let Some(state) = self.media.get(media_id) {
                match state {
                    MediaState::Finished(media) => {
                        rendered.push_str("![[attachments/");
                        rendered.push_str(&media.attachment_name);
                        rendered.push_str("]]");
                    }
                    MediaState::Fallback {
                        source,
                        awaiting_end: false,
                    } => {
                        rendered.push('<');
                        rendered.push_str(source);
                        rendered.push('>');
                    }
                    MediaState::Fallback {
                        awaiting_end: true, ..
                    }
                    | MediaState::Active(_) => return Err(VaultError::InvalidTransition),
                }
            } else {
                rendered.push_str("arthur-media://");
                rendered.push_str(media_id);
            }
            remaining = &tail[id_length..];
        }
        rendered.push_str(remaining);
        Ok(rendered)
    }

    fn has_open_media(&self) -> bool {
        self.media.values().any(|state| {
            matches!(
                state,
                MediaState::Active(_)
                    | MediaState::Fallback {
                        awaiting_end: true,
                        ..
                    }
            )
        })
    }

    fn install_one_attachment(
        &mut self,
        media_id: &str,
        first_rename: &mut bool,
    ) -> Result<(), VaultError> {
        let (temp_name, attachment_name, digest) = match self.media.get(media_id) {
            Some(MediaState::Finished(media)) => (
                media.temp_name.clone(),
                media.attachment_name.clone(),
                media.digest.clone(),
            ),
            _ => return Ok(()),
        };
        let Some(temp_name) = temp_name else {
            return Ok(());
        };
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            return Err(VaultError::UnsafeChild);
        }
        if fs::child_exists(&self.attachments, &attachment_name)? {
            let retained = verified_attachment(&self.attachments, &attachment_name, &digest)?;
            if let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) {
                media.retained = Some(retained);
            }
            return Ok(());
        }
        if !*first_rename {
            if self.fault_before_first_attachment_rename() {
                return Err(VaultError::Io);
            }
            *first_rename = true;
        }
        match fs::rename_no_replace_between(
            &self.stage,
            &temp_name,
            &self.attachments,
            &attachment_name,
        ) {
            Ok(()) => {
                let retained = verified_attachment(&self.attachments, &attachment_name, &digest)?;
                if let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) {
                    media.temp_name = None;
                    media.retained = Some(retained);
                }
                Ok(())
            }
            Err(VaultError::AttachmentConflict) => {
                let retained = verified_attachment(&self.attachments, &attachment_name, &digest)?;
                if let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) {
                    media.retained = Some(retained);
                }
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn install_attachments(&mut self) -> Result<(), VaultError> {
        let mut media_ids: Vec<String> = self.media.keys().cloned().collect();
        media_ids.sort();
        let mut first_rename = false;
        for media_id in media_ids {
            self.install_one_attachment(&media_id, &mut first_rename)?;
        }
        fs::sync_owned_directory(&self.attachments)
    }

    fn preserve_attachment_conflict(&mut self) {
        let _ = fs::write_private_metadata(
            &self.stage,
            ".arthur-attachment-conflict-v1",
            b"arthur-attachment-conflict-v1\n",
        );
        self.stage_live = false;
    }

    fn revalidate_attachments(&mut self) -> Result<(), VaultError> {
        let mut media_ids: Vec<String> = self.media.keys().cloned().collect();
        media_ids.sort();
        for media_id in media_ids {
            let result = self.revalidate_one_attachment(&media_id);
            if result.is_err() {
                self.preserve_attachment_conflict();
                return result;
            }
        }
        fs::sync_owned_directory(&self.attachments)
    }

    fn revalidate_one_attachment(&mut self, media_id: &str) -> Result<(), VaultError> {
        let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) else {
            return Ok(());
        };
        let held_staged = fs::fingerprint_open_regular_file(&mut media.staged_file)?;
        if held_staged.sha256 != media.digest {
            return Err(VaultError::AttachmentConflict);
        }
        if let Some(temp_name) = media.temp_name.clone()
            && !fs::regular_file_matches_fingerprint(&self.stage, &temp_name, &held_staged)?
        {
            return Err(VaultError::AttachmentConflict);
        }
        if let Some(retained) = media.retained.as_mut()
            && (fs::fingerprint_open_regular_file(&mut retained.file)? != retained.fingerprint
                || retained.fingerprint.sha256 != media.digest)
        {
            return Err(VaultError::AttachmentConflict);
        }
        match verified_attachment(&self.attachments, &media.attachment_name, &media.digest) {
            Ok(retained) => {
                media.retained = Some(retained);
                Ok(())
            }
            Err(VaultError::UnsafeChild) if media.temp_name.is_some() => {
                let temp_name = media.temp_name.clone().expect("checked staged attachment");
                if fs::child_exists(&self.attachments, &media.attachment_name)? {
                    return Err(VaultError::AttachmentConflict);
                }
                #[cfg(test)]
                if matches!(
                    self.commit_fault,
                    Some(CommitFault::CreateEqualDuringMissingAttachmentInstall)
                ) {
                    std::fs::write(
                        self.canonical_destination
                            .join("attachments")
                            .join(&media.attachment_name),
                        b"test",
                    )
                    .map_err(|_| VaultError::Io)?;
                }
                match fs::rename_no_replace_between(
                    &self.stage,
                    &temp_name,
                    &self.attachments,
                    &media.attachment_name,
                ) {
                    Ok(()) => {
                        let retained = verified_attachment(
                            &self.attachments,
                            &media.attachment_name,
                            &media.digest,
                        )?;
                        media.temp_name = None;
                        media.retained = Some(retained);
                        Ok(())
                    }
                    Err(VaultError::AttachmentConflict) => {
                        let retained = verified_attachment(
                            &self.attachments,
                            &media.attachment_name,
                            &media.digest,
                        )?;
                        media.retained = Some(retained);
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            }
            Err(_) => Err(VaultError::AttachmentConflict),
        }
    }

    fn note_target(&self) -> Result<(String, Option<frontmatter::ExistingArticle>), VaultError> {
        if let Some(existing) =
            frontmatter::find_existing_article(&self.destination, &self.save.source)?
        {
            return Ok((existing.name.clone(), Some(existing)));
        }
        let stem = sanitize_stem(&self.save.title);
        let direct = format!("{stem}.md");
        if !fs::child_exists(&self.destination, &direct)? {
            return Ok((direct, None));
        }
        let source_hash = names::digest(self.save.source.as_bytes());
        Ok((format!("{stem}--{}.md", &source_hash[..12]), None))
    }

    fn write_note_temp(&mut self, note: &[u8]) -> Result<String, VaultError> {
        let name = self.temp_name("note");
        let mut file = fs::create_exclusive_file(&self.stage, &name)?;
        let result = file
            .write_all(note)
            .map_err(|_| VaultError::Io)
            .and_then(|()| fs::sync_file(&file));
        drop(file);
        if result.is_err() {
            let _ = fs::remove_child(&self.stage, &name);
        }
        result.map(|()| name)
    }

    fn commit_inner(&mut self) -> Result<SavedNote, VaultError> {
        if self.has_open_media() {
            return Err(VaultError::InvalidTransition);
        }
        let markdown = self.rendered_markdown()?;
        self.install_attachments()?;
        let serialized =
            frontmatter::serialize_note(&self.save.title, &self.save.source, &markdown)?;
        let (target, existing) = self.note_target()?;
        let temporary_note = self.write_note_temp(serialized.as_bytes())?;
        if self.fault_before_note_rename() {
            return Err(VaultError::Io);
        }
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            return Err(VaultError::UnsafeChild);
        }
        self.inject_attachment_replacement_before_note()?;
        if let Some(mut existing) = existing {
            if !frontmatter::verifies_existing_article_source(
                &self.destination,
                &mut existing,
                &self.save.source,
            )? {
                return Err(VaultError::SourceConflict);
            }
            let mut new_file = fs::open_regular_file(&self.stage, &temporary_note)?;
            let new_fingerprint = fs::fingerprint_open_regular_file(&mut new_file)?;
            let backup_note = self.temp_name("old-note");
            if !fs::regular_file_matches_fingerprint(
                &self.destination,
                &target,
                &existing.fingerprint,
            )? {
                return Err(VaultError::SourceConflict);
            }
            fs::hard_link_no_replace_between(
                &self.destination,
                &target,
                &self.stage,
                &backup_note,
            )?;
            let backup_matches = fs::regular_file_matches_fingerprint(
                &self.stage,
                &backup_note,
                &existing.fingerprint,
            )?;
            let held_old_matches = fs::fingerprint_open_regular_file(&mut existing.verified_file)?
                == existing.fingerprint;
            if !backup_matches || !held_old_matches {
                let _ = fs::remove_child(&self.stage, &backup_note);
                return Err(VaultError::SourceConflict);
            }
            let journal = ExchangeJournal {
                target: target.clone(),
                temporary: temporary_note.clone(),
                backup: backup_note,
                old: existing.fingerprint.clone(),
                new: new_fingerprint.clone(),
            };
            write_exchange_journal(&self.stage, &journal)?;
            if self.fault_before_source_exchange() {
                self.stage_live = false;
                return Err(VaultError::Io);
            }
            self.inject_source_replacement_before_exchange(&target)?;
            self.inject_staged_replacement_before_exchange(&temporary_note)?;
            let pre_target = note_identity(
                &self.destination,
                &target,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let pre_temporary = note_identity(
                &self.stage,
                &temporary_note,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let pre_backup = note_identity(
                &self.stage,
                &journal.backup,
                &existing.fingerprint,
                &new_fingerprint,
            );
            if fs::fingerprint_open_regular_file(&mut existing.verified_file)?
                != existing.fingerprint
                || fs::fingerprint_open_regular_file(&mut new_file)? != new_fingerprint
                || pre_target != NoteIdentity::Old
                || pre_temporary != NoteIdentity::New
                || pre_backup != NoteIdentity::Old
            {
                let _ = restore_old_visibility(
                    &self.destination,
                    &self.stage,
                    &journal,
                    pre_target,
                    pre_temporary,
                    pre_backup,
                );
                self.stage_live = false;
                return Err(VaultError::SourceConflict);
            }
            self.revalidate_attachments()?;
            fs::rename_exchange_between(&self.stage, &temporary_note, &self.destination, &target)?;
            if self.fault_source_exchange_sync() {
                self.stage_live = false;
                return Err(VaultError::Io);
            }
            if let Err(error) = fs::sync_owned_directory(&self.stage)
                .and_then(|()| fs::sync_owned_directory(&self.destination))
            {
                // The exchange has already happened. Retain its durable
                // journal and both notes for `Vault::open` recovery.
                self.stage_live = false;
                return Err(error);
            }
            if self.fault_after_source_exchange() {
                self.stage_live = false;
                return Err(VaultError::Io);
            }
            self.inject_target_replacement_after_exchange(&target)?;
            let target_identity = note_identity(
                &self.destination,
                &target,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let staged_identity = note_identity(
                &self.stage,
                &temporary_note,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let backup_identity = note_identity(
                &self.stage,
                &journal.backup,
                &existing.fingerprint,
                &new_fingerprint,
            );
            if !(target_identity == NoteIdentity::New
                && staged_identity == NoteIdentity::Old
                && backup_identity == NoteIdentity::Old)
            {
                let _ = restore_old_visibility(
                    &self.destination,
                    &self.stage,
                    &journal,
                    target_identity,
                    staged_identity,
                    backup_identity,
                );
                self.stage_live = false;
                return Err(VaultError::SourceConflict);
            }
        } else {
            self.revalidate_attachments()?;
            fs::rename_no_replace_between(
                &self.stage,
                &temporary_note,
                &self.destination,
                &target,
            )?;
        }
        self.cleanup_stage_after_note()?;
        Ok(SavedNote {
            display_path: self.canonical_destination.join(target),
        })
    }

    pub fn commit(mut self) -> Result<SavedNote, VaultError> {
        let result = self.commit_inner();
        if result.is_err() {
            let _ = self.cleanup_stage();
        }
        result
    }

    fn cleanup_stage(&mut self) -> Result<(), VaultError> {
        self.cleanup_stage_inner(false)
    }

    fn cleanup_stage_after_note(&mut self) -> Result<(), VaultError> {
        self.cleanup_stage_inner(true)
    }

    fn cleanup_stage_inner(&mut self, note_is_visible: bool) -> Result<(), VaultError> {
        if !self.stage_live {
            return Ok(());
        }
        let cleanup = (|| {
            if note_is_visible && fs::child_exists(&self.stage, fs::EXCHANGE_JOURNAL)? {
                for state in self.media.values_mut() {
                    if let MediaState::Finished(media) = state
                        && media.temp_name.is_some()
                    {
                        media.staged_file.set_len(0).map_err(|_| VaultError::Io)?;
                        fs::sync_file(&media.staged_file)?;
                    }
                }
            }
            self.media.clear();
            if self.fault_stage_cleanup_after_note() {
                return Err(VaultError::Io);
            }
            self.inject_stage_swap_before_detach()?;
            let Some(reaper) = fs::claim_marked_stage_reaper(
                &self.destination,
                &self.stage_name,
                false,
                Some(&self.stage),
                Some(&self.save.session_id),
            )?
            else {
                return Ok(());
            };
            if fs::child_exists(&reaper.directory, fs::EXCHANGE_JOURNAL)?
                && !matches!(
                    recover_exchange_journal(&self.destination, &reaper),
                    RecoveryDisposition::ReadyToReap
                )
            {
                return Err(VaultError::SourceConflict);
            }
            fs::remove_owned_stage_payload(&reaper.directory)?;
            if !fs::finish_marked_stage_reap(
                &self.destination,
                reaper,
                Some(&self.stage),
                Some(&self.save.session_id),
            )? {
                return Err(VaultError::UnsafeChild);
            }
            Ok(())
        })();
        match cleanup {
            Ok(()) => {
                self.stage_live = false;
                Ok(())
            }
            Err(_) if note_is_visible => {
                // The final note is already durable. Never turn a safe save into a
                // reported failure merely because a concurrent actor changed the
                // stage entry after we held its descriptor.
                self.stage_live = false;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    pub fn abort(mut self) -> Result<(), VaultError> {
        self.cleanup_stage()
    }

    fn fault_before_first_attachment_rename(&self) -> bool {
        #[cfg(test)]
        {
            matches!(
                self.commit_fault,
                Some(CommitFault::BeforeFirstAttachmentRename)
            )
        }
        #[cfg(not(test))]
        false
    }

    fn fault_before_note_rename(&self) -> bool {
        #[cfg(test)]
        {
            matches!(self.commit_fault, Some(CommitFault::BeforeNoteRename))
        }
        #[cfg(not(test))]
        false
    }

    fn fault_after_source_exchange(&self) -> bool {
        #[cfg(test)]
        {
            matches!(self.commit_fault, Some(CommitFault::AfterSourceExchange))
        }
        #[cfg(not(test))]
        false
    }

    fn fault_source_exchange_sync(&self) -> bool {
        #[cfg(test)]
        {
            matches!(
                self.commit_fault,
                Some(CommitFault::SourceExchangeSyncFailure)
            )
        }
        #[cfg(not(test))]
        false
    }

    fn fault_before_source_exchange(&self) -> bool {
        #[cfg(test)]
        {
            matches!(self.commit_fault, Some(CommitFault::BeforeSourceExchange))
        }
        #[cfg(not(test))]
        false
    }

    fn inject_source_replacement_before_exchange(&self, _target: &str) -> Result<(), VaultError> {
        #[cfg(test)]
        if matches!(
            self.commit_fault,
            Some(CommitFault::ReplaceSourceBeforeExchange)
        ) {
            let visible = self.canonical_destination.join(_target);
            let displaced = self
                .canonical_destination
                .join(".arthur-test-displaced-source-note");
            std::fs::rename(&visible, &displaced).map_err(|_| VaultError::Io)?;
            std::fs::write(&visible, b"unrelated replacement").map_err(|_| VaultError::Io)?;
        }
        #[cfg(test)]
        if matches!(
            self.commit_fault,
            Some(CommitFault::ReplaceSourceWithSymlinkBeforeExchange)
        ) {
            let visible = self.canonical_destination.join(_target);
            let displaced = self
                .canonical_destination
                .join(".arthur-test-displaced-source-note");
            let outside = self
                .source_replacement_target
                .as_ref()
                .ok_or(VaultError::Io)?;
            std::fs::rename(&visible, &displaced).map_err(|_| VaultError::Io)?;
            std::os::unix::fs::symlink(outside, &visible).map_err(|_| VaultError::Io)?;
        }
        #[cfg(test)]
        if matches!(
            self.commit_fault,
            Some(CommitFault::ReplaceSourceWithFifoBeforeExchange)
        ) {
            let visible = self.canonical_destination.join(_target);
            let displaced = self
                .canonical_destination
                .join(".arthur-test-displaced-source-note");
            std::fs::rename(&visible, &displaced).map_err(|_| VaultError::Io)?;
            if !std::process::Command::new("mkfifo")
                .arg(&visible)
                .status()
                .map_err(|_| VaultError::Io)?
                .success()
            {
                return Err(VaultError::Io);
            }
        }
        Ok(())
    }

    fn inject_staged_replacement_before_exchange(
        &self,
        _temporary: &str,
    ) -> Result<(), VaultError> {
        #[cfg(test)]
        if matches!(
            self.commit_fault,
            Some(CommitFault::ReplaceStagedNoteBeforeExchange)
        ) {
            let visible = self
                .canonical_destination
                .join(&self.stage_name)
                .join(_temporary);
            let displaced = self
                .canonical_destination
                .join(".arthur-test-displaced-staged-note");
            std::fs::rename(&visible, &displaced).map_err(|_| VaultError::Io)?;
            std::fs::write(&visible, b"unrelated staged replacement")
                .map_err(|_| VaultError::Io)?;
        }
        Ok(())
    }

    fn inject_target_replacement_after_exchange(&self, _target: &str) -> Result<(), VaultError> {
        #[cfg(test)]
        if matches!(
            self.commit_fault,
            Some(CommitFault::RemoveTargetAfterExchange | CommitFault::ReplaceTargetAfterExchange)
        ) {
            let visible = self.canonical_destination.join(_target);
            let displaced = self
                .canonical_destination
                .join(".arthur-test-displaced-new-note");
            std::fs::rename(&visible, &displaced).map_err(|_| VaultError::Io)?;
            if matches!(
                self.commit_fault,
                Some(CommitFault::ReplaceTargetAfterExchange)
            ) {
                std::fs::write(visible, b"unrelated replacement").map_err(|_| VaultError::Io)?;
            }
        }
        Ok(())
    }

    fn inject_attachment_replacement_before_note(&self) -> Result<(), VaultError> {
        #[cfg(test)]
        if matches!(
            self.commit_fault,
            Some(
                CommitFault::RemoveEqualAttachmentBeforeNote
                    | CommitFault::ReplaceEqualAttachmentBeforeNote
                    | CommitFault::ReplaceEqualAttachmentWithEqualBeforeNote
                    | CommitFault::ReplaceEqualAttachmentWithSymlinkBeforeNote
                    | CommitFault::ReplaceEqualAttachmentWithFifoBeforeNote
                    | CommitFault::CreateEqualDuringMissingAttachmentInstall
            )
        ) {
            let attachments = self.canonical_destination.join("attachments");
            let target = std::fs::read_dir(&attachments)
                .map_err(|_| VaultError::Io)?
                .next()
                .ok_or(VaultError::Io)?
                .map_err(|_| VaultError::Io)?
                .path();
            std::fs::remove_file(&target).map_err(|_| VaultError::Io)?;
            if matches!(
                self.commit_fault,
                Some(CommitFault::ReplaceEqualAttachmentBeforeNote)
            ) {
                std::fs::write(target, b"replacement").map_err(|_| VaultError::Io)?;
            } else if matches!(
                self.commit_fault,
                Some(CommitFault::ReplaceEqualAttachmentWithEqualBeforeNote)
            ) {
                std::fs::write(target, b"test").map_err(|_| VaultError::Io)?;
            } else if matches!(
                self.commit_fault,
                Some(CommitFault::ReplaceEqualAttachmentWithSymlinkBeforeNote)
            ) {
                let outside = self
                    .canonical_destination
                    .join(".arthur-test-outside-attachment");
                std::fs::write(&outside, b"outside").map_err(|_| VaultError::Io)?;
                std::os::unix::fs::symlink(outside, target).map_err(|_| VaultError::Io)?;
            } else if matches!(
                self.commit_fault,
                Some(CommitFault::ReplaceEqualAttachmentWithFifoBeforeNote)
            ) && !std::process::Command::new("mkfifo")
                .arg(target)
                .status()
                .map_err(|_| VaultError::Io)?
                .success()
            {
                return Err(VaultError::Io);
            }
        }
        Ok(())
    }

    fn inject_stage_swap_before_detach(&self) -> Result<(), VaultError> {
        #[cfg(test)]
        if matches!(self.commit_fault, Some(CommitFault::SwapStageBeforeDetach)) {
            let visible_stage = self.canonical_destination.join(&self.stage_name);
            let displaced_stage = self
                .canonical_destination
                .join(".arthur-test-displaced-stage");
            std::fs::rename(&visible_stage, &displaced_stage).map_err(|_| VaultError::Io)?;
            std::fs::create_dir(&visible_stage).map_err(|_| VaultError::Io)?;
        }
        Ok(())
    }

    fn fault_stage_cleanup_after_note(&self) -> bool {
        #[cfg(test)]
        {
            matches!(
                self.commit_fault,
                Some(CommitFault::StageCleanupFailureAfterNote)
            )
        }
        #[cfg(not(test))]
        false
    }
}

impl Drop for VaultTransaction {
    fn drop(&mut self) {
        let _ = self.cleanup_stage();
    }
}

#[cfg(test)]
#[derive(Clone, Copy)]
enum CommitFault {
    BeforeFirstAttachmentRename,
    BeforeNoteRename,
    SwapStageBeforeDetach,
    StageCleanupFailureAfterNote,
    BeforeSourceExchange,
    SourceExchangeSyncFailure,
    ReplaceSourceBeforeExchange,
    ReplaceSourceWithSymlinkBeforeExchange,
    ReplaceSourceWithFifoBeforeExchange,
    ReplaceStagedNoteBeforeExchange,
    RemoveTargetAfterExchange,
    ReplaceTargetAfterExchange,
    RemoveEqualAttachmentBeforeNote,
    ReplaceEqualAttachmentBeforeNote,
    ReplaceEqualAttachmentWithEqualBeforeNote,
    ReplaceEqualAttachmentWithSymlinkBeforeNote,
    ReplaceEqualAttachmentWithFifoBeforeNote,
    CreateEqualDuringMissingAttachmentInstall,
    AfterSourceExchange,
}

#[cfg(test)]
impl VaultTransaction {
    fn commit_with_fault(mut self, fault: CommitFault) -> Result<SavedNote, VaultError> {
        self.commit_fault = Some(fault);
        self.commit()
    }

    fn fail_next_chunk_after(&mut self, bytes: usize) {
        self.partial_write_after = Some(bytes);
    }

    fn fail_next_media_sync(&mut self) {
        self.fail_media_sync = true;
    }

    fn commit_with_source_symlink_fault(
        mut self,
        outside: PathBuf,
    ) -> Result<SavedNote, VaultError> {
        self.commit_fault = Some(CommitFault::ReplaceSourceWithSymlinkBeforeExchange);
        self.source_replacement_target = Some(outside);
        self.commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static COUNT: AtomicU64 = AtomicU64::new(0);
    const SESSION: &str = "a5a74c85-92de-4a5d-9768-4e66c4d64987";
    const MEDIA_ID: &str = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";
    const NEXT_MEDIA_ID: &str = "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d";
    const UNKNOWN_MEDIA_ID: &str = "b57a7301-352a-4d4d-bdc0-cb7a0a020ee1";

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "arthur-transaction-unit-{}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    fn save(markdown: &str) -> SaveSpec {
        SaveSpec {
            session_id: SESSION.to_owned(),
            title: "Article".to_owned(),
            source: "https://example.test/article".to_owned(),
            markdown: markdown.to_owned(),
        }
    }

    fn add_media(transaction: &mut VaultTransaction) {
        transaction
            .begin_media(MediaSpec {
                media_id: MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/hero.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: Some(4),
            })
            .unwrap();
        transaction.append_chunk(MEDIA_ID, 0, b"test").unwrap();
        transaction.finish_media(MEDIA_ID, 1).unwrap();
    }

    #[test]
    fn fault_before_the_first_attachment_rename_exposes_no_note_update() {
        let destination = temp();
        fs::write(
            destination.join("Article.md"),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold",
        )
        .unwrap();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        add_media(&mut transaction);
        assert_eq!(
            transaction.commit_with_fault(CommitFault::BeforeFirstAttachmentRename),
            Err(VaultError::Io)
        );
        assert_eq!(
            fs::read_to_string(destination.join("Article.md")).unwrap(),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold"
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn fault_before_note_rename_keeps_the_prior_note_byte_identical() {
        let destination = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        add_media(&mut transaction);
        assert_eq!(
            transaction.commit_with_fault(CommitFault::BeforeNoteRename),
            Err(VaultError::Io)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn equal_attachment_removed_before_note_is_installed_from_retained_stage() {
        let destination = temp();
        let expected_name =
            content_addressed_name("hero", &names::digest(b"test"), "webp").unwrap();
        fs::create_dir(destination.join("attachments")).unwrap();
        fs::write(
            destination.join("attachments").join(&expected_name),
            b"test",
        )
        .unwrap();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        add_media(&mut transaction);

        let saved = transaction
            .commit_with_fault(CommitFault::RemoveEqualAttachmentBeforeNote)
            .unwrap();
        assert_eq!(
            fs::read(destination.join("attachments").join(&expected_name)).unwrap(),
            b"test"
        );
        assert!(
            fs::read_to_string(saved.display_path)
                .unwrap()
                .contains(&expected_name)
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn equal_attachment_created_during_missing_noreplace_is_reopened_and_reused() {
        let destination = temp();
        let expected_name =
            content_addressed_name("hero", &names::digest(b"test"), "webp").unwrap();
        fs::create_dir(destination.join("attachments")).unwrap();
        fs::write(
            destination.join("attachments").join(&expected_name),
            b"test",
        )
        .unwrap();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        add_media(&mut transaction);

        let saved = transaction
            .commit_with_fault(CommitFault::CreateEqualDuringMissingAttachmentInstall)
            .unwrap();
        assert_eq!(
            fs::read(destination.join("attachments").join(&expected_name)).unwrap(),
            b"test"
        );
        assert!(saved.display_path.is_file());
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn equal_attachment_replaced_with_different_bytes_conflicts_and_preserves_both() {
        let destination = temp();
        let expected_name =
            content_addressed_name("hero", &names::digest(b"test"), "webp").unwrap();
        fs::create_dir(destination.join("attachments")).unwrap();
        fs::write(
            destination.join("attachments").join(&expected_name),
            b"test",
        )
        .unwrap();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        add_media(&mut transaction);

        assert_eq!(
            transaction.commit_with_fault(CommitFault::ReplaceEqualAttachmentBeforeNote),
            Err(VaultError::AttachmentConflict)
        );
        assert_eq!(
            fs::read(destination.join("attachments").join(&expected_name)).unwrap(),
            b"replacement"
        );
        assert!(fs::read_dir(&stage).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("media-")
        }));
        assert!(!destination.join("Article.md").exists());
        drop(Vault::open(&destination).unwrap());
        let preserved_reaper = fs::read_dir(&destination)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".arthur-reap-")
            })
            .unwrap()
            .path();
        assert!(fs::read_dir(preserved_reaper).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("media-")
        }));
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn equal_attachment_replaced_with_new_equal_inode_is_revalidated_and_saved() {
        let destination = temp();
        let expected_name =
            content_addressed_name("hero", &names::digest(b"test"), "webp").unwrap();
        fs::create_dir(destination.join("attachments")).unwrap();
        fs::write(
            destination.join("attachments").join(&expected_name),
            b"test",
        )
        .unwrap();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        add_media(&mut transaction);

        let saved = transaction
            .commit_with_fault(CommitFault::ReplaceEqualAttachmentWithEqualBeforeNote)
            .unwrap();
        assert_eq!(
            fs::read(destination.join("attachments").join(&expected_name)).unwrap(),
            b"test"
        );
        assert!(saved.display_path.is_file());
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn equal_attachment_replaced_by_symlink_or_fifo_conflicts_without_following_or_unlinking_it() {
        use std::os::unix::fs::FileTypeExt;

        for fault in [
            CommitFault::ReplaceEqualAttachmentWithSymlinkBeforeNote,
            CommitFault::ReplaceEqualAttachmentWithFifoBeforeNote,
        ] {
            let destination = temp();
            let expected_name =
                content_addressed_name("hero", &names::digest(b"test"), "webp").unwrap();
            fs::create_dir(destination.join("attachments")).unwrap();
            let target = destination.join("attachments").join(&expected_name);
            fs::write(&target, b"test").unwrap();
            let stage = destination.join(format!(".arthur-stage-{SESSION}"));
            let mut transaction = Vault::open(&destination)
                .unwrap()
                .begin(save(&format!("arthur-media://{MEDIA_ID}")))
                .unwrap();
            add_media(&mut transaction);

            assert_eq!(
                transaction.commit_with_fault(fault),
                Err(VaultError::AttachmentConflict)
            );
            let file_type = fs::symlink_metadata(&target).unwrap().file_type();
            assert!(file_type.is_symlink() || file_type.is_fifo());
            assert!(fs::read_dir(&stage).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("media-")
            }));
            if file_type.is_symlink() {
                assert_eq!(
                    fs::read(destination.join(".arthur-test-outside-attachment")).unwrap(),
                    b"outside"
                );
            }
            fs::remove_dir_all(destination).unwrap();
        }
    }

    #[test]
    fn declared_media_reserves_the_total_budget_after_completed_bytes() {
        let destination = temp();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("body"))
            .unwrap();
        transaction.total_bytes = TOTAL_MEDIA_LIMIT - 1;

        assert_eq!(
            transaction.begin_media(MediaSpec {
                media_id: NEXT_MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/next.mp3".to_owned(),
                kind: MediaKind::Audio,
                content_type: "audio/mpeg".to_owned(),
                declared_bytes: Some(2),
            }),
            Err(VaultError::MediaLimitExceeded)
        );

        drop(transaction);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn partial_write_failure_discards_staged_bytes_and_finishes_as_a_fallback() {
        let destination = temp();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        transaction
            .begin_media(MediaSpec {
                media_id: MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/hero.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: Some(4),
            })
            .unwrap();
        transaction.fail_next_chunk_after(2);

        assert_eq!(
            transaction.append_chunk(MEDIA_ID, 0, b"test"),
            Err(VaultError::Io)
        );
        assert_eq!(
            transaction.finish_media(MEDIA_ID, 1),
            Ok(MediaDisposition::Fallback {
                code: FALLBACK_CODE,
                message: FALLBACK_MESSAGE,
            })
        );
        let saved = transaction.commit().unwrap();
        assert_eq!(
            fs::read_to_string(saved.display_path).unwrap(),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\n<https://cdn.example.test/hero.webp>"
        );
        assert_eq!(
            fs::read_dir(destination.join("attachments"))
                .unwrap()
                .count(),
            0
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn finish_sync_failure_becomes_terminal_fallback_and_commits_remote_url() {
        let destination = temp();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        transaction
            .begin_media(MediaSpec {
                media_id: MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/hero.webp#fragment".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: Some(4),
            })
            .unwrap();
        transaction.append_chunk(MEDIA_ID, 0, b"test").unwrap();
        transaction.fail_next_media_sync();

        assert_eq!(
            transaction.finish_media(MEDIA_ID, 1),
            Ok(MediaDisposition::Fallback {
                code: FALLBACK_CODE,
                message: FALLBACK_MESSAGE,
            })
        );
        let saved = transaction.commit().unwrap();
        assert!(
            fs::read_to_string(saved.display_path)
                .unwrap()
                .ends_with("<https://cdn.example.test/hero.webp>")
        );
        assert_eq!(
            fs::read_dir(destination.join("attachments"))
                .unwrap()
                .count(),
            0
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn failed_write_remains_open_until_end_media_consumes_the_fallback() {
        let destination = temp();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        transaction
            .begin_media(MediaSpec {
                media_id: MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/hero.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: Some(4),
            })
            .unwrap();
        transaction.fail_next_chunk_after(2);
        assert_eq!(
            transaction.append_chunk(MEDIA_ID, 0, b"test"),
            Err(VaultError::Io)
        );
        assert_eq!(
            transaction.commit_inner(),
            Err(VaultError::InvalidTransition)
        );
        assert_eq!(
            transaction.finish_media(MEDIA_ID, 1),
            Ok(MediaDisposition::Fallback {
                code: FALLBACK_CODE,
                message: FALLBACK_MESSAGE,
            })
        );
        assert!(transaction.commit().is_ok());
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn failed_chunks_count_toward_the_cumulative_media_budget() {
        let destination = temp();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("body"))
            .unwrap();
        transaction.total_bytes = TOTAL_MEDIA_LIMIT - 4;
        transaction
            .begin_media(MediaSpec {
                media_id: MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/hero.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: None,
            })
            .unwrap();
        transaction.fail_next_chunk_after(2);
        assert_eq!(
            transaction.append_chunk(MEDIA_ID, 0, b"test"),
            Err(VaultError::Io)
        );
        assert_eq!(
            transaction.finish_media(MEDIA_ID, 1),
            Ok(MediaDisposition::Fallback {
                code: FALLBACK_CODE,
                message: FALLBACK_MESSAGE,
            })
        );
        assert_eq!(
            transaction.begin_media(MediaSpec {
                media_id: NEXT_MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/next.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: Some(1),
            }),
            Err(VaultError::MediaLimitExceeded)
        );
        transaction.abort().unwrap();
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn only_exact_registered_uuid_placeholders_are_rewritten() {
        let destination = temp();
        let markdown = format!(
            "known arthur-media://{MEDIA_ID}; repeated arthur-media://{MEDIA_ID}; unknown arthur-media://{UNKNOWN_MEDIA_ID}; short arthur-media://m1; suffix arthur-media://{MEDIA_ID}-suffix"
        );
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&markdown))
            .unwrap();
        add_media(&mut transaction);

        let saved = transaction.commit().unwrap();
        let note = fs::read_to_string(saved.display_path).unwrap();
        assert_eq!(note.matches("![[attachments/").count(), 2);
        assert!(note.contains(&format!("arthur-media://{UNKNOWN_MEDIA_ID}")));
        assert!(note.contains("arthur-media://m1"));
        assert!(note.contains(&format!("arthur-media://{MEDIA_ID}-suffix")));
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn exchange_interruption_before_the_swap_recovers_the_prior_note() {
        let destination = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::BeforeSourceExchange),
            Err(VaultError::Io)
        );
        let reopened = Vault::open(&destination).unwrap();
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert!(fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".arthur-reap-")
        }));
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn successful_overwrite_truncates_retained_duplicate_media_via_held_fd() {
        let destination = temp();
        fs::write(
            destination.join("Article.md"),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold",
        )
        .unwrap();
        let attachment_name =
            content_addressed_name("hero", &names::digest(b"test"), "webp").unwrap();
        fs::create_dir(destination.join("attachments")).unwrap();
        fs::write(
            destination.join("attachments").join(&attachment_name),
            b"test",
        )
        .unwrap();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save(&format!("arthur-media://{MEDIA_ID}")))
            .unwrap();
        add_media(&mut transaction);

        transaction.commit().unwrap();

        let reaper = fs::read_dir(&destination)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".arthur-reap-")
            })
            .unwrap()
            .path();
        let retained_media = fs::read_dir(reaper)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with("media-"))
            .unwrap();
        assert_eq!(retained_media.metadata().unwrap().len(), 0);
        assert_eq!(
            fs::read(destination.join("attachments").join(attachment_name)).unwrap(),
            b"test"
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn exchange_interruption_after_the_swap_recovers_the_new_note() {
        let destination = temp();
        fs::write(
            destination.join("Article.md"),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold",
        )
        .unwrap();
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::AfterSourceExchange),
            Err(VaultError::Io)
        );
        let reopened = Vault::open(&destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("Article.md")).unwrap(),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nnew"
        );
        assert!(fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".arthur-reap-")
        }));
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn source_exchange_sync_failure_preserves_the_journal_for_recovery() {
        let destination = temp();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        fs::write(
            destination.join("Article.md"),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold",
        )
        .unwrap();
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::SourceExchangeSyncFailure),
            Err(VaultError::Io)
        );
        assert!(stage.join(super::fs::EXCHANGE_JOURNAL).is_file());
        assert!(stage.join("note-0").is_file());
        let reopened = Vault::open(&destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("Article.md")).unwrap(),
            "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nnew"
        );
        assert!(fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".arthur-reap-")
        }));
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn staged_note_swap_before_exchange_never_replaces_the_verified_old_note() {
        let destination = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::ReplaceStagedNoteBeforeExchange),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert_eq!(
            fs::read(destination.join(".arthur-test-displaced-staged-note")).unwrap(),
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nnew"
        );
        assert!(
            destination
                .join(format!(".arthur-stage-{SESSION}"))
                .join(super::fs::EXCHANGE_JOURNAL)
                .exists()
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn post_exchange_target_removal_restores_verified_old_note_without_losing_new() {
        let destination = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::RemoveTargetAfterExchange),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert!(
            destination
                .join(".arthur-test-displaced-new-note")
                .is_file()
        );
        assert!(
            destination
                .join(format!(".arthur-stage-{SESSION}"))
                .join(super::fs::EXCHANGE_JOURNAL)
                .exists()
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn post_exchange_target_swap_restores_old_and_preserves_unknown_and_new_notes() {
        let destination = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::ReplaceTargetAfterExchange),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert_eq!(
            fs::read(destination.join(".arthur-test-displaced-new-note")).unwrap(),
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nnew"
        );
        assert!(fs::read_dir(&stage).unwrap().any(|entry| {
            let entry = entry.unwrap();
            entry.file_name().to_string_lossy().starts_with("note-")
                && fs::read(entry.path()).is_ok_and(|bytes| bytes == b"unrelated replacement")
        }));
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn source_replacement_race_returns_conflict_without_losing_any_note() {
        let destination = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::ReplaceSourceBeforeExchange),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert_eq!(
            fs::read(destination.join(".arthur-test-displaced-source-note")).unwrap(),
            original
        );
        assert!(stage.join("note-0").is_file());
        assert_eq!(
            fs::read(stage.join("old-note-1")).unwrap(),
            b"unrelated replacement"
        );
        let journal = fs::read_to_string(stage.join(super::fs::EXCHANGE_JOURNAL)).unwrap();
        assert!(!journal.contains("https://example.test/article"));
        assert!(!journal.contains("\nnew"));

        let reopened = Vault::open(&destination).unwrap();
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert_eq!(
            fs::read(destination.join(".arthur-test-displaced-source-note")).unwrap(),
            original
        );
        assert!(fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".arthur-reap-")
        }));
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn source_symlink_race_never_follows_or_overwrites_its_target() {
        let destination = temp();
        let outside_directory = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        let outside = outside_directory.join("source-target");
        fs::write(&outside, b"outside replacement").unwrap();
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_source_symlink_fault(outside.clone()),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert_eq!(fs::read(&outside).unwrap(), b"outside replacement");
        assert!(stage.join("old-note-1").is_symlink());
        assert_eq!(
            fs::read(destination.join(".arthur-test-displaced-source-note")).unwrap(),
            original
        );
        assert!(stage.join(super::fs::EXCHANGE_JOURNAL).is_file());
        assert!(stage.join("note-0").is_file());

        let reopened = Vault::open(&destination).unwrap();
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert_eq!(fs::read(&outside).unwrap(), b"outside replacement");
        assert!(fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".arthur-reap-")
        }));
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
        fs::remove_dir_all(outside_directory).unwrap();
    }

    #[test]
    fn source_fifo_race_never_blocks_or_deletes_the_replacement() {
        use std::os::unix::fs::FileTypeExt;

        let destination = temp();
        let original =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
        fs::write(destination.join("Article.md"), original).unwrap();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();

        assert_eq!(
            transaction.commit_with_fault(CommitFault::ReplaceSourceWithFifoBeforeExchange),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert!(
            fs::symlink_metadata(stage.join("old-note-1"))
                .unwrap()
                .file_type()
                .is_fifo()
        );
        assert_eq!(
            fs::read(destination.join(".arthur-test-displaced-source-note")).unwrap(),
            original
        );
        assert!(stage.join(super::fs::EXCHANGE_JOURNAL).is_file());
        assert!(stage.join("note-0").is_file());

        let reopened = Vault::open(&destination).unwrap();
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), original);
        assert!(fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".arthur-reap-")
        }));
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn malformed_exchange_journal_is_preserved_for_manual_recovery() {
        let destination = temp();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        fs::create_dir(&stage).unwrap();
        fs::write(
            stage.join(super::fs::STAGE_OWNER_MARKER),
            format!("arthur-stage-owner-v1\n{SESSION}\n"),
        )
        .unwrap();
        fs::write(stage.join("note-0"), b"staged note").unwrap();
        fs::write(stage.join(super::fs::EXCHANGE_JOURNAL), b"{").unwrap();

        let reopened = Vault::open(&destination).unwrap();
        let reaper = fs::read_dir(&destination)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".arthur-reap-")
            })
            .unwrap();
        assert_eq!(fs::read(reaper.join("note-0")).unwrap(), b"staged note");
        assert_eq!(
            fs::read(reaper.join(super::fs::EXCHANGE_JOURNAL)).unwrap(),
            b"{"
        );
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn cleanup_window_swap_does_not_remove_the_replacement_stage_directory() {
        let destination = temp();
        let visible_stage = destination.join(format!(".arthur-stage-{SESSION}"));
        let displaced_stage = destination.join(".arthur-test-displaced-stage");
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("body"))
            .unwrap();

        let saved = transaction
            .commit_with_fault(CommitFault::SwapStageBeforeDetach)
            .unwrap();
        assert!(saved.display_path.exists());
        assert!(visible_stage.is_dir());
        assert!(displaced_stage.is_dir());
        assert_eq!(fs::read_dir(displaced_stage).unwrap().count(), 1);

        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn post_note_cleanup_failure_is_deferred_without_reversing_the_save_result() {
        let destination = temp();
        let stage = destination.join(format!(".arthur-stage-{SESSION}"));
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("body"))
            .unwrap();

        let saved = transaction
            .commit_with_fault(CommitFault::StageCleanupFailureAfterNote)
            .unwrap();
        assert!(saved.display_path.exists());
        assert!(stage.is_dir());

        let reopened = Vault::open(&destination).unwrap();
        assert!(!stage.exists());
        drop(reopened);
        fs::remove_dir_all(destination).unwrap();
    }
}
