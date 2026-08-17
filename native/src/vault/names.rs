use super::VaultError;
use sha2::{Digest, Sha256};
use std::path::Path;
use url::Url;

// These are the finite audio/video and core-image lists in
// `src/article/resources.ts`. Keeping this independent of MIME keeps a
// recognized URL suffix intact when a server reports `application/octet-stream`.
const CLASSIFIED_MEDIA_EXTENSIONS: &[&str] = &[
    "aac", "avif", "flac", "gif", "jpeg", "jpg", "m4a", "m4v", "mov", "mp3", "mp4", "ogg", "ogv",
    "opus", "png", "svg", "wav", "weba", "webm", "webp",
];

// The rendered-resource classifier treats an `IMG` source as an image even
// when its suffix is not in its core list. Preserve this deliberately bounded
// set of standard image URL aliases; each family has an explicit MIME fallback
// below. It covers animated PNG, BMP, icons, TIFF, modern image formats, and
// common JPEG/JPEG-2000/SVG aliases without accepting arbitrary suffixes.
const BROWSER_IMAGE_URL_EXTENSIONS: &[&str] = &[
    "apng", "bmp", "cur", "dib", "heic", "heif", "ico", "jfif", "jpe", "jp2", "jpf", "jpm", "jpx",
    "jxl", "pjp", "pjpeg", "svgz", "tif", "tiff",
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
        "image/apng" => "apng",
        "image/avif" => "avif",
        "image/bmp" | "image/x-bmp" | "image/x-ms-bmp" => "bmp",
        "image/gif" => "gif",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/ico" | "image/vnd.microsoft.icon" | "image/x-icon" => "ico",
        "image/jpeg" | "image/pjpeg" => "jpg",
        "image/jp2" | "image/x-jp2" => "jp2",
        "image/jxl" => "jxl",
        "image/png" => "png",
        "image/svg+xml" => "svg",
        "image/tiff" => "tiff",
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
    CLASSIFIED_MEDIA_EXTENSIONS.contains(&value)
        || BROWSER_IMAGE_URL_EXTENSIONS.contains(&value)
        || value == "bin"
}

fn percent_decode_utf8(value: &str) -> Option<String> {
    let mut decoded = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        let hex = |byte: u8| match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        };
        decoded.push((hex(high)? << 4) | hex(low)?);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn media_basename(url: &Url) -> String {
    let basename = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let Some(decoded) = percent_decode_utf8(basename) else {
        return basename.to_owned();
    };
    let Ok(embedded) = Url::parse(&decoded) else {
        return basename.to_owned();
    };
    if !matches!(embedded.scheme(), "http" | "https") {
        return basename.to_owned();
    }
    embedded
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.is_empty())
        .unwrap_or(basename)
        .to_owned()
}

fn is_unicode_format(value: char) -> bool {
    matches!(
        value,
        '\u{00ad}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061c}'
            | '\u{06dd}'
            | '\u{070f}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08e2}'
            | '\u{180e}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206f}'
            | '\u{feff}'
            | '\u{fff9}'..='\u{fffb}'
            | '\u{110bd}'
            | '\u{110cd}'
            | '\u{13430}'..='\u{1343f}'
            | '\u{1bca0}'..='\u{1bca3}'
            | '\u{1d173}'..='\u{1d17a}'
            | '\u{e0001}'
            | '\u{e0020}'..='\u{e007f}'
    )
}

#[allow(dead_code)]
pub(super) fn normalize_source(value: &str) -> Result<String, VaultError> {
    let value = value.trim();
    let mut url = Url::parse(value).map_err(|_| VaultError::InvalidSource)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(VaultError::InvalidSource);
    }
    url.set_fragment(None);
    Ok(url.into())
}

pub(super) fn validate_basename(value: &str) -> Result<(), VaultError> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || value.contains('\0')
        || value
            .chars()
            .any(|character| character.is_control() || is_unicode_format(character))
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
    let basename = media_basename(&url);
    let (stem, url_extension) = basename
        .rsplit_once('.')
        .filter(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
        .map_or((basename.as_str(), ""), |(stem, extension)| (stem, extension));
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
        .filter(|&character| {
            !character.is_control()
                && !is_unicode_format(character)
                && !matches!(character, '/' | '\\' | ':')
        })
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
    fn rejects_and_strips_all_unicode_format_controls() {
        let controls = [
            '\u{00ad}',
            '\u{0600}',
            '\u{0605}',
            '\u{061c}',
            '\u{06dd}',
            '\u{070f}',
            '\u{0890}',
            '\u{0891}',
            '\u{08e2}',
            '\u{180e}',
            '\u{200b}',
            '\u{200c}',
            '\u{200d}',
            '\u{200e}',
            '\u{200f}',
            '\u{202a}',
            '\u{202e}',
            '\u{2060}',
            '\u{2064}',
            '\u{2066}',
            '\u{206f}',
            '\u{feff}',
            '\u{fff9}',
            '\u{fffb}',
            '\u{110bd}',
            '\u{110cd}',
            '\u{13430}',
            '\u{1343f}',
            '\u{1bca0}',
            '\u{1bca3}',
            '\u{1d173}',
            '\u{1d17a}',
            '\u{e0001}',
            '\u{e0020}',
            '\u{e007f}',
        ];
        for control in controls {
            assert_eq!(
                validate_basename(&format!("note{control}.md")).err(),
                Some(VaultError::InvalidName),
                "U+{:04X}",
                control as u32,
            );
        }
        let controls: String = controls.into_iter().collect();
        assert_eq!(sanitize_stem(&format!("safe{controls}name")), "safename");
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
        assert_eq!(
            media_stem_and_extension(
                "https://substackcdn.example.test/image/fetch/format/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F29b750ad-68a7-4f20-ba4b-a2e0973d925e_1600x853.jpeg",
                "image/jpeg",
            )
            .unwrap(),
            (
                "29b750ad-68a7-4f20-ba4b-a2e0973d925e_1600x853".to_owned(),
                "jpeg".to_owned(),
            ),
        );
    }

    #[test]
    fn preserves_every_allowlisted_url_extension_and_uses_explicit_mime_aliases() {
        for (url_extension, expected_extension) in [
            ("aac", "aac"),
            ("apng", "apng"),
            ("avif", "avif"),
            ("bmp", "bmp"),
            ("cur", "cur"),
            ("dib", "dib"),
            ("flac", "flac"),
            ("gif", "gif"),
            ("heic", "heic"),
            ("heif", "heif"),
            ("ico", "ico"),
            ("jfif", "jfif"),
            ("jpe", "jpe"),
            ("jpeg", "jpeg"),
            ("jp2", "jp2"),
            ("jpf", "jpf"),
            ("jpm", "jpm"),
            ("jpx", "jpx"),
            ("jpg", "jpg"),
            ("jxl", "jxl"),
            ("m4a", "m4a"),
            ("m4v", "m4v"),
            ("mov", "mov"),
            ("mp3", "mp3"),
            ("mp4", "mp4"),
            ("ogg", "ogg"),
            ("ogv", "ogv"),
            ("opus", "opus"),
            ("pjp", "pjp"),
            ("pjpeg", "pjpeg"),
            ("png", "png"),
            ("svg", "svg"),
            ("svgz", "svgz"),
            ("tif", "tif"),
            ("tiff", "tiff"),
            ("wav", "wav"),
            ("weba", "weba"),
            ("webm", "webm"),
            ("webp", "webp"),
        ] {
            assert_eq!(
                media_stem_and_extension(
                    &format!("https://example.test/hero.{url_extension}"),
                    "application/octet-stream",
                )
                .unwrap()
                .1,
                expected_extension,
                "URL extension .{url_extension}",
            );
        }
        for (content_type, extension) in [
            ("audio/aac", "aac"),
            ("audio/flac", "flac"),
            ("audio/m4a", "m4a"),
            ("audio/mp4", "m4a"),
            ("audio/mpeg", "mp3"),
            ("audio/ogg", "ogg"),
            ("audio/opus", "opus"),
            ("audio/wav", "wav"),
            ("audio/webm", "weba"),
            ("image/apng", "apng"),
            ("image/avif", "avif"),
            ("image/bmp", "bmp"),
            ("image/x-bmp", "bmp"),
            ("image/x-ms-bmp", "bmp"),
            ("image/gif", "gif"),
            ("image/heic", "heic"),
            ("image/heif", "heif"),
            ("image/ico", "ico"),
            ("image/vnd.microsoft.icon", "ico"),
            ("image/x-icon", "ico"),
            ("image/jpeg", "jpg"),
            ("image/pjpeg", "jpg"),
            ("image/jp2", "jp2"),
            ("image/x-jp2", "jp2"),
            ("image/jxl", "jxl"),
            ("image/png", "png"),
            ("image/svg+xml", "svg"),
            ("image/tiff", "tiff"),
            ("image/webp", "webp"),
            ("video/mp4", "mp4"),
            ("video/ogg", "ogv"),
            ("video/quicktime", "mov"),
            ("video/webm", "webm"),
            ("video/x-m4v", "m4v"),
        ] {
            assert_eq!(
                media_stem_and_extension("https://example.test/download", content_type)
                    .unwrap()
                    .1,
                extension,
                "{content_type}",
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
