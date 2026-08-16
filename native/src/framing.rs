use crate::protocol::{HostMessage, checked_host};

pub const MAX_NATIVE_REQUEST_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_NATIVE_RESPONSE_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    ZeroLength,
    Oversized(u32),
    InvalidUtf8,
    InvalidJson,
    TruncatedFrame,
    Poisoned,
}

enum DecoderState {
    Active,
    Poisoned,
}

pub struct FrameDecoder {
    state: DecoderState,
    header: [u8; 4],
    header_len: usize,
    expected_len: Option<usize>,
    payload: Vec<u8>,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            state: DecoderState::Active,
            header: [0; 4],
            header_len: 0,
            expected_len: None,
            payload: Vec::new(),
        }
    }

    fn fail<T>(&mut self, error: FrameError) -> Result<T, FrameError> {
        self.state = DecoderState::Poisoned;
        self.header = [0; 4];
        self.header_len = 0;
        self.expected_len = None;
        self.payload = Vec::new();
        Err(error)
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<serde_json::Value>, FrameError> {
        if matches!(self.state, DecoderState::Poisoned) {
            return Err(FrameError::Poisoned);
        }

        let mut offset = 0;
        let mut messages = Vec::new();
        while offset < bytes.len() {
            if self.expected_len.is_none() {
                let needed = 4 - self.header_len;
                let copied = needed.min(bytes.len() - offset);
                self.header[self.header_len..self.header_len + copied]
                    .copy_from_slice(&bytes[offset..offset + copied]);
                self.header_len += copied;
                offset += copied;
                if self.header_len < 4 {
                    continue;
                }

                let length = u32::from_le_bytes(self.header);
                if length == 0 {
                    return self.fail(FrameError::ZeroLength);
                }
                if length as usize > MAX_NATIVE_REQUEST_BYTES {
                    return self.fail(FrameError::Oversized(length));
                }
                self.expected_len = Some(length as usize);
                self.payload.clear();
            }

            let expected = self.expected_len.expect("the header was validated");
            let remaining = expected - self.payload.len();
            let copied = remaining.min(bytes.len() - offset);
            self.payload
                .extend_from_slice(&bytes[offset..offset + copied]);
            offset += copied;
            if self.payload.len() < expected {
                continue;
            }

            let value = match std::str::from_utf8(&self.payload) {
                Ok(text) => match serde_json::from_str(text) {
                    Ok(value) => value,
                    Err(_) => return self.fail(FrameError::InvalidJson),
                },
                Err(_) => return self.fail(FrameError::InvalidUtf8),
            };
            messages.push(value);
            self.payload.clear();
            self.expected_len = None;
            self.header = [0; 4];
            self.header_len = 0;
        }
        Ok(messages)
    }

    pub fn finish(&mut self) -> Result<(), FrameError> {
        if matches!(self.state, DecoderState::Poisoned) {
            return Err(FrameError::Poisoned);
        }
        if self.header_len == 0 && self.expected_len.is_none() {
            Ok(())
        } else {
            self.fail(FrameError::TruncatedFrame)
        }
    }
}

fn encode_payload(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_NATIVE_RESPONSE_BYTES {
        return Err(FrameError::Oversized(payload.len() as u32));
    }
    let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
    frame.extend(payload);
    Ok(frame)
}

pub fn encode_frame(message: &HostMessage) -> Result<Vec<u8>, FrameError> {
    checked_host(message).map_err(|_| FrameError::InvalidJson)?;
    let payload = serde_json::to_vec(message).map_err(|_| FrameError::InvalidJson)?;
    encode_payload(&payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut result = (payload.len() as u32).to_le_bytes().to_vec();
        result.extend(payload);
        result
    }

    #[test]
    fn failure_clears_the_buffer_and_never_inspects_later_bytes() {
        let mut decoder = FrameDecoder::new();
        assert_eq!(decoder.push(&[0, 0, 0, 0]), Err(FrameError::ZeroLength));
        assert!(decoder.payload.is_empty());

        let valid = frame(br#"{"later":true}"#);
        assert_eq!(decoder.push(&valid), Err(FrameError::Poisoned));
        assert!(decoder.payload.is_empty());
        assert_eq!(decoder.finish(), Err(FrameError::Poisoned));
        assert!(decoder.payload.is_empty());
    }

    #[test]
    fn response_frames_are_limited_independently_from_requests() {
        assert_eq!(
            encode_payload(&vec![0; MAX_NATIVE_RESPONSE_BYTES + 1]),
            Err(FrameError::Oversized(
                (MAX_NATIVE_RESPONSE_BYTES + 1) as u32
            ))
        );
    }

    #[test]
    fn a_large_header_does_not_preallocate_the_declared_body() {
        let mut decoder = FrameDecoder::new();
        assert!(
            decoder
                .push(&(MAX_NATIVE_REQUEST_BYTES as u32).to_le_bytes())
                .unwrap()
                .is_empty()
        );
        assert!(decoder.payload.is_empty());
        assert_eq!(decoder.payload.capacity(), 0);
        assert_eq!(decoder.finish(), Err(FrameError::TruncatedFrame));
        assert!(decoder.payload.is_empty());
        assert_eq!(decoder.payload.capacity(), 0);
    }
}
