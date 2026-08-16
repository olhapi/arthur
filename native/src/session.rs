use crate::{
    protocol::{ClientMessage, HostMessage},
    vault::{MediaDisposition, MediaSpec, SaveSpec, Vault, VaultError, VaultTransaction},
};
use base64::{
    Engine as _, alphabet,
    engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig},
};
use std::{collections::HashMap, path::Path};

const CHUNK_BYTES: usize = 256 * 1024;

pub struct SessionManager {
    sessions: HashMap<String, VaultTransaction>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn handle(&mut self, message: ClientMessage) -> HostMessage {
        match message {
            ClientMessage::Hello {
                request_id,
                protocol_version,
            } => {
                if protocol_version != 1 {
                    return error(
                        Some(request_id),
                        None,
                        "protocol_version_mismatch",
                        "The native host protocol version is unsupported.",
                    );
                }
                HostMessage::HelloResult {
                    request_id,
                    protocol_version: 1,
                    host_name: "Arthur native host".to_owned(),
                    host_version: env!("CARGO_PKG_VERSION").to_owned(),
                }
            }
            ClientMessage::TestDestination {
                request_id,
                destination,
            } => match Vault::probe(Path::new(&destination)) {
                Ok(probe) => HostMessage::TestDestinationResult {
                    request_id,
                    destination: probe.canonical_destination.to_string_lossy().into_owned(),
                    writable: probe.writable,
                },
                Err(error) => vault_error(Some(request_id), None, error, ErrorContext::Destination),
            },
            ClientMessage::BeginSave {
                request_id,
                session_id,
                destination,
                source,
                title,
                markdown,
            } => {
                if self.sessions.contains_key(&session_id) {
                    return error(
                        Some(request_id),
                        Some(session_id),
                        "invalid_transition",
                        "A save with this session is already active.",
                    );
                }
                match Vault::open(Path::new(&destination)).and_then(|vault| {
                    vault.begin(SaveSpec {
                        session_id: session_id.clone(),
                        title,
                        source,
                        markdown,
                    })
                }) {
                    Ok(transaction) => {
                        self.sessions.insert(session_id.clone(), transaction);
                        ack(request_id, Some(session_id), None, None)
                    }
                    Err(error) => vault_error(
                        Some(request_id),
                        Some(session_id),
                        error,
                        ErrorContext::Begin,
                    ),
                }
            }
            ClientMessage::BeginMedia {
                request_id,
                session_id,
                media_id,
                source,
                kind,
                content_type,
                byte_length,
            } => {
                let Some(transaction) = self.sessions.get_mut(&session_id) else {
                    return missing_session(Some(request_id), session_id);
                };
                match transaction.begin_media(MediaSpec {
                    media_id,
                    source,
                    kind,
                    content_type,
                    declared_bytes: (byte_length != 0).then_some(byte_length),
                }) {
                    Ok(()) => ack(request_id, Some(session_id), None, None),
                    Err(error) => vault_error(
                        Some(request_id),
                        Some(session_id),
                        error,
                        ErrorContext::Media,
                    ),
                }
            }
            ClientMessage::MediaChunk {
                session_id,
                media_id,
                sequence,
                data,
            } => {
                let Some(transaction) = self.sessions.get_mut(&session_id) else {
                    return missing_session(None, session_id);
                };
                let bytes = match decode_chunk(&data) {
                    Ok(bytes) => bytes,
                    Err(()) => {
                        return error(
                            None,
                            Some(session_id),
                            "invalid_chunk",
                            "The media chunk is invalid.",
                        );
                    }
                };
                match transaction.append_chunk(&media_id, sequence, &bytes) {
                    Ok(()) => ack(
                        "chunk".to_owned(),
                        Some(session_id),
                        Some(media_id),
                        Some(sequence),
                    ),
                    Err(error) => vault_error(None, Some(session_id), error, ErrorContext::Chunk),
                }
            }
            ClientMessage::EndMedia {
                request_id,
                session_id,
                media_id,
                chunks,
            } => {
                let Some(transaction) = self.sessions.get_mut(&session_id) else {
                    return missing_session(Some(request_id), session_id);
                };
                match transaction.finish_media(&media_id, chunks) {
                    Ok(MediaDisposition::Saved) => {
                        ack(request_id, Some(session_id), Some(media_id), None)
                    }
                    Ok(MediaDisposition::Fallback { code, message }) => HostMessage::Warning {
                        request_id: Some(request_id),
                        session_id: Some(session_id),
                        code: code.to_owned(),
                        message: message.to_owned(),
                    },
                    Err(error) => vault_error(
                        Some(request_id),
                        Some(session_id),
                        error,
                        ErrorContext::Media,
                    ),
                }
            }
            ClientMessage::CommitSave {
                request_id,
                session_id,
            } => {
                let Some(transaction) = self.sessions.remove(&session_id) else {
                    return missing_session(Some(request_id), session_id);
                };
                match transaction.commit() {
                    Ok(saved) => HostMessage::SaveResult {
                        request_id,
                        session_id,
                        saved_path: saved.display_path.to_string_lossy().into_owned(),
                    },
                    Err(error) => vault_error(
                        Some(request_id),
                        Some(session_id),
                        error,
                        ErrorContext::Commit,
                    ),
                }
            }
            ClientMessage::AbortSave {
                request_id,
                session_id,
                ..
            } => {
                let Some(transaction) = self.sessions.remove(&session_id) else {
                    return missing_session(Some(request_id), session_id);
                };
                match transaction.abort() {
                    Ok(()) => ack(request_id, Some(session_id), None, None),
                    Err(error) => vault_error(
                        Some(request_id),
                        Some(session_id),
                        error,
                        ErrorContext::Commit,
                    ),
                }
            }
        }
    }

    pub fn abort_all(&mut self) {
        let sessions = std::mem::take(&mut self.sessions);
        for (_, transaction) in sessions {
            let _ = transaction.abort();
        }
    }
}

impl Drop for SessionManager {
    fn drop(&mut self) {
        self.abort_all();
    }
}

#[derive(Clone, Copy)]
enum ErrorContext {
    Destination,
    Begin,
    Media,
    Chunk,
    Commit,
}

fn decode_chunk(data: &str) -> Result<Vec<u8>, ()> {
    if data.is_empty() || data.len() > (CHUNK_BYTES.div_ceil(3) * 4) {
        return Err(());
    }
    let bytes = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
    )
    .decode(data)
    .map_err(|_| ())?;
    if bytes.len() > CHUNK_BYTES {
        return Err(());
    }
    Ok(bytes)
}

fn ack(
    request_id: String,
    session_id: Option<String>,
    media_id: Option<String>,
    sequence: Option<u64>,
) -> HostMessage {
    HostMessage::Ack {
        request_id,
        session_id,
        media_id,
        sequence,
    }
}

fn missing_session(request_id: Option<String>, session_id: String) -> HostMessage {
    error(
        request_id,
        Some(session_id),
        "session_not_found",
        "The save session is not available.",
    )
}

fn error(
    request_id: Option<String>,
    session_id: Option<String>,
    code: &'static str,
    message: &'static str,
) -> HostMessage {
    HostMessage::Error {
        request_id,
        session_id,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

fn vault_error(
    request_id: Option<String>,
    session_id: Option<String>,
    error_value: VaultError,
    context: ErrorContext,
) -> HostMessage {
    let (code, message) = match error_value {
        VaultError::InvalidDestination | VaultError::NotDirectory | VaultError::NotWritable => (
            "invalid_destination",
            "The selected destination cannot be used.",
        ),
        VaultError::UnsafeChild => (
            "unsafe_child",
            "The destination contains an unsafe child entry.",
        ),
        VaultError::InvalidName | VaultError::InvalidSource => (
            "invalid_message",
            "The save message contains an invalid value.",
        ),
        VaultError::InvalidTransition => (
            "invalid_transition",
            "The message is not valid for the current save state.",
        ),
        VaultError::Busy => (
            "commit_failed",
            "The selected destination is busy; try again after the active save finishes.",
        ),
        VaultError::InvalidChunk => ("invalid_chunk", "The media chunk is invalid."),
        VaultError::MediaLimitExceeded => (
            "media_limit_exceeded",
            "The media exceeds the configured size limit.",
        ),
        VaultError::AttachmentConflict => (
            "attachment_conflict",
            "An existing attachment has different content.",
        ),
        VaultError::SourceConflict => (
            "commit_failed",
            "The article changed while it was being saved.",
        ),
        VaultError::UnresolvedPlaceholder | VaultError::Io => match context {
            ErrorContext::Chunk => ("invalid_chunk", "The media chunk is invalid."),
            ErrorContext::Destination | ErrorContext::Begin => (
                "invalid_destination",
                "The selected destination cannot be used.",
            ),
            ErrorContext::Media | ErrorContext::Commit => {
                ("commit_failed", "The article could not be saved safely.")
            }
        },
    };
    error(request_id, session_id, code, message)
}
