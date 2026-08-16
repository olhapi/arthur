use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use url::Url;

const CHUNK_BYTES: usize = 256 * 1024;
const IMAGE_LIMIT: u64 = 100 * 1024 * 1024;
const AUDIO_VIDEO_LIMIT: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ClientMessage {
    Hello {
        request_id: String,
        protocol_version: u64,
    },
    TestDestination {
        request_id: String,
        destination: String,
    },
    BeginSave {
        request_id: String,
        session_id: String,
        destination: String,
        source: String,
        title: String,
        markdown: String,
    },
    BeginMedia {
        request_id: String,
        session_id: String,
        media_id: String,
        source: String,
        kind: MediaKind,
        content_type: String,
        byte_length: u64,
    },
    MediaChunk {
        session_id: String,
        media_id: String,
        sequence: u64,
        data: String,
    },
    EndMedia {
        request_id: String,
        session_id: String,
        media_id: String,
        chunks: u64,
    },
    CommitSave {
        request_id: String,
        session_id: String,
    },
    AbortSave {
        request_id: String,
        session_id: String,
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Audio,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostMessage {
    HelloResult {
        request_id: String,
        protocol_version: u64,
        host_name: String,
        host_version: String,
    },
    TestDestinationResult {
        request_id: String,
        destination: String,
        writable: bool,
    },
    SaveResult {
        request_id: String,
        session_id: String,
        saved_path: String,
    },
    Ack {
        request_id: String,
        session_id: Option<String>,
        media_id: Option<String>,
        sequence: Option<u64>,
    },
    Warning {
        request_id: Option<String>,
        session_id: Option<String>,
        code: String,
        message: String,
    },
    Error {
        request_id: Option<String>,
        session_id: Option<String>,
        code: String,
        message: String,
    },
}

fn bounded(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && [8, 13, 18, 23]
            .iter()
            .all(|&i| value.as_bytes().get(i) == Some(&b'-'))
}
fn absolute(value: &str) -> bool {
    std::path::Path::new(value).is_absolute() && value.len() <= 2048
}
pub fn normalize_source(value: &str) -> Result<String, ProtocolError> {
    let mut url = Url::parse(value).map_err(|_| ProtocolError::Invalid)?;
    if !matches!(url.scheme(), "http" | "https") || value.len() > 2048 {
        return Err(ProtocolError::Invalid);
    }
    url.set_fragment(None);
    Ok(url.into())
}
fn mime(value: &str) -> bool {
    value.len() <= 255
        && value.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty() && !b.is_empty() && !value.chars().any(char::is_whitespace)
        })
}
fn validate_client(message: &mut ClientMessage) -> Result<(), ProtocolError> {
    match message {
        ClientMessage::Hello {
            request_id,
            protocol_version,
        } => {
            if !bounded(request_id, 128) || *protocol_version != 1 {
                return Err(ProtocolError::Invalid);
            }
        }
        ClientMessage::TestDestination {
            request_id,
            destination,
        } => {
            if !bounded(request_id, 128) || !absolute(destination) {
                return Err(ProtocolError::Invalid);
            }
        }
        ClientMessage::BeginSave {
            request_id,
            session_id,
            destination,
            source,
            title,
            markdown,
        } => {
            if !bounded(request_id, 128)
                || !uuid(session_id)
                || !absolute(destination)
                || !bounded(title, 512)
                || markdown.len() > 20 * 1024 * 1024
            {
                return Err(ProtocolError::Invalid);
            }
            *source = normalize_source(source)?;
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
            let max = match kind {
                MediaKind::Image => IMAGE_LIMIT,
                _ => AUDIO_VIDEO_LIMIT,
            };
            if !bounded(request_id, 128)
                || !uuid(session_id)
                || !bounded(media_id, 128)
                || !mime(content_type)
                || *byte_length > max
            {
                return Err(ProtocolError::Invalid);
            }
            *source = normalize_source(source)?;
        }
        ClientMessage::MediaChunk {
            session_id,
            media_id,
            data,
            ..
        } => {
            if !uuid(session_id) || !bounded(media_id, 128) {
                return Err(ProtocolError::Invalid);
            }
            let bytes = STANDARD
                .decode(data.as_str())
                .map_err(|_| ProtocolError::Invalid)?;
            if bytes.len() > CHUNK_BYTES || STANDARD.encode(bytes) != *data {
                return Err(ProtocolError::Invalid);
            }
        }
        ClientMessage::EndMedia {
            request_id,
            session_id,
            media_id,
            ..
        } => {
            if !bounded(request_id, 128) || !uuid(session_id) || !bounded(media_id, 128) {
                return Err(ProtocolError::Invalid);
            }
        }
        ClientMessage::CommitSave {
            request_id,
            session_id,
        } => {
            if !bounded(request_id, 128) || !uuid(session_id) {
                return Err(ProtocolError::Invalid);
            }
        }
        ClientMessage::AbortSave {
            request_id,
            session_id,
            reason,
        } => {
            if !bounded(request_id, 128)
                || !uuid(session_id)
                || reason.as_deref().is_some_and(|v| !bounded(v, 4096))
            {
                return Err(ProtocolError::Invalid);
            }
        }
    };
    Ok(())
}
fn validate_host(message: &HostMessage) -> Result<(), ProtocolError> {
    match message {
        HostMessage::HelloResult {
            request_id,
            protocol_version,
            host_name,
            host_version,
        } if bounded(request_id, 128)
            && *protocol_version == 1
            && bounded(host_name, 255)
            && bounded(host_version, 128) =>
        {
            Ok(())
        }
        HostMessage::TestDestinationResult {
            request_id,
            destination,
            ..
        } if bounded(request_id, 128) && absolute(destination) => Ok(()),
        HostMessage::SaveResult {
            request_id,
            session_id,
            saved_path,
        } if bounded(request_id, 128) && uuid(session_id) && absolute(saved_path) => Ok(()),
        HostMessage::Ack {
            request_id,
            session_id,
            media_id,
            ..
        } if bounded(request_id, 128)
            && session_id.as_deref().is_none_or(uuid)
            && media_id.as_deref().is_none_or(|v| bounded(v, 128)) =>
        {
            Ok(())
        }
        HostMessage::Warning {
            request_id,
            session_id,
            code,
            message,
        }
        | HostMessage::Error {
            request_id,
            session_id,
            code,
            message,
        } if request_id.as_deref().is_none_or(|v| bounded(v, 128))
            && session_id.as_deref().is_none_or(uuid)
            && bounded(code, 128)
            && bounded(message, 4096) =>
        {
            Ok(())
        }
        _ => Err(ProtocolError::Invalid),
    }
}
pub fn parse_client(value: serde_json::Value) -> Result<ClientMessage, ProtocolError> {
    let mut message = serde_json::from_value(value).map_err(|_| ProtocolError::Invalid)?;
    validate_client(&mut message)?;
    Ok(message)
}
pub fn parse_host(value: serde_json::Value) -> Result<HostMessage, ProtocolError> {
    let message = serde_json::from_value(value).map_err(|_| ProtocolError::Invalid)?;
    validate_host(&message)?;
    Ok(message)
}
pub(crate) fn checked_host(message: &HostMessage) -> Result<(), ProtocolError> {
    validate_host(message)
}
