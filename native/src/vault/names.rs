use super::VaultError;
use sha2::{Digest, Sha256};
use url::Url;
#[allow(dead_code)]
pub(super) fn normalize_source(value: &str) -> Result<String, VaultError> {
    let mut url = Url::parse(value).map_err(|_| VaultError::InvalidSource)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(VaultError::InvalidSource);
    }
    url.set_fragment(None);
    Ok(url.into())
}
#[allow(dead_code)]
pub(super) fn sanitize_stem(value: &str) -> String {
    let mut value: String = value
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':'))
        .collect();
    value = value
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_owned();
    let mut bytes = 0;
    value = value
        .chars()
        .take_while(|c| {
            bytes += c.len_utf8();
            bytes <= 180
        })
        .collect();
    if value.is_empty() {
        "article".into()
    } else {
        value
    }
}
#[allow(dead_code)]
pub(super) fn content_addressed_name(
    stem: &str,
    digest: &str,
    extension: &str,
) -> Result<String, VaultError> {
    if digest.len() < 12
        || !digest.chars().all(|c| c.is_ascii_hexdigit())
        || !extension.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(VaultError::InvalidName);
    }
    Ok(format!(
        "{}--{}.{}",
        sanitize_stem(stem),
        digest[..12].to_ascii_lowercase(),
        extension.to_ascii_lowercase()
    ))
}
#[allow(dead_code)]
pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
