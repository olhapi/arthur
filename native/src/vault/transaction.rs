use super::{
    Vault, VaultError, frontmatter, fs,
    names::{
        self, content_addressed_name, media_stem_and_extension, normalize_source, sanitize_stem,
    },
};
use crate::protocol::MediaKind;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::Write, os::fd::OwnedFd, path::PathBuf};

const STAGE_PREFIX: &str = ".arthur-stage-";
const MAX_CHUNK_BYTES: usize = 256 * 1024;
const IMAGE_LIMIT: u64 = 100 * 1024 * 1024;
const AUDIO_VIDEO_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const TOTAL_MEDIA_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const FALLBACK_CODE: &str = "media_fallback";
const FALLBACK_MESSAGE: &str = "Media transfer was incomplete; original link was retained.";

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
    temp_name: String,
    attachment_name: String,
    digest: String,
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
}

fn utf16_length(value: &str) -> usize {
    value.encode_utf16().count()
}

fn valid_uuid(value: &str) -> bool {
    let value = value.as_bytes();
    if value.len() != 36
        || !value
            .iter()
            .copied()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            })
    {
        return false;
    }
    let lower = String::from_utf8_lossy(value).to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "00000000-0000-0000-0000-000000000000" | "ffffffff-ffff-ffff-ffff-ffffffffffff"
    ) {
        return true;
    }
    matches!(value[14].to_ascii_lowercase(), b'1'..=b'8')
        && matches!(value[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

fn stage_name(session_id: &str) -> Result<String, VaultError> {
    if !valid_uuid(session_id) {
        return Err(VaultError::InvalidTransition);
    }
    Ok(format!("{STAGE_PREFIX}{session_id}"))
}

fn is_stage_name(value: &str) -> bool {
    value.strip_prefix(STAGE_PREFIX).is_some_and(valid_uuid)
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
    if utf16_length(&spec.markdown) > 20 * 1024 * 1024 {
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

pub(super) fn remove_stale_stages(destination: &OwnedFd) -> Result<(), VaultError> {
    for name in fs::direct_children(destination)? {
        if is_stage_name(&name) || is_reaper_name(&name) {
            fs::remove_stale_child_no_follow(destination, &name)?;
        }
    }
    Ok(())
}

impl VaultTransaction {
    pub(super) fn new(vault: Vault, spec: SaveSpec) -> Result<Self, VaultError> {
        let save = normalize_save_spec(spec)?;
        let stage_name = stage_name(&save.session_id)?;
        let stage = fs::create_private_child_directory(&vault.destination, &stage_name)?;
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
        spec.media_id = trim_required(spec.media_id, 128)?;
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
        self.total_bytes = next_total_bytes;
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
        self.declared_total = self
            .declared_total
            .checked_sub(media.reserved_bytes)
            .expect("active media reservation is tracked");
        fs::sync_file(&media.file)?;
        drop(media.file);
        let digest = hex_digest(media.hasher.finalize());
        let attachment_name = content_addressed_name(&media.stem, &digest, &media.extension)?;
        self.media.insert(
            media_id.to_owned(),
            MediaState::Finished(FinishedMedia {
                temp_name: media.temp_name,
                attachment_name,
                digest,
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
            let id_length = tail
                .bytes()
                .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                .count();
            if id_length == 0 {
                return Err(VaultError::UnresolvedPlaceholder);
            }
            let media_id = &tail[..id_length];
            let state = self
                .media
                .get(media_id)
                .ok_or(VaultError::UnresolvedPlaceholder)?;
            match state {
                MediaState::Finished(media) => {
                    rendered.push_str("![[attachments/");
                    rendered.push_str(&media.attachment_name);
                    rendered.push_str("]]");
                }
                MediaState::Fallback { source, .. } => {
                    rendered.push('<');
                    rendered.push_str(source);
                    rendered.push('>');
                }
                MediaState::Active(_) => return Err(VaultError::InvalidTransition),
            }
            remaining = &tail[id_length..];
        }
        rendered.push_str(remaining);
        Ok(rendered)
    }

    fn has_open_media(&self) -> bool {
        self.media
            .values()
            .any(|state| matches!(state, MediaState::Active(_)))
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
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            return Err(VaultError::UnsafeChild);
        }
        if fs::child_exists(&self.attachments, &attachment_name)? {
            if fs::hash_regular_file(&self.attachments, &attachment_name)? != digest {
                return Err(VaultError::AttachmentConflict);
            }
            fs::remove_child(&self.stage, &temp_name)?;
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
            Ok(()) => Ok(()),
            Err(VaultError::AttachmentConflict) => {
                if fs::hash_regular_file(&self.attachments, &attachment_name)? != digest {
                    return Err(VaultError::AttachmentConflict);
                }
                fs::remove_child(&self.stage, &temp_name)
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

    fn note_target(&self) -> Result<(String, bool), VaultError> {
        if let Some(existing) =
            frontmatter::find_existing_article(&self.destination, &self.save.source)?
        {
            return Ok((existing, true));
        }
        let stem = sanitize_stem(&self.save.title);
        let direct = format!("{stem}.md");
        if !fs::child_exists(&self.destination, &direct)? {
            return Ok((direct, false));
        }
        let source_hash = names::digest(self.save.source.as_bytes());
        Ok((format!("{stem}--{}.md", &source_hash[..12]), false))
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
        let (target, replacing) = self.note_target()?;
        let temporary_note = self.write_note_temp(serialized.as_bytes())?;
        if self.fault_before_note_rename() {
            return Err(VaultError::Io);
        }
        if !fs::child_directory_matches(&self.destination, "attachments", &self.attachments)? {
            return Err(VaultError::UnsafeChild);
        }
        if replacing {
            if !frontmatter::verifies_existing_article_source(
                &self.destination,
                &target,
                &self.save.source,
            )? {
                return Err(VaultError::UnsafeChild);
            }
            fs::rename_replace_between(&self.stage, &temporary_note, &self.destination, &target)?;
        } else {
            fs::rename_no_replace_between(
                &self.stage,
                &temporary_note,
                &self.destination,
                &target,
            )?;
        }
        fs::sync_owned_directory(&self.destination)?;
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
            self.media.clear();
            if self.fault_stage_cleanup_after_note() {
                return Err(VaultError::Io);
            }
            for child in fs::direct_children(&self.stage)? {
                fs::remove_tree_no_follow(&self.stage, &child)?;
            }
            self.inject_stage_swap_before_detach()?;
            let _ = fs::remove_owned_empty_child_directory(
                &self.destination,
                &self.stage_name,
                &self.stage,
            )?;
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
                media_id: "m1".to_owned(),
                source: "https://cdn.example.test/hero.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: Some(4),
            })
            .unwrap();
        transaction.append_chunk("m1", 0, b"test").unwrap();
        transaction.finish_media("m1", 1).unwrap();
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
            .begin(save("arthur-media://m1"))
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
            .begin(save("arthur-media://m1"))
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
    fn declared_media_reserves_the_total_budget_after_completed_bytes() {
        let destination = temp();
        let mut transaction = Vault::open(&destination)
            .unwrap()
            .begin(save("body"))
            .unwrap();
        transaction.total_bytes = TOTAL_MEDIA_LIMIT - 1;

        assert_eq!(
            transaction.begin_media(MediaSpec {
                media_id: "next".to_owned(),
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
            .begin(save("arthur-media://m1"))
            .unwrap();
        transaction
            .begin_media(MediaSpec {
                media_id: "m1".to_owned(),
                source: "https://cdn.example.test/hero.webp".to_owned(),
                kind: MediaKind::Image,
                content_type: "image/webp".to_owned(),
                declared_bytes: Some(4),
            })
            .unwrap();
        transaction.fail_next_chunk_after(2);

        assert_eq!(
            transaction.append_chunk("m1", 0, b"test"),
            Err(VaultError::Io)
        );
        assert_eq!(
            transaction.finish_media("m1", 1),
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
        assert_eq!(fs::read_dir(displaced_stage).unwrap().count(), 0);

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
