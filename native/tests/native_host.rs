use arthur_native_host::protocol::{HostMessage, parse_host};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static COUNT: AtomicU64 = AtomicU64::new(0);
const SESSION: &str = "a5a74c85-92de-4a5d-9768-4e66c4d64987";

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut result = (payload.len() as u32).to_le_bytes().to_vec();
    result.extend_from_slice(payload);
    result
}

fn request(value: serde_json::Value) -> Vec<u8> {
    frame(&serde_json::to_vec(&value).unwrap())
}

fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "arthur-native-host-{}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}

fn run(input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_arthur-native-host"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(input).unwrap();
    child.stdin.take();
    child.wait_with_output().unwrap()
}

fn decode_stdout(bytes: &[u8]) -> Vec<HostMessage> {
    let mut offset = 0;
    let mut messages = Vec::new();
    while offset < bytes.len() {
        assert!(
            bytes.len() >= offset + 4,
            "stdout has a truncated frame header"
        );
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        offset += 4;
        assert!(
            bytes.len() >= offset + length,
            "stdout has a truncated frame body"
        );
        let value: serde_json::Value =
            serde_json::from_slice(&bytes[offset..offset + length]).unwrap();
        messages.push(parse_host(value).unwrap());
        offset += length;
    }
    messages
}

fn assert_invalid_native_frame(output: &Output) {
    assert!(!output.status.success());
    let messages = decode_stdout(&output.stdout);
    assert_eq!(messages.len(), 1);
    let HostMessage::Error { code, .. } = &messages[0] else {
        panic!("expected an error frame");
    };
    assert_eq!(code, "invalid_native_frame");
}

#[test]
fn valid_hello_writes_one_valid_response_and_no_diagnostics() {
    let output = run(&request(serde_json::json!({
        "type":"hello", "requestId":"hello", "protocolVersion":1
    })));
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let messages = decode_stdout(&output.stdout);
    assert_eq!(messages.len(), 1);
    let HostMessage::HelloResult {
        request_id,
        protocol_version,
        ..
    } = &messages[0]
    else {
        panic!("expected hello_result");
    };
    assert_eq!(request_id, "hello");
    assert_eq!(*protocol_version, 1);
}

#[test]
fn unsupported_hello_version_returns_a_typed_wire_error() {
    let output = run(&request(serde_json::json!({
        "type":"hello", "requestId":"mismatch", "protocolVersion":2
    })));
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let messages = decode_stdout(&output.stdout);
    assert_eq!(messages.len(), 1);
    let HostMessage::Error {
        request_id,
        session_id,
        code,
        ..
    } = &messages[0]
    else {
        panic!("expected a protocol-version error");
    };
    assert_eq!(request_id.as_deref(), Some("mismatch"));
    assert!(session_id.is_none());
    assert_eq!(code, "protocol_version_mismatch");
}

#[test]
fn split_and_coalesced_valid_frames_receive_one_response_each_in_order() {
    let first = request(serde_json::json!({
        "type":"hello", "requestId":"first", "protocolVersion":1
    }));
    let second = request(serde_json::json!({
        "type":"hello", "requestId":"second", "protocolVersion":1
    }));
    let mut child = Command::new(env!("CARGO_BIN_EXE_arthur-native-host"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.as_mut().unwrap();
    input.write_all(&first[..3]).unwrap();
    input.flush().unwrap();
    input
        .write_all(&[first[3..].as_ref(), second.as_ref()].concat())
        .unwrap();
    child.stdin.take();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let messages = decode_stdout(&output.stdout);
    assert_eq!(messages.len(), 2);
    let request_ids: Vec<_> = messages
        .into_iter()
        .map(|message| match message {
            HostMessage::HelloResult { request_id, .. } => request_id,
            _ => panic!("expected hello_result"),
        })
        .collect();
    assert_eq!(request_ids, ["first", "second"]);
}

#[test]
fn invalid_utf8_or_json_poison_the_connection_before_later_hello_is_interpreted() {
    let hello = request(serde_json::json!({
        "type":"hello", "requestId":"later", "protocolVersion":1
    }));
    let mut invalid_utf8 = frame(&[0xc3, 0x28]);
    invalid_utf8.extend_from_slice(&hello);
    assert_invalid_native_frame(&run(&invalid_utf8));

    let mut invalid_json = frame(b"nope");
    invalid_json.extend_from_slice(&hello);
    assert_invalid_native_frame(&run(&invalid_json));
}

#[test]
fn zero_or_oversized_frames_poison_the_connection_before_later_hello_is_interpreted() {
    let hello = request(serde_json::json!({
        "type":"hello", "requestId":"later", "protocolVersion":1
    }));
    let mut zero = vec![0, 0, 0, 0];
    zero.extend_from_slice(&hello);
    assert_invalid_native_frame(&run(&zero));

    let mut oversized = (1_048_577u32).to_le_bytes().to_vec();
    oversized.extend_from_slice(&hello);
    assert_invalid_native_frame(&run(&oversized));
}

#[test]
fn eof_aborts_an_active_session_without_replacing_the_old_note() {
    let destination = temp();
    let note = destination.join("Article.md");
    let original = b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
    fs::write(&note, original).unwrap();
    let output = run(&request(serde_json::json!({
        "type":"begin_save",
        "requestId":"begin",
        "sessionId":SESSION,
        "destination":destination,
        "source":"https://example.test/article",
        "title":"Article",
        "markdown":"new"
    })));
    assert!(output.status.success());
    assert_eq!(fs::read(&note).unwrap(), original);
    assert!(fs::read_dir(&destination).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".arthur-stage-")
    }));
    fs::remove_dir_all(destination).unwrap();
}
