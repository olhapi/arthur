use arthur_native_host::framing::{FrameDecoder, FrameError, MAX_NATIVE_REQUEST_BYTES};

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut result = (payload.len() as u32).to_le_bytes().to_vec();
    result.extend_from_slice(payload);
    result
}

#[test]
fn decodes_fragmented_and_coalesced_frames() {
    let one = frame(br#"{"one":1}"#);
    let two = frame(br#"{"two":2}"#);
    let mut decoder = FrameDecoder::new();
    assert!(decoder.push(&one[..3]).unwrap().is_empty());
    assert_eq!(
        decoder
            .push(&[one[3..].as_ref(), two.as_ref()].concat())
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn decodes_a_split_body_and_allows_an_empty_stream_to_finish() {
    let bytes = frame(br#"{"split":true}"#);
    let mut decoder = FrameDecoder::new();
    assert!(decoder.push(&bytes[..7]).unwrap().is_empty());
    assert_eq!(decoder.push(&bytes[7..]).unwrap().len(), 1);
    assert_eq!(decoder.finish(), Ok(()));

    assert_eq!(FrameDecoder::new().finish(), Ok(()));
}
#[test]
fn finish_rejects_truncated_header_and_body() {
    let mut header = FrameDecoder::new();
    header.push(&[1, 0]).unwrap();
    assert_eq!(header.finish(), Err(FrameError::TruncatedFrame));
    assert_eq!(header.push(&frame(b"{}")), Err(FrameError::Poisoned));
    assert_eq!(header.finish(), Err(FrameError::Poisoned));
    let mut body = FrameDecoder::new();
    body.push(&[4, 0, 0, 0, b'{']).unwrap();
    assert_eq!(body.finish(), Err(FrameError::TruncatedFrame));
    assert_eq!(body.push(&frame(b"{}")), Err(FrameError::Poisoned));
    assert_eq!(body.finish(), Err(FrameError::Poisoned));
}
#[test]
fn every_bad_frame_permanently_poisons_the_decoder() {
    for (bytes, expected) in [
        (vec![0, 0, 0, 0], FrameError::ZeroLength),
        (
            (MAX_NATIVE_REQUEST_BYTES as u32 + 1).to_le_bytes().to_vec(),
            FrameError::Oversized(MAX_NATIVE_REQUEST_BYTES as u32 + 1),
        ),
        (frame(&[0xc3, 0x28]), FrameError::InvalidUtf8),
        (frame(b"no"), FrameError::InvalidJson),
    ] {
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.push(&bytes), Err(expected));
        assert_eq!(decoder.push(&frame(b"{}")), Err(FrameError::Poisoned));
        assert_eq!(decoder.finish(), Err(FrameError::Poisoned));
    }
}

#[test]
fn accepts_a_valid_exact_sixty_four_mebibyte_request_without_allocating_from_the_header() {
    let mut payload = Vec::with_capacity(MAX_NATIVE_REQUEST_BYTES);
    payload.push(b'"');
    payload.resize(MAX_NATIVE_REQUEST_BYTES - 1, b'a');
    payload.push(b'"');
    assert_eq!(payload.len(), MAX_NATIVE_REQUEST_BYTES);

    let mut decoder = FrameDecoder::new();
    let decoded = decoder.push(&frame(&payload)).unwrap();
    assert_eq!(decoded.len(), 1);
    assert_eq!(decoder.finish(), Ok(()));
}
