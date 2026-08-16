use super::{
    Vault, VaultError, frontmatter, fs,
    names::{
        self, content_addressed_name, media_stem_and_extension, normalize_source, sanitize_stem,
    },
    workspace::{self, JournalPhase},
};
use crate::protocol::MediaKind;
use crate::validation::zod_uuid;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::Write, os::fd::OwnedFd, path::PathBuf};

const MAX_CHUNK_BYTES: usize = 256 * 1024;
const IMAGE_LIMIT: u64 = 100 * 1024 * 1024;
const AUDIO_VIDEO_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const TOTAL_MEDIA_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const FALLBACK_CODE: &str = "media_fallback";
const FALLBACK_MESSAGE: &str = "Media transfer was incomplete; original link was retained.";

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

fn same_content(left: &fs::FileFingerprint, right: &fs::FileFingerprint) -> bool {
    left.size == right.size && left.sha256 == right.sha256
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
    workspace_index: usize,
    hasher: Sha256,
    bytes: u64,
    next_sequence: u64,
    stem: String,
    extension: String,
}

struct FinishedMedia {
    workspace_index: usize,
    in_workspace: bool,
    attachment_name: String,
    digest: String,
    retained: Option<VerifiedAttachment>,
}

struct VerifiedAttachment {
    file: File,
    fingerprint: fs::FileFingerprint,
}

enum MediaState {
    Active(ActiveMedia),
    Finished(FinishedMedia),
    Fallback {
        source: String,
        awaiting_end: bool,
        workspace_index: usize,
    },
}

pub struct VaultTransaction {
    destination: OwnedFd,
    attachments: OwnedFd,
    canonical_destination: PathBuf,
    slot: workspace::Slot,
    save: SaveSpec,
    media: HashMap<String, MediaState>,
    next_media: usize,
    total_bytes: u64,
    declared_total: u64,
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

fn trim_required(value: String, maximum: usize) -> Result<String, VaultError> {
    let value = value.trim().to_owned();
    if value.is_empty() || utf16_length(&value) > maximum {
        return Err(VaultError::InvalidName);
    }
    Ok(value)
}

fn normalize_save_spec(mut spec: SaveSpec) -> Result<SaveSpec, VaultError> {
    if !zod_uuid(&spec.session_id) {
        return Err(VaultError::InvalidTransition);
    }
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

impl VaultTransaction {
    pub(super) fn new(vault: Vault, spec: SaveSpec) -> Result<Self, VaultError> {
        let save = normalize_save_spec(spec)?;
        let mut slot = vault.workspace.claim()?;
        slot.begin()?;
        Ok(Self {
            destination: vault.destination,
            attachments: vault.attachments,
            canonical_destination: vault.canonical_destination,
            slot,
            save,
            media: HashMap::new(),
            next_media: 0,
            total_bytes: 0,
            declared_total: 0,
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

    pub fn begin_media(&mut self, mut spec: MediaSpec) -> Result<(), VaultError> {
        if !zod_uuid(&spec.media_id) {
            return Err(VaultError::InvalidName);
        }
        if self.media.contains_key(&spec.media_id) {
            return Err(VaultError::InvalidTransition);
        }
        if self.next_media >= workspace::MAX_MEDIA_PER_SAVE {
            return Err(VaultError::MediaLimitExceeded);
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
        let workspace_index = self.next_media;
        self.slot.ensure_media(workspace_index)?;
        self.next_media += 1;
        self.declared_total = next_declared_total;
        self.media.insert(
            spec.media_id,
            MediaState::Active(ActiveMedia {
                source: spec.source,
                declared_bytes: spec.declared_bytes,
                reserved_bytes: spec.declared_bytes.unwrap_or_default(),
                maximum_bytes,
                workspace_index,
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
                    match self
                        .slot
                        .media_file_mut(media.workspace_index)?
                        .write_all(&bytes[..partial.min(bytes.len())])
                    {
                        Ok(()) => Err(std::io::Error::other("injected partial write failure")),
                        Err(error) => Err(error),
                    }
                } else {
                    self.slot
                        .media_file_mut(media.workspace_index)?
                        .write_all(bytes)
                }
            }
            #[cfg(not(test))]
            {
                self.slot
                    .media_file_mut(media.workspace_index)?
                    .write_all(bytes)
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
                workspace_index,
            } => {
                self.media.insert(
                    media_id.to_owned(),
                    MediaState::Fallback {
                        source,
                        awaiting_end: false,
                        workspace_index,
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
            fs::sync_file(self.slot.media_file(media.workspace_index)?)
        };
        #[cfg(not(test))]
        let sync_result = fs::sync_file(self.slot.media_file(media.workspace_index)?);
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
                workspace_index: media.workspace_index,
                in_workspace: true,
                attachment_name,
                digest,
                retained: None,
            }),
        );
        Ok(MediaDisposition::Saved)
    }

    fn fallback_media(&mut self, media_id: &str, media: ActiveMedia, awaiting_end: bool) {
        let ActiveMedia {
            source,
            reserved_bytes,
            workspace_index,
            ..
        } = media;
        self.declared_total = self.declared_total.saturating_sub(reserved_bytes);
        let _ = self
            .slot
            .media_file_mut(workspace_index)
            .and_then(|file| fs::reset_file(file, b""));
        self.media.insert(
            media_id.to_owned(),
            MediaState::Fallback {
                source,
                awaiting_end,
                workspace_index,
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
                        ..
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
        let (workspace_index, in_workspace, attachment_name, digest) =
            match self.media.get(media_id) {
                Some(MediaState::Finished(media)) => (
                    media.workspace_index,
                    media.in_workspace,
                    media.attachment_name.clone(),
                    media.digest.clone(),
                ),
                _ => return Ok(()),
            };
        if !in_workspace {
            return Ok(());
        }
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            return Err(VaultError::UnsafeChild);
        }
        let staged = fs::fingerprint_open_regular_file(self.slot.media_file_mut(workspace_index)?)?;
        if staged.sha256 != digest || !self.slot.media_path_matches(workspace_index)? {
            self.slot.quarantine();
            return Err(VaultError::AttachmentConflict);
        }
        if fs::child_exists(&self.attachments, &attachment_name)? {
            let retained = match verified_attachment(&self.attachments, &attachment_name, &digest) {
                Ok(retained) => retained,
                Err(VaultError::UnsafeChild | VaultError::Io) => {
                    self.slot.quarantine();
                    return Err(VaultError::AttachmentConflict);
                }
                Err(error) => return Err(error),
            };
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
        let fixed_name = workspace::Slot::fixed_media_name(workspace_index)?;
        match fs::rename_no_replace_between(
            &self.slot.directory,
            &fixed_name,
            &self.attachments,
            &attachment_name,
        ) {
            Ok(()) => {
                let retained = verified_attachment(&self.attachments, &attachment_name, &digest)?;
                self.slot.recreate_media(workspace_index)?;
                if let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) {
                    media.in_workspace = false;
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
        fs::sync_owned_directory(&self.attachments)?;
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            self.slot.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        Ok(())
    }

    fn revalidate_attachments(&mut self) -> Result<(), VaultError> {
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            self.slot.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        let mut media_ids: Vec<String> = self.media.keys().cloned().collect();
        media_ids.sort();
        for media_id in media_ids {
            let result = self.revalidate_one_attachment(&media_id);
            if result.is_err() {
                self.slot.quarantine();
                return result;
            }
        }
        fs::sync_owned_directory(&self.attachments)?;
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            self.slot.quarantine();
            return Err(VaultError::UnsafeChild);
        }
        Ok(())
    }

    fn revalidate_one_attachment(&mut self, media_id: &str) -> Result<(), VaultError> {
        let Some(MediaState::Finished(snapshot)) = self.media.get(media_id) else {
            return Ok(());
        };
        let workspace_index = snapshot.workspace_index;
        let in_workspace = snapshot.in_workspace;
        let attachment_name = snapshot.attachment_name.clone();
        let digest = snapshot.digest.clone();
        if in_workspace {
            let held =
                fs::fingerprint_open_regular_file(self.slot.media_file_mut(workspace_index)?)?;
            if held.sha256 != digest || !self.slot.media_path_matches(workspace_index)? {
                return Err(VaultError::AttachmentConflict);
            }
        }
        let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) else {
            unreachable!()
        };
        if let Some(retained) = media.retained.as_mut() {
            // A retained descriptor can be temporarily detached after an
            // attacker (or another writer) removes the equal final attachment
            // before we install our staged copy.  The descriptor itself is
            // still authoritative only while it remains the same regular file
            // with zero or one links; every visible path is re-opened below
            // with the stricter one-link policy.
            let current = fs::fingerprint_open_regular_file_allow_detached(&mut retained.file)
                .map_err(|_| VaultError::AttachmentConflict)?;
            if current.device != retained.fingerprint.device
                || current.inode != retained.fingerprint.inode
                || current.size != retained.fingerprint.size
                || current.sha256 != retained.fingerprint.sha256
                || retained.fingerprint.sha256 != digest
            {
                return Err(VaultError::AttachmentConflict);
            }
        }
        match verified_attachment(&self.attachments, &attachment_name, &digest) {
            Ok(retained) => {
                media.retained = Some(retained);
                Ok(())
            }
            Err(VaultError::UnsafeChild) if in_workspace => {
                if fs::child_exists(&self.attachments, &attachment_name)? {
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
                            .join(&attachment_name),
                        b"test",
                    )
                    .map_err(|_| VaultError::Io)?;
                }
                let fixed_name = workspace::Slot::fixed_media_name(workspace_index)?;
                match fs::rename_no_replace_between(
                    &self.slot.directory,
                    &fixed_name,
                    &self.attachments,
                    &attachment_name,
                ) {
                    Ok(()) => {
                        let retained =
                            verified_attachment(&self.attachments, &attachment_name, &digest)?;
                        self.slot.recreate_media(workspace_index)?;
                        let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) else {
                            unreachable!()
                        };
                        media.in_workspace = false;
                        media.retained = Some(retained);
                        Ok(())
                    }
                    Err(VaultError::AttachmentConflict) => {
                        let retained =
                            verified_attachment(&self.attachments, &attachment_name, &digest)?;
                        let Some(MediaState::Finished(media)) = self.media.get_mut(media_id) else {
                            unreachable!()
                        };
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

    fn commit_inner(&mut self) -> Result<SavedNote, VaultError> {
        if self.has_open_media() {
            return Err(VaultError::InvalidTransition);
        }
        let markdown = self.rendered_markdown()?;
        self.install_attachments()?;
        let serialized =
            frontmatter::serialize_note(&self.save.title, &self.save.source, &markdown)?;
        let (target, existing) = self.note_target()?;
        let new_fingerprint = self.slot.write_new_note(serialized.as_bytes())?;
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
            if !fs::regular_file_matches_fingerprint(
                &self.destination,
                &target,
                &existing.fingerprint,
            )? {
                return Err(VaultError::SourceConflict);
            }
            if fs::identity_open_regular_file(&existing.verified_file).is_err() {
                return Err(VaultError::SourceConflict);
            }
            let backup_fingerprint = self.slot.copy_old_note(&mut existing.verified_file)?;
            let held_old_matches = fs::fingerprint_open_regular_file(&mut existing.verified_file)?
                == existing.fingerprint;
            if !same_content(&backup_fingerprint, &existing.fingerprint) || !held_old_matches {
                return Err(VaultError::SourceConflict);
            }
            self.slot.persist(
                JournalPhase::ExchangePending,
                Some(target.clone()),
                Some(existing.fingerprint.clone()),
                Some(backup_fingerprint.clone()),
                Some(new_fingerprint.clone()),
            )?;
            if self.fault_before_source_exchange() {
                return Err(VaultError::Io);
            }
            self.inject_source_replacement_before_exchange(&target)?;
            self.inject_staged_replacement_before_exchange(workspace::NEW_NOTE)?;
            let pre_target = note_identity(
                &self.destination,
                &target,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let pre_temporary = note_identity(
                &self.slot.directory,
                workspace::NEW_NOTE,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let pre_backup = note_identity(
                &self.slot.directory,
                workspace::OLD_BACKUP,
                &backup_fingerprint,
                &new_fingerprint,
            );
            if fs::fingerprint_open_regular_file(&mut existing.verified_file)?
                != existing.fingerprint
                || fs::identity_open_regular_file(&existing.verified_file).is_err()
                || fs::fingerprint_open_regular_file(self.slot.new_note_file_mut()?)?
                    != new_fingerprint
                || !self.slot.verify_fixed_paths()?
                || pre_target != NoteIdentity::Old
                || pre_temporary != NoteIdentity::New
                || pre_backup != NoteIdentity::Old
            {
                let _ = self.slot.restore_old_visibility(
                    &self.destination,
                    &target,
                    &existing.fingerprint,
                    &backup_fingerprint,
                    &new_fingerprint,
                );
                return Err(VaultError::SourceConflict);
            }
            self.revalidate_attachments()?;
            let final_target = note_identity(
                &self.destination,
                &target,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let final_temporary = note_identity(
                &self.slot.directory,
                workspace::NEW_NOTE,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let final_backup = note_identity(
                &self.slot.directory,
                workspace::OLD_BACKUP,
                &backup_fingerprint,
                &new_fingerprint,
            );
            if fs::identity_open_regular_file(&existing.verified_file).is_err()
                || fs::fingerprint_open_regular_file(&mut existing.verified_file)?
                    != existing.fingerprint
                || fs::fingerprint_open_regular_file(self.slot.new_note_file_mut()?)?
                    != new_fingerprint
                || !self.slot.verify_fixed_paths()?
                || final_target != NoteIdentity::Old
                || final_temporary != NoteIdentity::New
                || final_backup != NoteIdentity::Old
            {
                let _ = self.slot.restore_old_visibility(
                    &self.destination,
                    &target,
                    &existing.fingerprint,
                    &backup_fingerprint,
                    &new_fingerprint,
                );
                return Err(VaultError::SourceConflict);
            }
            fs::rename_exchange_between(
                &self.slot.directory,
                workspace::NEW_NOTE,
                &self.destination,
                &target,
            )?;
            if self.fault_source_exchange_sync() {
                self.slot.quarantine();
                return Err(VaultError::Io);
            }
            if let Err(error) = fs::sync_owned_directory(&self.slot.directory)
                .and_then(|()| fs::sync_owned_directory(&self.destination))
            {
                self.slot.quarantine();
                return Err(error);
            }
            if self.fault_after_source_exchange() {
                self.slot.quarantine();
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
                &self.slot.directory,
                workspace::NEW_NOTE,
                &existing.fingerprint,
                &new_fingerprint,
            );
            let backup_identity = note_identity(
                &self.slot.directory,
                workspace::OLD_BACKUP,
                &backup_fingerprint,
                &new_fingerprint,
            );
            if !(target_identity == NoteIdentity::New
                && staged_identity == NoteIdentity::Old
                && backup_identity == NoteIdentity::Old)
            {
                let _ = self.slot.restore_old_visibility(
                    &self.destination,
                    &target,
                    &existing.fingerprint,
                    &backup_fingerprint,
                    &new_fingerprint,
                );
                return Err(VaultError::SourceConflict);
            }
            self.slot.reopen_new_note(&existing.fingerprint)?;
            self.slot.persist(
                JournalPhase::Committed,
                Some(target.clone()),
                Some(existing.fingerprint),
                Some(backup_fingerprint),
                Some(new_fingerprint),
            )?;
        } else {
            self.slot.persist(
                JournalPhase::ExchangePending,
                Some(target.clone()),
                None,
                None,
                Some(new_fingerprint.clone()),
            )?;
            self.revalidate_attachments()?;
            if !self.slot.verify_fixed_paths()? {
                self.slot.quarantine();
                return Err(VaultError::UnsafeChild);
            }
            fs::rename_no_replace_between(
                &self.slot.directory,
                workspace::NEW_NOTE,
                &self.destination,
                &target,
            )?;
            self.slot.recreate_new_note()?;
            fs::sync_owned_directory(&self.destination)?;
            self.slot.persist(
                JournalPhase::Committed,
                Some(target.clone()),
                None,
                None,
                Some(new_fingerprint),
            )?;
        }
        // `Committed` is the visibility point. Scratch reset is recoverable on
        // the next open and must never turn a durable save into a reported
        // failure.
        #[cfg(test)]
        if matches!(self.commit_fault, Some(CommitFault::DescriptorResetFailure)) {
            self.slot.fail_next_reset();
        }
        let _ = self.slot.reset_to_empty();
        Ok(SavedNote {
            display_path: self.canonical_destination.join(target),
        })
    }

    pub fn commit(mut self) -> Result<SavedNote, VaultError> {
        self.commit_inner()
    }

    pub fn abort(mut self) -> Result<(), VaultError> {
        if self.slot.journal.phase == JournalPhase::Preparing && !self.slot.is_quarantined() {
            self.slot.reset_to_empty()
        } else {
            Ok(())
        }
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
                .join(workspace::WORKSPACE_NAME)
                .join(format!("slot-{}", self.slot.index()))
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
}

impl Drop for VaultTransaction {
    fn drop(&mut self) {
        if self.slot.journal.phase == JournalPhase::Preparing && !self.slot.is_quarantined() {
            let _ = self.slot.reset_to_empty();
        }
    }
}

#[cfg(test)]
#[allow(dead_code)]
#[derive(Clone, Copy)]
enum CommitFault {
    BeforeFirstAttachmentRename,
    BeforeNoteRename,
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
    DescriptorResetFailure,
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
        path::{Path, PathBuf},
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
        let stage = destination.join(workspace::WORKSPACE_NAME).join("slot-0");
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
        assert_eq!(fs::read(stage.join("media-0")).unwrap(), b"test");
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
            let stage = destination.join(workspace::WORKSPACE_NAME).join("slot-0");
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
            assert_eq!(fs::read(stage.join("media-0")).unwrap(), b"test");
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
    fn media_4097_is_rejected_before_creating_a_fixed_child() {
        let destination = temp();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("body"))
            .unwrap();
        transaction.next_media = workspace::MAX_MEDIA_PER_SAVE;
        let slot = destination.join(workspace::WORKSPACE_NAME).join("slot-0");
        let before = fs::read_dir(&slot).unwrap().count();
        assert_eq!(
            transaction.begin_media(MediaSpec {
                media_id: MEDIA_ID.to_owned(),
                source: "https://cdn.example.test/limit.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: None,
            }),
            Err(VaultError::MediaLimitExceeded)
        );
        assert_eq!(fs::read_dir(slot).unwrap().count(), before);
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

    fn write_old_article(destination: &Path) -> Vec<u8> {
        let bytes =
            b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold"
                .to_vec();
        fs::write(destination.join("Article.md"), &bytes).unwrap();
        bytes
    }

    #[test]
    fn exchange_pending_before_swap_recovers_old_and_reuses_the_slot() {
        let destination = temp();
        let old = write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_fault(CommitFault::BeforeSourceExchange),
            Err(VaultError::Io)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), old);
        let reopened = Vault::open(&destination).unwrap();
        let next = reopened.begin(save("after recovery")).unwrap();
        next.abort().unwrap();
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn hard_linked_workspace_owner_blocks_exchange_pending_recovery_without_mutating_target_or_backup()
     {
        let destination = temp();
        write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new body"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_fault(CommitFault::BeforeSourceExchange),
            Err(VaultError::Io)
        );

        let workspace = destination.join(workspace::WORKSPACE_NAME);
        let target = destination.join("Article.md");
        let displaced = destination.join("displaced-article");
        let backup = workspace.join("slot-0").join(workspace::OLD_BACKUP);
        fs::rename(&target, &displaced).unwrap();
        fs::write(&target, b"unrelated target").unwrap();
        let target_before = fs::read(&target).unwrap();
        let backup_before = fs::read(&backup).unwrap();
        fs::hard_link(
            workspace.join("owner"),
            destination.join("workspace-owner-alias"),
        )
        .unwrap();

        assert_eq!(
            Vault::open(&destination).err(),
            Some(VaultError::UnsafeChild)
        );
        assert_eq!(fs::read(&target).unwrap(), target_before);
        assert_eq!(fs::read(&backup).unwrap(), backup_before);

        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn late_fixed_child_mismatch_blocks_exchange_pending_recovery_without_mutating_target_or_backup()
     {
        let destination = temp();
        write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new body"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_fault(CommitFault::BeforeSourceExchange),
            Err(VaultError::Io)
        );

        let workspace = destination.join(workspace::WORKSPACE_NAME);
        let target = destination.join("Article.md");
        let displaced = destination.join("displaced-article");
        let backup = workspace.join("slot-0").join(workspace::OLD_BACKUP);
        let new_note = workspace.join("slot-0").join(workspace::NEW_NOTE);
        let displaced_new_note = destination.join("displaced-new-note");
        fs::rename(&target, &displaced).unwrap();
        fs::write(&target, b"unrelated target").unwrap();
        fs::rename(&new_note, &displaced_new_note).unwrap();
        fs::write(&new_note, b"unrelated fixed child").unwrap();
        let target_before = fs::read(&target).unwrap();
        let backup_before = fs::read(&backup).unwrap();

        assert_eq!(
            Vault::open(&destination).err(),
            Some(VaultError::UnsafeChild)
        );
        assert_eq!(fs::read(&target).unwrap(), target_before);
        assert_eq!(fs::read(&backup).unwrap(), backup_before);
        assert_eq!(fs::read(&new_note).unwrap(), b"unrelated fixed child");

        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn invalid_later_slot_blocks_exchange_pending_recovery_without_mutating_target_or_backup() {
        let destination = temp();
        write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new body"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_fault(CommitFault::BeforeSourceExchange),
            Err(VaultError::Io)
        );

        let workspace = destination.join(workspace::WORKSPACE_NAME);
        let target = destination.join("Article.md");
        let displaced = destination.join("displaced-article");
        let backup = workspace.join("slot-0").join(workspace::OLD_BACKUP);
        fs::rename(&target, &displaced).unwrap();
        fs::write(&target, b"unrelated target").unwrap();
        let target_before = fs::read(&target).unwrap();
        let backup_before = fs::read(&backup).unwrap();
        fs::write(workspace.join("slot-1/owner"), b"unrelated fixed child").unwrap();

        assert_eq!(
            Vault::open(&destination).err(),
            Some(VaultError::UnsafeChild)
        );
        assert_eq!(fs::read(&target).unwrap(), target_before);
        assert_eq!(fs::read(&backup).unwrap(), backup_before);

        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn exchange_pending_after_swap_recovers_the_durable_new_note() {
        let destination = temp();
        write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new body"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_fault(CommitFault::AfterSourceExchange),
            Err(VaultError::Io)
        );
        drop(Vault::open(&destination).unwrap());
        assert!(
            fs::read_to_string(destination.join("Article.md"))
                .unwrap()
                .contains("new body")
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn source_exchange_directory_sync_failure_recovers_new_visibility_and_reuses_the_slot() {
        let destination = temp();
        write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new body"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_fault(CommitFault::SourceExchangeSyncFailure),
            Err(VaultError::Io)
        );
        assert!(
            fs::read_to_string(destination.join("Article.md"))
                .unwrap()
                .contains("new body")
        );

        drop(Vault::open(&destination).unwrap());
        assert!(
            fs::read_to_string(destination.join("Article.md"))
                .unwrap()
                .contains("new body")
        );
        let slot = destination.join(workspace::WORKSPACE_NAME).join("slot-0");
        assert_eq!(fs::read(slot.join(workspace::NEW_NOTE)).unwrap(), b"");
        assert_eq!(fs::read(slot.join(workspace::OLD_BACKUP)).unwrap(), b"");
        Vault::open(&destination)
            .unwrap()
            .begin(save("later"))
            .unwrap()
            .abort()
            .unwrap();
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn committed_note_survives_descriptor_reset_failure_and_later_recovery() {
        let destination = temp();
        let old = write_old_article(&destination);
        let saved = Vault::open(&destination)
            .unwrap()
            .begin(save("new body"))
            .unwrap()
            .commit_with_fault(CommitFault::DescriptorResetFailure)
            .unwrap();
        assert!(
            fs::read_to_string(&saved.display_path)
                .unwrap()
                .contains("new body")
        );
        let slot = destination.join(workspace::WORKSPACE_NAME).join("slot-0");
        assert_eq!(fs::read(slot.join(workspace::NEW_NOTE)).unwrap(), old);
        assert_eq!(fs::read(slot.join(workspace::OLD_BACKUP)).unwrap(), old);

        drop(Vault::open(&destination).unwrap());
        assert!(
            fs::read_to_string(saved.display_path)
                .unwrap()
                .contains("new body")
        );
        assert_eq!(fs::read(slot.join(workspace::NEW_NOTE)).unwrap(), b"");
        assert_eq!(fs::read(slot.join(workspace::OLD_BACKUP)).unwrap(), b"");
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn source_substitution_restores_old_visibility_and_preserves_the_substitute() {
        let destination = temp();
        let old = write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_fault(CommitFault::ReplaceSourceBeforeExchange),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), old);
        assert_eq!(
            fs::read(
                destination
                    .join(workspace::WORKSPACE_NAME)
                    .join("slot-0")
                    .join(workspace::OLD_BACKUP)
            )
            .unwrap(),
            b"unrelated replacement"
        );
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn source_symlink_substitution_is_preserved_without_following() {
        let destination = temp();
        let outside = destination.join("outside");
        fs::write(&outside, b"outside").unwrap();
        let old = write_old_article(&destination);
        let transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("new"))
            .unwrap();
        assert_eq!(
            transaction.commit_with_source_symlink_fault(outside.clone()),
            Err(VaultError::SourceConflict)
        );
        assert_eq!(fs::read(destination.join("Article.md")).unwrap(), old);
        assert_eq!(fs::read(&outside).unwrap(), b"outside");
        assert!(
            fs::symlink_metadata(
                destination
                    .join(workspace::WORKSPACE_NAME)
                    .join("slot-0")
                    .join(workspace::OLD_BACKUP)
            )
            .unwrap()
            .file_type()
            .is_symlink()
        );
        fs::remove_dir_all(destination).unwrap();
    }
}
