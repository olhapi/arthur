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

fn media_id(label: &str) -> &'static str {
    match label {
        "gif" => "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832",
        "webp" => "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d",
        "svg" => "b57a7301-352a-4d4d-bdc0-cb7a0a020ee1",
        "avif" => "4a08295e-a330-4cdd-9ca6-508eafef3bc4",
        "mp3" => "0cd5a1b1-152a-4bf5-8ddd-72dc516e5a75",
        "mp4" => "a430221c-6d1f-4a57-af26-7c3c70bb2d9a",
        "one" => "1853f601-f0a0-4667-b949-8e0bc5f6d8d1",
        "two" => "0d1fc36f-829d-44bb-8fba-82e260881efd",
        "known" => "92d8728c-4ee0-4225-ad10-38a0d1036c8d",
        "unknown" => "117446a1-6bf1-4ae2-b88f-00c45cee92a7",
        "empty" => "729d093a-fc78-4b17-a739-f0c0d0803b71",
        "video" => "9107bfe8-607f-42d8-96a9-e19e8ac671e7",
        "too-big-image" => "dcc905c1-fc85-48a6-930b-44e2ef9ee830",
        "audio-one" => "6d8f3f92-a5af-474f-9772-4eb10d7c96e2",
        "audio-two" => "2f710c95-8f0b-4c52-9ea0-0528c247d8e4",
        _ => panic!("unknown test media label: {label}"),
    }
}

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
        media_id: media_id(id).to_owned(),
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

fn tree_metrics(path: &Path) -> (usize, u64) {
    fn visit(path: &Path, entries: &mut usize, bytes: &mut u64) {
        for entry in fs::read_dir(path).unwrap().map(Result::unwrap) {
            *entries += 1;
            let metadata = fs::symlink_metadata(entry.path()).unwrap();
            if metadata.is_dir() {
                visit(&entry.path(), entries, bytes);
            } else if metadata.is_file() {
                *bytes += metadata.len();
            }
        }
    }
    let mut entries = 0;
    let mut bytes = 0;
    visit(path, &mut entries, &mut bytes);
    (entries, bytes)
}

#[test]
fn repeated_overwrites_reuse_one_bounded_four_slot_workspace() {
    let destination = temp();
    let source = "https://example.test/article";
    for body in ["first", "second", "third"] {
        Vault::open(&destination)
            .unwrap()
            .begin(save_spec(source, "Article", body))
            .unwrap()
            .commit()
            .unwrap();
    }

    let workspace = destination.join(".arthur-workspace-v1");
    assert!(workspace.is_dir());
    let children: Vec<_> = fs::read_dir(&workspace)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(children.len(), 5);
    for index in 0..4 {
        let slot = workspace.join(format!("slot-{index}"));
        assert!(slot.join("owner").is_file());
        assert!(slot.join("journal-a").is_file());
        assert!(slot.join("journal-b").is_file());
        assert!(slot.join("new-note").is_file());
        assert!(slot.join("old-backup").is_file());
    }
    let first_metrics = tree_metrics(&workspace);

    Vault::open(&destination)
        .unwrap()
        .begin(save_spec(source, "Article", "fourth"))
        .unwrap()
        .commit()
        .unwrap();

    assert_eq!(tree_metrics(&workspace), first_metrics);
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn four_wrong_slot_markers_quarantine_without_touching_substitutes() {
    let destination = temp();
    drop(Vault::open(&destination).unwrap());
    let workspace = destination.join(".arthur-workspace-v1");
    for index in 0..4 {
        fs::write(workspace.join(format!("slot-{index}/owner")), b"substitute").unwrap();
    }

    assert!(matches!(
        Vault::open(&destination),
        Err(VaultError::UnsafeChild)
    ));
    for index in 0..4 {
        assert_eq!(
            fs::read(workspace.join(format!("slot-{index}/owner"))).unwrap(),
            b"substitute"
        );
    }
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn one_invalid_slot_leaves_three_usable_slots_for_saves() {
    #[derive(Clone, Copy)]
    enum InvalidSlot {
        Marker,
        Journals,
        MissingFixedChild,
    }

    for invalid in [
        InvalidSlot::Marker,
        InvalidSlot::Journals,
        InvalidSlot::MissingFixedChild,
    ] {
        let destination = temp();
        drop(Vault::open(&destination).unwrap());
        let slot = destination.join(".arthur-workspace-v1/slot-0");

        match invalid {
            InvalidSlot::Marker => fs::write(slot.join("owner"), b"unrelated marker").unwrap(),
            InvalidSlot::Journals => {
                fs::write(slot.join("journal-a"), b"corrupt-a").unwrap();
                fs::write(slot.join("journal-b"), b"corrupt-b").unwrap();
            }
            InvalidSlot::MissingFixedChild => fs::remove_file(slot.join("new-note")).unwrap(),
        }

        Vault::open(&destination)
            .unwrap()
            .begin(save_spec(
                "https://example.test/usable-slots",
                "Usable Slots",
                "saved through a valid slot",
            ))
            .unwrap()
            .commit()
            .unwrap();

        assert!(destination.join("Usable Slots.md").is_file());
        match invalid {
            InvalidSlot::Marker => {
                assert_eq!(fs::read(slot.join("owner")).unwrap(), b"unrelated marker")
            }
            InvalidSlot::Journals => {
                assert_eq!(fs::read(slot.join("journal-a")).unwrap(), b"corrupt-a");
                assert_eq!(fs::read(slot.join("journal-b")).unwrap(), b"corrupt-b");
            }
            InvalidSlot::MissingFixedChild => assert!(!slot.join("new-note").exists()),
        }
        fs::remove_dir_all(destination).unwrap();
    }
}

#[test]
fn partial_workspace_and_missing_fixed_children_fail_closed_without_cleanup() {
    let partial = temp();
    let workspace = partial.join(".arthur-workspace-v1");
    fs::create_dir(&workspace).unwrap();
    fs::write(
        workspace.join("owner"),
        b"arthur-workspace-owner-v1\nslots=4\nmedia=4096\n",
    )
    .unwrap();
    fs::create_dir(workspace.join("slot-0")).unwrap();
    fs::write(workspace.join("slot-0/owner"), b"partial-slot").unwrap();
    assert_eq!(Vault::open(&partial).err(), Some(VaultError::UnsafeChild));
    assert_eq!(
        fs::read(workspace.join("slot-0/owner")).unwrap(),
        b"partial-slot"
    );
    fs::remove_dir_all(partial).unwrap();

    let missing = temp();
    drop(Vault::open(&missing).unwrap());
    for index in 0..4 {
        fs::remove_file(
            missing
                .join(".arthur-workspace-v1")
                .join(format!("slot-{index}"))
                .join("new-note"),
        )
        .unwrap();
    }
    assert_eq!(Vault::open(&missing).err(), Some(VaultError::UnsafeChild));
    for index in 0..4 {
        assert!(
            !missing
                .join(".arthur-workspace-v1")
                .join(format!("slot-{index}"))
                .join("new-note")
                .exists()
        );
    }
    fs::remove_dir_all(missing).unwrap();
}

#[test]
fn slot_directory_swap_quarantines_without_touching_the_substitute() {
    let destination = temp();
    let transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec("https://example.test/article", "Article", "body"))
        .unwrap();
    let workspace = destination.join(".arthur-workspace-v1");
    let visible = workspace.join("slot-0");
    let displaced = workspace.join("displaced-slot-0");
    fs::rename(&visible, &displaced).unwrap();
    fs::create_dir(&visible).unwrap();
    fs::write(visible.join("unrelated"), b"substitute").unwrap();

    assert_eq!(transaction.commit(), Err(VaultError::UnsafeChild));
    assert_eq!(fs::read(visible.join("unrelated")).unwrap(), b"substitute");
    assert!(displaced.join("new-note").is_file());
    assert!(!destination.join("Article.md").exists());
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn late_marker_extra_and_fixed_hardlink_changes_fail_closed() {
    use std::ffi::OsString;

    let marker = temp();
    let transaction = Vault::open(&marker)
        .unwrap()
        .begin(save_spec("https://example.test/marker", "Marker", "body"))
        .unwrap();
    let owner = marker.join(".arthur-workspace-v1/owner");
    fs::write(&owner, b"unrelated marker").unwrap();
    assert_eq!(transaction.commit(), Err(VaultError::UnsafeChild));
    assert_eq!(fs::read(&owner).unwrap(), b"unrelated marker");
    fs::remove_dir_all(marker).unwrap();

    let extra = temp();
    let transaction = Vault::open(&extra)
        .unwrap()
        .begin(save_spec("https://example.test/extra", "Extra", "body"))
        .unwrap();
    let slot = extra.join(".arthur-workspace-v1/slot-0");
    let invalid = OsString::from("bad-\u{202e}");
    fs::write(slot.join(&invalid), b"unrelated extra").unwrap();
    assert_eq!(transaction.commit(), Err(VaultError::UnsafeChild));
    assert_eq!(fs::read(slot.join(&invalid)).unwrap(), b"unrelated extra");
    fs::remove_dir_all(extra).unwrap();

    let linked = temp();
    let transaction = Vault::open(&linked)
        .unwrap()
        .begin(save_spec("https://example.test/link", "Link", "body"))
        .unwrap();
    let fixed = linked.join(".arthur-workspace-v1/slot-0/new-note");
    let alias = linked.join("fixed-alias");
    fs::hard_link(&fixed, &alias).unwrap();
    assert_eq!(transaction.commit(), Err(VaultError::UnsafeChild));
    assert_eq!(fs::metadata(&alias).unwrap().len(), 0);
    assert!(!linked.join("Link.md").exists());
    fs::remove_dir_all(linked).unwrap();

    let media = temp();
    let mut transaction = Vault::open(&media)
        .unwrap()
        .begin(save_spec(
            "https://example.test/media-link",
            "Media Link",
            &format!("arthur-media://{}", media_id("one")),
        ))
        .unwrap();
    transaction
        .begin_media(media_spec(
            "one",
            "https://cdn.example.test/media.webp",
            MediaKind::Image,
            "image/webp",
            None,
        ))
        .unwrap();
    let fixed = media.join(".arthur-workspace-v1/slot-0/media-0");
    let alias = media.join("media-alias");
    fs::hard_link(&fixed, &alias).unwrap();
    assert_eq!(
        transaction.append_chunk(media_id("one"), 0, b"must not write"),
        Err(VaultError::UnsafeChild)
    );
    assert_eq!(fs::metadata(&alias).unwrap().len(), 0);
    fs::remove_dir_all(media).unwrap();
}

#[test]
fn hard_linked_existing_article_is_rejected_before_exchange() {
    let destination = temp();
    let article = destination.join("Article.md");
    let alias = destination.join("Article alias.md");
    let old = b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
    fs::write(&article, old).unwrap();
    fs::hard_link(&article, &alias).unwrap();
    let transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec("https://example.test/article", "Article", "new"))
        .unwrap();
    assert_eq!(transaction.commit(), Err(VaultError::SourceConflict));
    assert_eq!(fs::read(&article).unwrap(), old);
    assert_eq!(fs::read(&alias).unwrap(), old);
    fs::remove_dir_all(destination).unwrap();
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
            &format!(
                "arthur-media://{} arthur-media://{} arthur-media://{} arthur-media://{} arthur-media://{} arthur-media://{}",
                media_id("gif"),
                media_id("webp"),
                media_id("svg"),
                media_id("avif"),
                media_id("mp3"),
                media_id("mp4"),
            ),
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
        transaction.append_chunk(media_id(id), 0, bytes).unwrap();
        assert_eq!(
            transaction.finish_media(media_id(id), 1).unwrap(),
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
            &format!(
                "arthur-media://{} arthur-media://{}",
                media_id("one"),
                media_id("two")
            ),
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
        transaction.append_chunk(media_id(id), 0, bytes).unwrap();
        transaction.finish_media(media_id(id), 1).unwrap();
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
            &format!("arthur-media://{}", media_id("one")),
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
    transaction
        .append_chunk(media_id("one"), 0, b"test")
        .unwrap();
    transaction.finish_media(media_id("one"), 1).unwrap();
    assert_eq!(transaction.commit(), Err(VaultError::AttachmentConflict));
    assert!(!destination.join("Article.md").exists());
    assert_eq!(
        fs::read(destination.join("attachments/hero--9f86d081884c.webp")).unwrap(),
        b"other"
    );
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn hard_linked_final_attachment_conflicts_without_changing_either_link() {
    let destination = temp();
    let attachment_name = "hero--9f86d081884c.webp";
    let attachment = destination.join("attachments").join(attachment_name);
    let alias = destination.join("attachment-alias");
    fs::create_dir(destination.join("attachments")).unwrap();
    fs::write(&attachment, b"test").unwrap();
    fs::hard_link(&attachment, &alias).unwrap();

    let mut transaction = Vault::open(&destination)
        .unwrap()
        .begin(save_spec(
            "https://example.test/article",
            "Article",
            &format!("arthur-media://{}", media_id("one")),
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
    transaction
        .append_chunk(media_id("one"), 0, b"test")
        .unwrap();
    transaction.finish_media(media_id("one"), 1).unwrap();

    assert_eq!(transaction.commit(), Err(VaultError::AttachmentConflict));
    assert_eq!(fs::read(&attachment).unwrap(), b"test");
    assert_eq!(fs::read(&alias).unwrap(), b"test");
    assert!(!destination.join("Article.md").exists());
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
            &format!(
                "arthur-media://{} arthur-media://{} arthur-media://{}",
                media_id("known"),
                media_id("unknown"),
                media_id("empty"),
            ),
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
            transaction.append_chunk(media_id(id), 0, bytes).unwrap();
            transaction.finish_media(media_id(id), 1).unwrap();
        } else {
            transaction.finish_media(media_id(id), 0).unwrap();
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
            &format!("before arthur-media://{} after", media_id("video")),
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
    transaction
        .append_chunk(media_id("video"), 0, b"partial")
        .unwrap();
    assert_eq!(
        transaction.finish_media(media_id("video"), 2).unwrap(),
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
            &format!("arthur-media://{}", media_id("one")),
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
        transaction.append_chunk(media_id("one"), 1, b"x"),
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
            &format!("arthur-media://{}", media_id("one")),
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
    transaction
        .append_chunk(media_id("one"), 0, b"three")
        .unwrap();
    assert!(matches!(
        transaction.finish_media(media_id("one"), 1),
        Ok(MediaDisposition::Fallback { .. })
    ));
    assert_eq!(
        transaction.finish_media(media_id("one"), 1),
        Err(VaultError::InvalidChunk)
    );
    assert_eq!(
        transaction.append_chunk(media_id("one"), 1, b"x"),
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
            &format!("arthur-media://{}", media_id("one")),
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
    transaction
        .append_chunk(media_id("one"), 0, b"test")
        .unwrap();
    transaction.finish_media(media_id("one"), 1).unwrap();
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
