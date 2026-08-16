use super::VaultError;
use sha2::{Digest, Sha256};
use std::path::Path;
use url::Url;

const RECOGNIZED_EXTENSIONS: &[&str] = &[
    "aac", "avif", "flac", "gif", "jpeg", "jpg", "m4a", "m4v", "mov", "mp3", "mp4", "ogg", "ogv",
    "opus", "png", "svg", "wav", "weba", "webm", "webp",
];

#[allow(dead_code)]
fn mime_extension(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "audio/aac" => "aac",
        "audio/flac" => "flac",
        "audio/m4a" | "audio/mp4" => "m4a",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        "audio/opus" => "opus",
        "audio/wav" => "wav",
        "audio/webm" => "weba",
        "image/avif" => "avif",
        "image/gif" => "gif",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/svg+xml" => "svg",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/ogg" => "ogv",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "video/x-m4v" => "m4v",
        _ => "bin",
    }
}

fn recognized_extension(value: &str) -> bool {
    RECOGNIZED_EXTENSIONS.contains(&value) || value == "bin"
}

#[allow(dead_code)]
pub(super) fn normalize_source(value: &str) -> Result<String, VaultError> {
    let value = value.trim();
    let mut url = Url::parse(value).map_err(|_| VaultError::InvalidSource)?;
    if value.len() > 2048 || !matches!(url.scheme(), "http" | "https") {
        return Err(VaultError::InvalidSource);
    }
    url.set_fragment(None);
    Ok(url.into())
}

pub(super) fn validate_basename(value: &str) -> Result<(), VaultError> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || value.contains('\0')
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\'])
        || Path::new(value).is_absolute()
    {
        return Err(VaultError::InvalidName);
    }
    Ok(())
}

#[allow(dead_code)]
pub(super) fn media_stem_and_extension(
    source: &str,
    content_type: &str,
) -> Result<(String, String), VaultError> {
    let source = normalize_source(source)?;
    let url = Url::parse(&source).map_err(|_| VaultError::InvalidSource)?;
    let basename = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let (stem, url_extension) = basename
        .rsplit_once('.')
        .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
        .map_or((basename, ""), |(stem, extension)| (stem, extension));
    let url_extension = url_extension.to_ascii_lowercase();
    let extension = if recognized_extension(&url_extension) && url_extension != "bin" {
        url_extension
    } else {
        mime_extension(content_type).to_owned()
    };
    Ok((sanitize_stem(stem), extension))
}
#[allow(dead_code)]
pub(super) fn sanitize_stem(value: &str) -> String {
    let mut value: String = value
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':' | '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
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
        || extension.is_empty()
        || extension.len() > 32
        || !extension.chars().all(|c| c.is_ascii_alphanumeric())
        || !recognized_extension(&extension.to_ascii_lowercase())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_stems_without_splitting_utf8_or_accepting_dot_names() {
        assert_eq!(
            normalize_source("HTTPS://Example.COM:443/a#x").unwrap(),
            "https://example.com/a"
        );
        assert_eq!(sanitize_stem("safe\u{202e}:name"), "safename");
        assert_eq!(sanitize_stem("\u{0000} . \n"), "article");
        let value = sanitize_stem(&"é".repeat(100));
        assert!(value.len() <= 180);
        assert!(std::str::from_utf8(value.as_bytes()).is_ok());
    }

    #[test]
    fn rejects_non_basename_children() {
        for name in [
            "",
            ".",
            "..",
            "../note.md",
            "/note.md",
            "note/name.md",
            "note\\name.md",
            "note\u{0000}.md",
            "note\n.md",
        ] {
            assert!(
                validate_basename(name).is_err(),
                "{name:?} must not be a basename"
            );
        }
        assert!(validate_basename("note.md").is_ok());
    }

    #[test]
    fn derives_stem_and_extension_from_the_media_url_then_mime() {
        assert_eq!(
            media_stem_and_extension(
                "HTTPS://example.test/media/hero.JPEG?download=1#old",
                "image/webp"
            )
            .unwrap(),
            ("hero".to_owned(), "jpeg".to_owned()),
        );
        assert_eq!(
            media_stem_and_extension("https://example.test/media/download", " image/webp ")
                .unwrap(),
            ("download".to_owned(), "webp".to_owned()),
        );
        assert_eq!(
            media_stem_and_extension("https://example.test/", "application/octet-stream").unwrap(),
            ("article".to_owned(), "bin".to_owned()),
        );
    }

    #[test]
    fn preserves_all_browser_recognized_audio_and_video_extensions() {
        for (source, content_type, expected) in [
            (
                "https://example.test/track.aac",
                "application/octet-stream",
                "aac",
            ),
            (
                "https://example.test/track.opus",
                "application/octet-stream",
                "opus",
            ),
            (
                "https://example.test/track.weba",
                "application/octet-stream",
                "weba",
            ),
            (
                "https://example.test/clip.m4v",
                "application/octet-stream",
                "m4v",
            ),
            ("https://example.test/download", "audio/aac", "aac"),
            ("https://example.test/download", "audio/opus", "opus"),
            ("https://example.test/download", "audio/webm", "weba"),
            ("https://example.test/download", "video/x-m4v", "m4v"),
        ] {
            assert_eq!(
                media_stem_and_extension(source, content_type).unwrap().1,
                expected,
                "{source} / {content_type}"
            );
        }
    }

    #[test]
    fn creates_the_required_content_addressed_name() {
        assert_eq!(
            content_addressed_name("hero", "b7c87d380f4e99ff", "webp").unwrap(),
            "hero--b7c87d380f4e.webp"
        );
        assert!(content_addressed_name("hero", "b7c87d380f4e99ff", "").is_err());
        assert!(content_addressed_name("hero", "b7c87d380f4e99ff", &"a".repeat(33)).is_err());
        assert!(content_addressed_name("hero", "b7c87d380f4e99ff", "exe").is_err());
    }
}
