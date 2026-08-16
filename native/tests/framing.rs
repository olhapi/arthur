use arthur_native_host::framing::{FrameDecoder, FrameError, MAX_NATIVE_MESSAGE_BYTES};

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
fn finish_rejects_truncated_header_and_body() {
    let mut header = FrameDecoder::new();
    header.push(&[1, 0]).unwrap();
    assert_eq!(header.finish(), Err(FrameError::TruncatedFrame));
    assert_eq!(header.push(&frame(b"{}")), Err(FrameError::Poisoned));
    let mut body = FrameDecoder::new();
    body.push(&[4, 0, 0, 0, b'{']).unwrap();
    assert_eq!(body.finish(), Err(FrameError::TruncatedFrame));
    assert_eq!(body.finish(), Err(FrameError::Poisoned));
}
#[test]
fn every_bad_frame_permanently_poisons_the_decoder() {
    for bytes in [
        vec![0, 0, 0, 0],
        (MAX_NATIVE_MESSAGE_BYTES as u32 + 1).to_le_bytes().to_vec(),
        frame(&[0xc3, 0x28]),
        frame(b"no"),
    ] {
        let mut decoder = FrameDecoder::new();
        assert!(decoder.push(&bytes).is_err());
        assert_eq!(decoder.push(&frame(b"{}")), Err(FrameError::Poisoned));
        assert_eq!(decoder.finish(), Err(FrameError::Poisoned));
    }
}
