use arthur_native_host::protocol::MediaKind;
use arthur_native_host::vault::{MediaDisposition, MediaSpec, SaveSpec, Vault, VaultError};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static COUNT: AtomicU64 = AtomicU64::new(0);
const SESSION: &str = "a5a74c85-92de-4a5d-9768-4e66c4d64987";

fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "arthur-vault-transaction-{}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}

fn save_spec(source: &str, title: &str, markdown: &str) -> SaveSpec {
    SaveSpec {
        session_id: SESSION.to_owned(),
        title: title.to_owned(),
        source: source.to_owned(),
        markdown: markdown.to_owned(),
    }
}

fn media_spec(
    id: &str,
    source: &str,
    kind: MediaKind,
    content_type: &str,
    declared_bytes: Option<u64>,
) -> MediaSpec {
    MediaSpec {
        media_id: id.to_owned(),
        source: source.to_owned(),
        kind,
        content_type: content_type.to_owned(),
        declared_bytes,
    }
}

fn attachment_bytes(path: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(path.join("attachments"))
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}

#[test]
fn streams_each_supported_format_without_changing_its_bytes() {
    let destination = temp();
    let source = "https://example.test/article";
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            source,
            "Formats",
            "arthur-media://gif arthur-media://webp arthur-media://svg arthur-media://avif arthur-media://mp3 arthur-media://mp4",
        ))
        .unwrap();
    let formats = [
        (
            "gif",
            "hero.gif",
            MediaKind::Image,
            "image/gif",
            b"GIF89a\0\x01\0".as_slice(),
        ),
        (
            "webp",
            "hero.webp",
            MediaKind::Image,
            "image/webp",
            b"RIFF-webp-animation".as_slice(),
        ),
        (
            "svg",
            "hero.svg",
            MediaKind::Image,
            "image/svg+xml",
            b"<svg viewBox='0 0 1 1'/>".as_slice(),
        ),
        (
            "avif",
            "hero.avif",
            MediaKind::Image,
            "image/avif",
            b"ftypavif\0".as_slice(),
        ),
        (
            "mp3",
            "audio.mp3",
            MediaKind::Audio,
            "audio/mpeg",
            b"ID3\x04\0\0".as_slice(),
        ),
        (
            "mp4",
            "movie.mp4",
            MediaKind::Video,
            "video/mp4",
            b"\0\0\0\x18ftypmp42".as_slice(),
        ),
    ];

    for &(id, basename, ref kind, content_type, bytes) in &formats {
        transaction
            .begin_media(media_spec(
                id,
                &format!("https://cdn.example.test/{basename}"),
                kind.clone(),
                content_type,
                Some(bytes.len() as u64),
            ))
            .unwrap();
        transaction.append_chunk(id, 0, bytes).unwrap();
        assert_eq!(
            transaction.finish_media(id, 1).unwrap(),
            MediaDisposition::Saved
        );
    }

    let saved = transaction.commit().unwrap();
    let bytes = attachment_bytes(&destination);
    assert_eq!(bytes.len(), 6);
    for &(_, basename, _, _, expected) in &formats {
        assert!(bytes.iter().any(|(name, actual)| {
            name.starts_with(basename.split('.').next().unwrap()) && actual == expected
        }));
    }
    let note = fs::read_to_string(saved.display_path).unwrap();
    assert_eq!(note.matches("![[attachments/").count(), 6);
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn names_content_from_the_url_and_reuses_equal_bytes_once() {
    let destination = temp();
    let bytes = b"test";
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Article",
            "arthur-media://one arthur-media://two",
        ))
        .unwrap();
    for id in ["one", "two"] {
        transaction
            .begin_media(media_spec(
                id,
                "https://cdn.example.test/hero.webp",
                MediaKind::Image,
                "image/webp",
                Some(bytes.len() as u64),
            ))
            .unwrap();
        transaction.append_chunk(id, 0, bytes).unwrap();
        transaction.finish_media(id, 1).unwrap();
    }
    let saved = transaction.commit().unwrap();
    let attachments = attachment_bytes(&destination);
    assert_eq!(attachments.len(), 1);
    assert_eq!(
        attachments.keys().next().unwrap(),
        "hero--9f86d081884c.webp",
        "the known SHA-256 prefix of the literal test bytes determines the private name"
    );
    let note = fs::read_to_string(saved.display_path).unwrap();
    assert_eq!(note.matches("hero--9f86d081884c.webp").count(), 2);
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn rejects_an_existing_same_name_with_different_full_digest_before_a_note_is_visible() {
    let destination = temp();
    fs::create_dir(destination.join("attachments")).unwrap();
    fs::write(
        destination.join("attachments/hero--9f86d081884c.webp"),
        b"other",
    )
    .unwrap();
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Article",
            "arthur-media://one",
        ))
        .unwrap();
    transaction
        .begin_media(media_spec(
            "one",
            "https://cdn.example.test/hero.webp",
            MediaKind::Image,
            "image/webp",
            Some(4),
        ))
        .unwrap();
    transaction.append_chunk("one", 0, b"test").unwrap();
    transaction.finish_media("one", 1).unwrap();
    assert_eq!(transaction.commit(), Err(VaultError::AttachmentConflict));
    assert!(!destination.join("Article.md").exists());
    assert_eq!(
        fs::read(destination.join("attachments/hero--9f86d081884c.webp")).unwrap(),
        b"other"
    );
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn handles_known_unknown_and_empty_declared_lengths() {
    let destination = temp();
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Lengths",
            "arthur-media://known arthur-media://unknown arthur-media://empty",
        ))
        .unwrap();
    for (id, declared, bytes) in [
        ("known", Some(3), b"abc".as_slice()),
        ("unknown", None, b"longer".as_slice()),
        ("empty", None, b"".as_slice()),
    ] {
        transaction
            .begin_media(media_spec(
                id,
                &format!("https://cdn.example.test/{id}.webp"),
                MediaKind::Image,
                "image/webp",
                declared,
            ))
            .unwrap();
        if !bytes.is_empty() {
            transaction.append_chunk(id, 0, bytes).unwrap();
            transaction.finish_media(id, 1).unwrap();
        } else {
            transaction.finish_media(id, 0).unwrap();
        }
    }
    transaction.commit().unwrap();
    assert_eq!(attachment_bytes(&destination).len(), 3);
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn records_transfer_failures_as_remote_fallbacks_without_aborting_the_article() {
    let destination = temp();
    let remote = "HTTPS://cdn.example.test/video.mp4#fragment";
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Fallback",
            "before arthur-media://video after",
        ))
        .unwrap();
    transaction
        .begin_media(media_spec(
            "video",
            remote,
            MediaKind::Video,
            "video/mp4",
            None,
        ))
        .unwrap();
    transaction.append_chunk("video", 0, b"partial").unwrap();
    assert_eq!(
        transaction.finish_media("video", 2).unwrap(),
        MediaDisposition::Fallback {
            code: "media_fallback",
            message: "Media transfer was incomplete; original link was retained.",
        }
    );
    let saved = transaction.commit().unwrap();
    assert_eq!(
        fs::read_to_string(saved.display_path).unwrap(),
        "---\ntitle: \"Fallback\"\nsource: \"https://example.test/article\"\n---\n\nbefore <https://cdn.example.test/video.mp4> after"
    );
    assert!(attachment_bytes(&destination).is_empty());
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn rejects_invalid_transitions_and_limits_before_any_note_rename() {
    let destination = temp();
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "State",
            "arthur-media://one",
        ))
        .unwrap();
    assert_eq!(
        transaction.append_chunk("missing", 0, b"x"),
        Err(VaultError::InvalidChunk)
    );
    transaction
        .begin_media(media_spec(
            "one",
            "https://cdn.example.test/one.webp",
            MediaKind::Image,
            "image/webp",
            None,
        ))
        .unwrap();
    assert_eq!(
        transaction.append_chunk("one", 1, b"x"),
        Err(VaultError::InvalidChunk)
    );
    assert_eq!(transaction.commit(), Err(VaultError::InvalidTransition));
    assert!(!destination.join("State.md").exists());
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn validates_completed_lengths_closed_media_and_declared_resource_budgets() {
    let destination = temp();
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Budgets",
            "arthur-media://one",
        ))
        .unwrap();
    transaction
        .begin_media(media_spec(
            "one",
            "https://cdn.example.test/one.webp",
            MediaKind::Image,
            "image/webp",
            Some(2),
        ))
        .unwrap();
    transaction.append_chunk("one", 0, b"three").unwrap();
    assert!(matches!(
        transaction.finish_media("one", 1),
        Ok(MediaDisposition::Fallback { .. })
    ));
    assert_eq!(
        transaction.finish_media("one", 1),
        Err(VaultError::InvalidChunk)
    );
    assert_eq!(
        transaction.append_chunk("one", 1, b"x"),
        Err(VaultError::InvalidChunk)
    );
    assert_eq!(
        transaction.begin_media(media_spec(
            "too-big-image",
            "https://cdn.example.test/large.webp",
            MediaKind::Image,
            "image/webp",
            Some(100 * 1024 * 1024 + 1),
        )),
        Err(VaultError::MediaLimitExceeded)
    );
    transaction
        .begin_media(media_spec(
            "audio-one",
            "https://cdn.example.test/audio-one.mp3",
            MediaKind::Audio,
            "audio/mpeg",
            Some(2 * 1024 * 1024 * 1024),
        ))
        .unwrap();
    assert_eq!(
        transaction.begin_media(media_spec(
            "audio-two",
            "https://cdn.example.test/audio-two.mp3",
            MediaKind::Audio,
            "audio/mpeg",
            Some(2 * 1024 * 1024 * 1024),
        )),
        Err(VaultError::MediaLimitExceeded)
    );
    transaction.abort().unwrap();
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn abort_removes_all_staged_files_and_the_hidden_stage_directory() {
    let destination = temp();
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Abort",
            "arthur-media://one",
        ))
        .unwrap();
    transaction
        .begin_media(media_spec(
            "one",
            "https://cdn.example.test/one.webp",
            MediaKind::Image,
            "image/webp",
            None,
        ))
        .unwrap();
    transaction.append_chunk("one", 0, b"staged").unwrap();
    transaction.abort().unwrap();
    assert!(fs::read_dir(&destination).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".arthur-stage-")
    }));
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn destination_lock_prevents_live_stage_reclamation_and_releases_after_drop() {
    let destination = temp();
    {
        let first = Vault::open(&destination)
            .unwrap()
            .begin(save_spec("https://example.test/one", "First", "body"))
            .unwrap();
        assert_eq!(Vault::open(&destination).err(), Some(VaultError::Busy));
        assert!(fs::read_dir(&destination).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".arthur-stage-")
        }));
        drop(first);
    }
    let unlocked = Vault::open(&destination).unwrap();
    drop(unlocked);

    let stale = destination.join(".arthur-stage-a5a74c85-92de-4a5d-9768-4e66c4d64988");
    fs::create_dir(&stale).unwrap();
    fs::write(stale.join("media-0"), b"stale").unwrap();
    let reopened = Vault::open(&destination).unwrap();
    assert!(!stale.exists());
    drop(reopened);
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn startup_reclaims_interrupted_reapers_and_stale_non_directory_stage_entries() {
    let destination = temp();
    let outside = temp();
    let interrupted_reaper = destination.join(".arthur-reap-0123456789abcdef0123456789abcdef");
    let stale_file = destination.join(".arthur-stage-a5a74c85-92de-4a5d-9768-4e66c4d64989");
    let stale_link = destination.join(".arthur-stage-a5a74c85-92de-4a5d-9768-4e66c4d6498a");
    fs::create_dir(&interrupted_reaper).unwrap();
    fs::write(interrupted_reaper.join("media-0"), b"stale").unwrap();
    fs::write(&stale_file, b"stale").unwrap();
    std::os::unix::fs::symlink(&outside, &stale_link).unwrap();

    let reopened = Vault::open(&destination).unwrap();
    assert!(!interrupted_reaper.exists());
    assert!(!stale_file.exists());
    assert!(!stale_link.exists());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    drop(reopened);

    fs::remove_dir_all(destination).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn stage_cleanup_never_removes_a_replacement_directory_after_the_note_is_visible() {
    let destination = temp();
    let visible_stage = destination.join(format!(".arthur-stage-{SESSION}"));
    let displaced_stage = destination.join("displaced-stage");
    let transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Stage Swap",
            "body",
        ))
        .unwrap();

    fs::rename(&visible_stage, &displaced_stage).unwrap();
    fs::create_dir(&visible_stage).unwrap();

    let saved = transaction.commit().unwrap();
    assert!(saved.display_path.exists());
    assert!(
        visible_stage.is_dir(),
        "cleanup must not remove a directory substituted at the stage path"
    );
    assert!(
        displaced_stage.is_dir(),
        "the descriptor-owned stage may have been moved, but it must be emptied safely"
    );
    assert_eq!(fs::read_dir(&displaced_stage).unwrap().count(), 0);

    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn abort_never_removes_a_replacement_directory_at_the_stage_path() {
    let destination = temp();
    let visible_stage = destination.join(format!(".arthur-stage-{SESSION}"));
    let displaced_stage = destination.join("displaced-stage");
    let transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Stage Abort",
            "body",
        ))
        .unwrap();

    fs::rename(&visible_stage, &displaced_stage).unwrap();
    fs::create_dir(&visible_stage).unwrap();

    transaction.abort().unwrap();
    assert!(visible_stage.is_dir());
    assert!(displaced_stage.is_dir());
    assert_eq!(fs::read_dir(&displaced_stage).unwrap().count(), 0);

    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn held_attachments_descriptor_cannot_be_redirected_by_a_visible_symlink_swap() {
    let destination = temp();
    let outside = temp();
    let original = destination.join("attachments");
    let held = destination.join("held-attachments");
    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Anchored",
            "arthur-media://one",
        ))
        .unwrap();
    fs::rename(&original, &held).unwrap();
    std::os::unix::fs::symlink(&outside, &original).unwrap();
    transaction
        .begin_media(media_spec(
            "one",
            "https://cdn.example.test/one.webp",
            MediaKind::Image,
            "image/webp",
            Some(4),
        ))
        .unwrap();
    transaction.append_chunk("one", 0, b"test").unwrap();
    transaction.finish_media("one", 1).unwrap();
    assert_eq!(transaction.commit(), Err(VaultError::UnsafeChild));
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    assert!(!destination.join("Anchored.md").exists());
    fs::remove_file(&original).unwrap();
    fs::rename(&held, &original).unwrap();
    fs::remove_dir_all(destination).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn source_identity_replaces_in_place_and_title_collision_never_overwrites_another_article() {
    let destination = temp();
    let old_source = "https://example.test/old";
    fs::write(
        destination.join("Story.md"),
        "---\ntitle: \"Story\"\nsource: \"https://example.test/original\"\n---\n\nold",
    )
    .unwrap();
    fs::write(
        destination.join("Renamed.md"),
        "---\ntitle: \"Old\"\nsource: \"https://example.test/article\"\n---\n\nold source",
    )
    .unwrap();

    let saved = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "HTTPS://Example.test:443/article#fragment",
            "New Name",
            "fresh\r\nbody\r",
        ))
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(saved.display_path.file_name().unwrap(), "Renamed.md");
    assert_eq!(
        fs::read_to_string(destination.join("Renamed.md")).unwrap(),
        "---\ntitle: \"New Name\"\nsource: \"https://example.test/article\"\n---\n\nfresh\nbody\n"
    );

    let collision = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(old_source, "Story", "new story"))
        .unwrap()
        .commit()
        .unwrap();
    assert_ne!(collision.display_path.file_name().unwrap(), "Story.md");
    assert!(
        collision
            .display_path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("Story--")
    );
    assert_eq!(
        fs::read_to_string(destination.join("Story.md")).unwrap(),
        "---\ntitle: \"Story\"\nsource: \"https://example.test/original\"\n---\n\nold"
    );
    fs::remove_dir_all(destination).unwrap();
}
