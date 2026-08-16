use arthur_native_host::{
    framing::MAX_NATIVE_REQUEST_BYTES,
    protocol::{HostMessage, parse_host},
};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static COUNT: AtomicU64 = AtomicU64::new(0);
const SESSION: &str = "a5a74c85-92de-4a5d-9768-4e66c4d64987";
const SECOND_SESSION: &str = "b5a74c85-92de-4a5d-9768-4e66c4d64987";

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

fn run_with_environment(input: &[u8], key: &str, value: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_arthur-native-host"))
        .env(key, value)
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

fn read_one_host_message(reader: &mut impl Read) -> HostMessage {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).unwrap();
    let length = u32::from_le_bytes(header) as usize;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    parse_host(serde_json::from_slice(&body).unwrap()).unwrap()
}

fn begin_save_request(
    destination: &PathBuf,
    session: &str,
    request_id: &str,
    markdown: &str,
) -> Vec<u8> {
    request(serde_json::json!({
        "type":"begin_save",
        "requestId":request_id,
        "sessionId":session,
        "destination":destination,
        "source":"https://example.test/article",
        "title":"Article",
        "markdown":markdown
    }))
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
fn default_host_has_no_environment_trigger_for_acceptance_faults() {
    let destination = temp();
    let input = [
        begin_save_request(&destination, SESSION, "begin", "new"),
        request(serde_json::json!({
            "type":"commit_save", "requestId":"commit", "sessionId":SESSION
        })),
    ]
    .concat();
    let output = run_with_environment(&input, "ARTHUR_ACCEPTANCE_FAULT", "before_note_rename");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    assert!(matches!(
        decode_stdout(&output.stdout).last(),
        Some(HostMessage::SaveResult { .. })
    ));
    assert_eq!(
        fs::read_to_string(destination.join("Article.md")).unwrap(),
        "---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nnew"
    );
    fs::remove_dir_all(destination).unwrap();
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

    let mut oversized = (MAX_NATIVE_REQUEST_BYTES as u32 + 1).to_le_bytes().to_vec();
    oversized.extend_from_slice(&hello);
    assert_invalid_native_frame(&run(&oversized));
}

#[test]
fn eof_aborts_an_active_session_without_replacing_the_old_note() {
    let destination = temp();
    let note = destination.join("Article.md");
    let original = b"---\ntitle: \"Article\"\nsource: \"https://example.test/article\"\n---\n\nold";
    fs::write(&note, original).unwrap();
    let output = run(&begin_save_request(&destination, SESSION, "begin", "new"));
    assert!(output.status.success());
    let messages = decode_stdout(&output.stdout);
    assert_eq!(messages.len(), 1);
    assert!(matches!(messages[0], HostMessage::Ack { .. }));
    assert_eq!(fs::read(&note).unwrap(), original);
    let slot = destination.join(".arthur-workspace-v1/slot-0");
    assert_eq!(fs::metadata(slot.join("new-note")).unwrap().len(), 0);
    assert_eq!(fs::metadata(slot.join("old-backup")).unwrap().len(), 0);
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn partial_header_or_body_eof_is_a_typed_poisoned_native_frame() {
    assert_invalid_native_frame(&run(&[1, 0]));
    assert_invalid_native_frame(&run(&[4, 0, 0, 0, b'{']));
}

#[test]
fn markdown_boundary_is_semantic_not_frame_poisoning() {
    let destination = temp();
    let accepted = "a".repeat(10 * 1024 * 1024);
    let accepted_output = run(&begin_save_request(
        &destination,
        SESSION,
        "accepted",
        &accepted,
    ));
    assert!(accepted_output.status.success());
    assert!(matches!(
        decode_stdout(&accepted_output.stdout).as_slice(),
        [HostMessage::Ack { request_id, .. }] if request_id == "accepted"
    ));

    let rejected = "a".repeat(10 * 1024 * 1024 + 1);
    let mut input = begin_save_request(&destination, SESSION, "rejected", &rejected);
    input.extend_from_slice(&request(serde_json::json!({
        "type":"hello", "requestId":"after", "protocolVersion":1
    })));
    let rejected_output = run(&input);
    assert!(rejected_output.status.success());
    let messages = decode_stdout(&rejected_output.stdout);
    assert!(matches!(
        &messages[0],
        HostMessage::Error { request_id, code, .. }
            if request_id.is_none() && code == "invalid_message"
    ));
    assert!(matches!(
        &messages[1],
        HostMessage::HelloResult { request_id, .. } if request_id == "after"
    ));
    fs::remove_dir_all(destination).unwrap();
}

#[test]
fn destination_flock_serializes_independent_native_host_processes_and_releases_on_eof() {
    let destination = temp();
    let mut first = Command::new(env!("CARGO_BIN_EXE_arthur-native-host"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    first
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&begin_save_request(&destination, SESSION, "first", "body"))
        .unwrap();
    first.stdin.as_mut().unwrap().flush().unwrap();
    let first_message = read_one_host_message(first.stdout.as_mut().unwrap());
    assert!(matches!(
        first_message,
        HostMessage::Ack { request_id, .. } if request_id == "first"
    ));

    let second = run(&begin_save_request(
        &destination,
        SECOND_SESSION,
        "second",
        "body",
    ));
    assert!(second.status.success());
    assert!(matches!(
        decode_stdout(&second.stdout).as_slice(),
        [HostMessage::Error { request_id, code, .. }]
            if request_id.as_deref() == Some("second") && code == "commit_failed"
    ));

    first.stdin.take();
    let first_output = first.wait_with_output().unwrap();
    assert!(first_output.status.success());
    assert!(first_output.stderr.is_empty());
    assert!(first_output.stdout.is_empty());

    let third = run(&begin_save_request(
        &destination,
        SECOND_SESSION,
        "third",
        "body",
    ));
    assert!(third.status.success());
    assert!(matches!(
        decode_stdout(&third.stdout).as_slice(),
        [HostMessage::Ack { request_id, .. }] if request_id == "third"
    ));
    fs::remove_dir_all(destination).unwrap();
}
