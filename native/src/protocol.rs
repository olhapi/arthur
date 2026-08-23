use base64::{
    Engine as _, alphabet,
    engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig},
};
use serde::{Deserialize, Serialize};
use url::Url;

const CHUNK_BYTES: usize = 256 * 1024;
const IMAGE_LIMIT: u64 = 100 * 1024 * 1024;
const AUDIO_VIDEO_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

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
    ChooseDestination {
        request_id: String,
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
        #[serde(skip_serializing_if = "Option::is_none")]
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
    ChooseDestinationResult {
        request_id: String,
        destination: String,
    },
    SaveResult {
        request_id: String,
        session_id: String,
        saved_path: String,
    },
    Ack {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sequence: Option<u64>,
    },
    Warning {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        code: String,
        message: String,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        code: String,
        message: String,
    },
}

fn is_js_whitespace(value: char) -> bool {
    matches!(
        value,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}
fn trim_js(value: &str) -> String {
    value.trim_matches(is_js_whitespace).to_owned()
}
fn js_length(value: &str) -> usize {
    value.encode_utf16().count()
}
fn bounded(value: &mut String, max: usize) -> bool {
    *value = trim_js(value);
    !value.is_empty() && js_length(value) <= max
}
fn optional_bounded(value: &mut Option<String>, max: usize) -> bool {
    value.as_mut().is_none_or(|value| bounded(value, max))
}
fn js_safe_integer(value: u64) -> bool {
    value <= MAX_JS_SAFE_INTEGER
}
fn optional_js_safe_integer(value: Option<u64>) -> bool {
    value.is_none_or(js_safe_integer)
}
use crate::validation::zod_uuid as uuid;
fn absolute(value: &mut String) -> bool {
    *value = trim_js(value);
    value.starts_with('/') && !value.contains('\0') && js_length(value) <= 4096
}
pub fn normalize_source(value: &str) -> Result<String, ProtocolError> {
    let value = trim_js(value);
    if js_length(&value) > 2048 {
        return Err(ProtocolError::Invalid);
    }
    let mut url = Url::parse(&value).map_err(|_| ProtocolError::Invalid)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ProtocolError::Invalid);
    }
    url.set_fragment(None);
    Ok(url.into())
}
fn mime(value: &mut String) -> bool {
    *value = trim_js(value);
    js_length(value) <= 255
        && value.matches('/').count() == 1
        && value.split_once('/').is_some_and(|(a, b)| {
            !a.is_empty() && !b.is_empty() && !value.chars().any(is_js_whitespace)
        })
}
fn validate_client(message: &mut ClientMessage) -> Result<(), ProtocolError> {
    match message {
        ClientMessage::Hello {
            request_id,
            protocol_version,
        } => {
            if !bounded(request_id, 128)
                || !js_safe_integer(*protocol_version)
                || *protocol_version != 1
            {
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
        ClientMessage::ChooseDestination { request_id } => {
            if !bounded(request_id, 128) {
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
                || js_length(markdown) > 10 * 1024 * 1024
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
                || !uuid(media_id)
                || !mime(content_type)
                || !js_safe_integer(*byte_length)
                || *byte_length > max
            {
                return Err(ProtocolError::Invalid);
            }
            *source = normalize_source(source)?;
        }
        ClientMessage::MediaChunk {
            session_id,
            media_id,
            sequence,
            data,
            ..
        } => {
            if !uuid(session_id) || !uuid(media_id) || !js_safe_integer(*sequence) {
                return Err(ProtocolError::Invalid);
            }
            if data.is_empty() {
                return Err(ProtocolError::Invalid);
            }
            if data.len() > (CHUNK_BYTES.div_ceil(3) * 4) {
                return Err(ProtocolError::Invalid);
            }
            let bytes = GeneralPurpose::new(
                &alphabet::STANDARD,
                GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
            )
            .decode(data.as_str())
            .map_err(|_| ProtocolError::Invalid)?;
            if bytes.len() > CHUNK_BYTES {
                return Err(ProtocolError::Invalid);
            }
        }
        ClientMessage::EndMedia {
            request_id,
            session_id,
            media_id,
            chunks,
            ..
        } => {
            if !bounded(request_id, 128)
                || !uuid(session_id)
                || !uuid(media_id)
                || !js_safe_integer(*chunks)
            {
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
            if !bounded(request_id, 128) || !uuid(session_id) || !optional_bounded(reason, 4096) {
                return Err(ProtocolError::Invalid);
            }
        }
    };
    Ok(())
}
fn validate_host(message: &mut HostMessage) -> Result<(), ProtocolError> {
    match message {
        HostMessage::HelloResult {
            request_id,
            protocol_version,
            host_name,
            host_version,
        } => (bounded(request_id, 128)
            && js_safe_integer(*protocol_version)
            && *protocol_version == 1
            && bounded(host_name, 255)
            && bounded(host_version, 128))
        .then_some(())
        .ok_or(ProtocolError::Invalid),
        HostMessage::TestDestinationResult {
            request_id,
            destination,
            ..
        } => (bounded(request_id, 128) && absolute(destination))
            .then_some(())
            .ok_or(ProtocolError::Invalid),
        HostMessage::ChooseDestinationResult {
            request_id,
            destination,
        } => (bounded(request_id, 128) && absolute(destination))
            .then_some(())
            .ok_or(ProtocolError::Invalid),
        HostMessage::SaveResult {
            request_id,
            session_id,
            saved_path,
        } => (bounded(request_id, 128) && uuid(session_id) && absolute(saved_path))
            .then_some(())
            .ok_or(ProtocolError::Invalid),
        HostMessage::Ack {
            request_id,
            session_id,
            media_id,
            sequence,
        } => (bounded(request_id, 128)
            && session_id.as_deref().is_none_or(uuid)
            && media_id.as_deref().is_none_or(uuid)
            && optional_js_safe_integer(*sequence))
        .then_some(())
        .ok_or(ProtocolError::Invalid),
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
        } => (optional_bounded(request_id, 128)
            && session_id.as_deref().is_none_or(uuid)
            && bounded(code, 128)
            && bounded(message, 4096))
        .then_some(())
        .ok_or(ProtocolError::Invalid),
    }
}
pub fn parse_client(value: serde_json::Value) -> Result<ClientMessage, ProtocolError> {
    if value
        .as_object()
        .is_some_and(|object| object.get("reason").is_some_and(serde_json::Value::is_null))
    {
        return Err(ProtocolError::Invalid);
    }
    let mut message = serde_json::from_value(value).map_err(|_| ProtocolError::Invalid)?;
    validate_client(&mut message)?;
    Ok(message)
}

/// Identifies only a structurally valid hello whose otherwise-valid protocol
/// version is unsupported. `parse_client` intentionally remains strict so its
/// behavior stays aligned with the browser contract; the stream dispatcher
/// uses this narrow classifier to return the requested typed negotiation error.
pub(crate) fn unsupported_hello(value: &serde_json::Value) -> Option<(String, u64)> {
    let object = value.as_object()?;
    if object.len() != 3
        || object.get("type")?.as_str()? != "hello"
        || !object.contains_key("requestId")
        || !object.contains_key("protocolVersion")
    {
        return None;
    }
    let mut request_id = object.get("requestId")?.as_str()?.to_owned();
    let protocol_version = object.get("protocolVersion")?.as_u64()?;
    (bounded(&mut request_id, 128) && js_safe_integer(protocol_version) && protocol_version != 1)
        .then_some((request_id, protocol_version))
}

pub fn parse_host(value: serde_json::Value) -> Result<HostMessage, ProtocolError> {
    if value.as_object().is_some_and(|object| {
        ["requestId", "sessionId", "mediaId", "sequence"]
            .iter()
            .any(|key| object.get(*key).is_some_and(serde_json::Value::is_null))
    }) {
        return Err(ProtocolError::Invalid);
    }
    let mut message = serde_json::from_value(value).map_err(|_| ProtocolError::Invalid)?;
    validate_host(&mut message)?;
    Ok(message)
}
pub(crate) fn checked_host(message: &HostMessage) -> Result<(), ProtocolError> {
    validate_host(&mut message.clone())
}
