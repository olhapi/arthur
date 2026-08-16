use crate::protocol::{HostMessage, checked_host};
pub const MAX_NATIVE_MESSAGE_BYTES: usize = 1_048_576;
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
    buffered: Vec<u8>,
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
            buffered: Vec::new(),
        }
    }
    fn fail<T>(&mut self, error: FrameError) -> Result<T, FrameError> {
        self.state = DecoderState::Poisoned;
        self.buffered.clear();
        Err(error)
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<serde_json::Value>, FrameError> {
        if matches!(self.state, DecoderState::Poisoned) {
            return Err(FrameError::Poisoned);
        }
        self.buffered.extend_from_slice(bytes);
        let mut messages = Vec::new();
        let mut consumed = 0;
        while self.buffered.len().saturating_sub(consumed) >= 4 {
            let length =
                u32::from_le_bytes(self.buffered[consumed..consumed + 4].try_into().unwrap());
            if length == 0 {
                return self.fail(FrameError::ZeroLength);
            }
            if length as usize > MAX_NATIVE_MESSAGE_BYTES {
                return self.fail(FrameError::Oversized(length));
            }
            let end = consumed + 4 + length as usize;
            if self.buffered.len() < end {
                break;
            }
            let payload = self.buffered[consumed + 4..end].to_vec();
            let text = match std::str::from_utf8(&payload) {
                Ok(value) => value,
                Err(_) => return self.fail(FrameError::InvalidUtf8),
            };
            let value = match serde_json::from_str(text) {
                Ok(value) => value,
                Err(_) => return self.fail(FrameError::InvalidJson),
            };
            messages.push(value);
            consumed = end;
        }
        self.buffered.drain(..consumed);
        Ok(messages)
    }
    pub fn finish(&mut self) -> Result<(), FrameError> {
        if matches!(self.state, DecoderState::Poisoned) {
            Err(FrameError::Poisoned)
        } else if self.buffered.is_empty() {
            Ok(())
        } else {
            self.fail(FrameError::TruncatedFrame)
        }
    }
}
pub fn encode_frame(message: &HostMessage) -> Result<Vec<u8>, FrameError> {
    checked_host(message).map_err(|_| FrameError::InvalidJson)?;
    let payload = serde_json::to_vec(message).map_err(|_| FrameError::InvalidJson)?;
    if payload.len() > MAX_NATIVE_MESSAGE_BYTES {
        return Err(FrameError::Oversized(payload.len() as u32));
    }
    let mut frame = (payload.len() as u32).to_le_bytes().to_vec();
    frame.extend(payload);
    Ok(frame)
}
