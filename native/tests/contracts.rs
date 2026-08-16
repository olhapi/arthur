use arthur_native_host::{
    framing::encode_frame,
    protocol::{ClientMessage, HostMessage, parse_client, parse_host},
};
use serde_json::Value;

const MEDIA_ID: &str = "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832";

#[test]
fn shared_contract_fixtures_match_rust_validation() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../tests/contracts/native-messages.json")).unwrap();
    for message in fixtures["validClientMessages"].as_array().unwrap() {
        assert!(parse_client(message.clone()).is_ok());
    }
    for message in fixtures["invalidClientMessages"].as_array().unwrap() {
        assert!(parse_client(message.clone()).is_err());
    }
    for message in fixtures["validHostMessages"].as_array().unwrap() {
        assert!(parse_host(message.clone()).is_ok());
    }
    for message in fixtures["invalidHostMessages"].as_array().unwrap() {
        assert!(parse_host(message.clone()).is_err());
    }
}

#[test]
fn rejects_non_zod_optional_null_and_invalid_boundaries() {
    assert!(
        parse_host(serde_json::json!({"type":"error","code":"x","message":"x","requestId":null}))
            .is_err()
    );
    assert!(parse_client(serde_json::json!({"type":"media_chunk","sessionId":"a5a74c85-92de-4a5d-9768-4e66c4d64987","mediaId":MEDIA_ID,"sequence":0,"data":""})).is_err());
    assert!(parse_client(serde_json::json!({"type":"begin_media","requestId":"r","sessionId":"a5a74c85-92de-4a5d-9768-4e66c4d64987","mediaId":MEDIA_ID,"source":"https://example.test/a","kind":"image","contentType":"image/webp/x","byteLength":0})).is_err());
    assert!(parse_client(serde_json::json!({"type":"commit_save","requestId":"r","sessionId":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"})).is_err());
}

#[test]
fn mirrors_zod_transforms_and_uuid_rules_without_serializing_absent_options() {
    let message = parse_client(serde_json::json!({
        "type": "begin_save",
        "requestId": " request ",
        "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
        "destination": " /tmp/Arthur ",
        "source": " HTTPS://Example.COM:443/a#old ",
        "title": " Article ",
        "markdown": "Body"
    }))
    .unwrap();
    let ClientMessage::BeginSave {
        request_id,
        destination,
        source,
        title,
        ..
    } = message
    else {
        panic!("expected begin_save");
    };
    assert_eq!(request_id, "request");
    assert_eq!(destination, "/tmp/Arthur");
    assert_eq!(source, "https://example.com/a");
    assert_eq!(title, "Article");

    let media = parse_client(serde_json::json!({
        "type": "begin_media",
        "requestId": " request ",
        "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
        "mediaId": "7f9b5e81-4e80-4b7b-9ac5-c5d54f88b832",
        "source": " https://example.test/hero.webp ",
        "kind": "image",
        "contentType": " image/webp ",
        "byteLength": 0
    }))
    .unwrap();
    let ClientMessage::BeginMedia {
        request_id,
        media_id,
        source,
        content_type,
        ..
    } = media
    else {
        panic!("expected begin_media");
    };
    assert_eq!(request_id, "request");
    assert_eq!(media_id, MEDIA_ID);
    assert_eq!(source, "https://example.test/hero.webp");
    assert_eq!(content_type, "image/webp");

    let host = parse_host(serde_json::json!({
        "type": "warning",
        "code": " media_fallback ",
        "message": " Media remains remote ",
    }))
    .unwrap();
    let HostMessage::Warning { code, message, .. } = host else {
        panic!("expected warning");
    };
    assert_eq!(code, "media_fallback");
    assert_eq!(message, "Media remains remote");

    for session_id in [
        "a5a74c85-92de-0a5d-9768-4e66c4d64987",
        "a5a74c85-92de-4a5d-0768-4e66c4d64987",
    ] {
        assert!(
            parse_client(serde_json::json!({
                "type": "commit_save", "requestId": "r", "sessionId": session_id
            }))
            .is_err()
        );
    }
    assert!(
        parse_client(serde_json::json!({
            "type": "abort_save",
            "requestId": "r",
            "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
            "reason": null
        }))
        .is_err()
    );
    let abort_without_reason = parse_client(serde_json::json!({
        "type": "abort_save",
        "requestId": "r",
        "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987"
    }))
    .unwrap();
    assert!(
        serde_json::to_value(abort_without_reason)
            .unwrap()
            .get("reason")
            .is_none()
    );
    assert!(
        parse_client(serde_json::json!({
            "type": "media_chunk",
            "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
            "mediaId": MEDIA_ID,
            "sequence": 0,
            "data": "AB=="
        }))
        .is_ok()
    );

    let frame = encode_frame(&HostMessage::Error {
        request_id: None,
        session_id: None,
        code: "invalid_native_frame".to_owned(),
        message: "Native message stream is invalid".to_owned(),
    })
    .unwrap();
    let encoded: Value = serde_json::from_slice(&frame[4..]).unwrap();
    assert!(encoded.get("requestId").is_none());
    assert!(encoded.get("sessionId").is_none());
}

#[test]
fn measures_zod_string_limits_in_javascript_utf16_code_units() {
    let accepted_request_id = "😀".repeat(64);
    assert!(
        parse_client(serde_json::json!({
            "type": "hello", "requestId": accepted_request_id, "protocolVersion": 1
        }))
        .is_ok()
    );
    assert!(
        parse_client(serde_json::json!({
            "type": "hello", "requestId": "😀".repeat(65), "protocolVersion": 1
        }))
        .is_err()
    );

    assert!(parse_client(serde_json::json!({
        "type": "test_destination", "requestId": "r", "destination": format!("/{}", "a".repeat(4095))
    }))
    .is_ok());
    assert!(parse_client(serde_json::json!({
        "type": "test_destination", "requestId": "r", "destination": format!("/{}", "a".repeat(4096))
    }))
    .is_err());
}

#[test]
fn requires_uuid_media_ids_and_limits_markdown_to_ten_mebibytes_of_utf16() {
    assert!(
        parse_client(serde_json::json!({
            "type": "begin_media",
            "requestId": "r",
            "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
            "mediaId": "m1",
            "source": "https://example.test/a.webp",
            "kind": "image",
            "contentType": "image/webp",
            "byteLength": 0
        }))
        .is_err()
    );
    assert!(
        parse_host(serde_json::json!({
            "type": "ack",
            "requestId": "chunk",
            "mediaId": "m1"
        }))
        .is_err()
    );

    let markdown = "😀".repeat(5 * 1024 * 1024);
    assert_eq!(markdown.encode_utf16().count(), 10 * 1024 * 1024);
    let at_limit = serde_json::json!({
        "type": "begin_save",
        "requestId": "r",
        "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
        "destination": "/tmp/Arthur",
        "source": "https://example.test/a",
        "title": "Article",
        "markdown": markdown,
    });
    assert!(parse_client(at_limit.clone()).is_ok());
    let mut over_limit = at_limit;
    over_limit["markdown"] =
        Value::String(format!("{}x", over_limit["markdown"].as_str().unwrap()));
    assert!(parse_client(over_limit).is_err());
}

#[test]
fn applies_the_source_utf16_limit_before_url_normalization() {
    let source = format!("https://example.test/{}", "é".repeat(1000));
    assert_eq!(source.encode_utf16().count(), 1021);
    let message = parse_client(serde_json::json!({
        "type": "begin_save",
        "requestId": "r",
        "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
        "destination": "/tmp/Arthur",
        "source": source,
        "title": "Article",
        "markdown": "Body"
    }))
    .unwrap();
    let ClientMessage::BeginSave { source, .. } = message else {
        panic!("expected begin_save");
    };
    assert!(source.len() > 2048);

    let too_long = format!("https://example.test/{}", "é".repeat(2028));
    assert!(
        parse_client(serde_json::json!({
            "type": "begin_save",
            "requestId": "r",
            "sessionId": "a5a74c85-92de-4a5d-9768-4e66c4d64987",
            "destination": "/tmp/Arthur",
            "source": too_long,
            "title": "Article",
            "markdown": "Body"
        }))
        .is_err()
    );
}
