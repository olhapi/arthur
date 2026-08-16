use arthur_native_host::{
    protocol::{ClientMessage, HostMessage, MediaKind},
    session::SessionManager,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static COUNT: AtomicU64 = AtomicU64::new(0);
const SESSION: &str = "a5a74c85-92de-4a5d-9768-4e66c4d64987";
const MEDIA_ID: &str = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";
const EMPTY_MEDIA_ID: &str = "e0ddc6e9-9075-455f-9af0-2d2fd08dcc6d";

fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "arthur-server-{}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}

fn json(message: HostMessage) -> serde_json::Value {
    serde_json::to_value(message).unwrap()
}

fn begin_save(destination: &Path, markdown: &str) -> ClientMessage {
    ClientMessage::BeginSave {
        request_id: "begin".to_owned(),
        session_id: SESSION.to_owned(),
        destination: destination.to_string_lossy().into_owned(),
        source: "https://example.test/article".to_owned(),
        title: "Article".to_owned(),
        markdown: markdown.to_owned(),
    }
}

fn begin_media() -> ClientMessage {
    ClientMessage::BeginMedia {
        request_id: "media".to_owned(),
        session_id: SESSION.to_owned(),
        media_id: MEDIA_ID.to_owned(),
        source: "https://cdn.example.test/hero.webp".to_owned(),
        kind: MediaKind::Image,
        content_type: "image/webp".to_owned(),
        byte_length: 4,
    }
}

#[test]
fn handles_the_canonical_happy_path_with_a_tuple_chunk_ack() {
    let destination = temp();
    let mut manager = SessionManager::new();
    let replies = vec![
        manager.handle(ClientMessage::Hello {
            request_id: "hello".to_owned(),
            protocol_version: 1,
        }),
        manager.handle(ClientMessage::TestDestination {
            request_id: "probe".to_owned(),
            destination: destination.to_string_lossy().into_owned(),
        }),
        manager.handle(begin_save(
            &destination,
            &format!("arthur-media://{MEDIA_ID}"),
        )),
        manager.handle(begin_media()),
        manager.handle(ClientMessage::MediaChunk {
            session_id: SESSION.to_owned(),
            media_id: MEDIA_ID.to_owned(),
            sequence: 0,
            data: "dGVzdA==".to_owned(),
        }),
        manager.handle(ClientMessage::EndMedia {
            request_id: "end".to_owned(),
            session_id: SESSION.to_owned(),
            media_id: MEDIA_ID.to_owned(),
            chunks: 1,
        }),
        manager.handle(ClientMessage::CommitSave {
            request_id: "commit".to_owned(),
            session_id: SESSION.to_owned(),
        }),
    ];
    let values: Vec<_> = replies.into_iter().map(json).collect();
    assert_eq!(values[0]["type"], "hello_result");
    assert_eq!(values[1]["type"], "test_destination_result");
    assert_eq!(
        values[2],
        serde_json::json!({"type":"ack","requestId":"begin","sessionId":SESSION})
    );
    assert_eq!(
        values[3],
        serde_json::json!({"type":"ack","requestId":"media","sessionId":SESSION})
    );
    assert_eq!(
        values[4],
        serde_json::json!({"type":"ack","requestId":"chunk","sessionId":SESSION,"mediaId":MEDIA_ID,"sequence":0})
    );
    assert_eq!(
        values[5],
        serde_json::json!({"type":"ack","requestId":"end","sessionId":SESSION,"mediaId":MEDIA_ID})
    );
    assert_eq!(values[6]["type"], "save_result");
    assert_eq!(values[6]["requestId"], "commit");
    assert_eq!(values[6]["sessionId"], SESSION);
    assert!(PathBuf::from(values[6]["savedPath"].as_str().unwrap()).exists());
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn reports_version_destination_and_session_transition_errors_with_stable_codes() {
    let destination = temp();
    let mut manager = SessionManager::new();
    let version = json(manager.handle(ClientMessage::Hello {
        request_id: "hello".to_owned(),
        protocol_version: 2,
    }));
    assert_eq!(version["code"], "protocol_version_mismatch");
    let invalid_destination = json(manager.handle(ClientMessage::TestDestination {
        request_id: "probe".to_owned(),
        destination: "relative".to_owned(),
    }));
    assert_eq!(invalid_destination["code"], "invalid_destination");
    assert_eq!(
        json(manager.handle(begin_save(&destination, "body")))["type"],
        "ack"
    );
    let duplicate = json(manager.handle(begin_save(&destination, "body")));
    assert_eq!(duplicate["code"], "invalid_transition");
    let mut other_manager = SessionManager::new();
    let busy = json(other_manager.handle(ClientMessage::BeginSave {
        request_id: "other-begin".to_owned(),
        session_id: "a5a74c85-92de-4a5d-9768-4e66c4d64988".to_owned(),
        destination: destination.to_string_lossy().into_owned(),
        source: "https://example.test/other".to_owned(),
        title: "Other".to_owned(),
        markdown: "body".to_owned(),
    }));
    assert_eq!(busy["code"], "commit_failed");
    assert!(
        !busy
            .to_string()
            .contains(destination.to_string_lossy().as_ref())
    );
    let missing = json(manager.handle(ClientMessage::AbortSave {
        request_id: "abort".to_owned(),
        session_id: "a5a74c85-92de-4a5d-9768-4e66c4d64988".to_owned(),
        reason: None,
    }));
    assert_eq!(missing["code"], "session_not_found");
    manager.abort_all();
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn reports_chunk_state_errors_and_keeps_a_recoverable_media_fallback_session_usable() {
    let destination = temp();
    let mut manager = SessionManager::new();
    manager.handle(begin_save(
        &destination,
        &format!("arthur-media://{MEDIA_ID}"),
    ));
    manager.handle(begin_media());
    let wrong_sequence = json(manager.handle(ClientMessage::MediaChunk {
        session_id: SESSION.to_owned(),
        media_id: MEDIA_ID.to_owned(),
        sequence: 1,
        data: "dGVzdA==".to_owned(),
    }));
    assert_eq!(wrong_sequence["code"], "invalid_chunk");
    assert_eq!(
        json(manager.handle(ClientMessage::MediaChunk {
            session_id: SESSION.to_owned(),
            media_id: MEDIA_ID.to_owned(),
            sequence: 0,
            data: "dGVzdA==".to_owned(),
        }))["type"],
        "ack"
    );
    let fallback = json(manager.handle(ClientMessage::EndMedia {
        request_id: "end".to_owned(),
        session_id: SESSION.to_owned(),
        media_id: MEDIA_ID.to_owned(),
        chunks: 2,
    }));
    assert_eq!(fallback["type"], "warning");
    assert_eq!(fallback["code"], "media_fallback");
    assert_eq!(
        json(manager.handle(ClientMessage::CommitSave {
            request_id: "commit".to_owned(),
            session_id: SESSION.to_owned(),
        }))["type"],
        "save_result"
    );
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn maps_zero_byte_length_to_an_unknown_length_and_allows_an_empty_attachment() {
    let destination = temp();
    let mut manager = SessionManager::new();
    manager.handle(begin_save(
        &destination,
        &format!("arthur-media://{EMPTY_MEDIA_ID}"),
    ));
    assert_eq!(
        json(manager.handle(ClientMessage::BeginMedia {
            request_id: "media".to_owned(),
            session_id: SESSION.to_owned(),
            media_id: EMPTY_MEDIA_ID.to_owned(),
            source: "https://cdn.example.test/empty.webp".to_owned(),
            kind: MediaKind::Image,
            content_type: "image/webp".to_owned(),
            byte_length: 0,
        }))["type"],
        "ack"
    );
    assert_eq!(
        json(manager.handle(ClientMessage::EndMedia {
            request_id: "end".to_owned(),
            session_id: SESSION.to_owned(),
            media_id: EMPTY_MEDIA_ID.to_owned(),
            chunks: 0,
        }))["type"],
        "ack"
    );
    assert_eq!(
        json(manager.handle(ClientMessage::CommitSave {
            request_id: "commit".to_owned(),
            session_id: SESSION.to_owned(),
        }))["type"],
        "save_result"
    );
    assert_eq!(
        fs::read_dir(destination.join("attachments"))
            .unwrap()
            .count(),
        1
    );
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn abort_save_acknowledges_the_session_and_cleans_the_staged_transaction() {
    let destination = temp();
    let mut manager = SessionManager::new();
    manager.handle(begin_save(&destination, "body"));
    assert_eq!(
        json(manager.handle(ClientMessage::AbortSave {
            request_id: "abort".to_owned(),
            session_id: SESSION.to_owned(),
            reason: Some("cancelled".to_owned()),
        })),
        serde_json::json!({"type":"ack","requestId":"abort","sessionId":SESSION})
    );
    let slot = destination.join(".arthur-workspace-v1/slot-0");
    assert_eq!(fs::metadata(slot.join("new-note")).unwrap().len(), 0);
    assert_eq!(fs::metadata(slot.join("old-backup")).unwrap().len(), 0);
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn maps_fatal_commit_failures_and_redacts_untrusted_values_from_every_error() {
    let destination = temp();
    let mut manager = SessionManager::new();
    manager.handle(begin_save(
        &destination,
        &format!("arthur-media://{MEDIA_ID}"),
    ));
    manager.handle(begin_media());
    let failure = json(manager.handle(ClientMessage::CommitSave {
        request_id: "commit".to_owned(),
        session_id: SESSION.to_owned(),
    }));
    assert_eq!(failure["type"], "error");
    assert_eq!(failure["code"], "invalid_transition");
    let rendered = failure.to_string();
    for secret in ["arthur-media", "example.test", "/tmp"] {
        assert!(!rendered.contains(secret), "error leaked {secret}");
    }
    assert!(!destination.join("Article.md").exists());
    fs::remove_dir_all(destination).unwrap();
}
