use super::{
    VaultError, fs,
    names::{normalize_source, validate_basename},
};
use std::fs::File;
use std::os::fd::OwnedFd;

const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;

pub(super) struct ExistingArticle {
    pub name: String,
    pub fingerprint: fs::FileFingerprint,
    pub verified_file: File,
}

fn take_line(value: &str) -> Option<(&str, &str)> {
    let (line, rest) = value.split_once('\n')?;
    Some((line.strip_suffix('\r').unwrap_or(line), rest))
}

fn take_json_field<'a>(value: &'a str, name: &str) -> Option<(String, &'a str)> {
    let (line, rest) = take_line(value)?;
    let field = line.strip_prefix(name)?;
    if !(field.starts_with('"') && field.ends_with('"')) {
        return None;
    }
    serde_json::from_str(field).ok().map(|field| (field, rest))
}

fn source_from_arthur_frontmatter(value: &str) -> Option<String> {
    let (opening, rest) = take_line(value)?;
    if opening != "---" {
        return None;
    }
    let (_, rest) = take_json_field(rest, "title: ")?;
    let (source, rest) = take_json_field(rest, "source: ")?;
    let (closing, rest) = take_line(rest)?;
    if closing != "---" || !(rest.is_empty() || rest.starts_with('\n') || rest.starts_with("\r\n"))
    {
        return None;
    }
    Some(source)
}

#[allow(dead_code)]
pub(super) fn find_existing_article(
    destination: &OwnedFd,
    incoming_source: &str,
) -> Result<Option<ExistingArticle>, VaultError> {
    let incoming_source = normalize_source(incoming_source)?;
    for name in fs::direct_children(destination)? {
        if !name.ends_with(".md") {
            continue;
        }
        let Ok(mut file) = fs::open_regular_file(destination, &name) else {
            continue;
        };
        let Ok(bytes) = fs::read_open_file_prefix(&mut file, MAX_FRONTMATTER_BYTES) else {
            continue;
        };
        let Ok(contents) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let Some(stored_source) = source_from_arthur_frontmatter(contents) else {
            continue;
        };
        if normalize_source(&stored_source).is_ok_and(|source| source == incoming_source) {
            let fingerprint = match fs::fingerprint_open_regular_file(&mut file) {
                Ok(fingerprint) => fingerprint,
                Err(VaultError::UnsafeChild) => return Err(VaultError::SourceConflict),
                Err(error) => return Err(error),
            };
            return Ok(Some(ExistingArticle {
                name,
                fingerprint,
                verified_file: file,
            }));
        }
    }
    Ok(None)
}

pub(super) fn verifies_existing_article_source(
    destination: &OwnedFd,
    existing: &mut ExistingArticle,
    incoming_source: &str,
) -> Result<bool, VaultError> {
    validate_basename(&existing.name)?;
    if !existing.name.ends_with(".md") {
        return Ok(false);
    }
    let incoming_source = normalize_source(incoming_source)?;
    let held_fingerprint = match fs::fingerprint_open_regular_file(&mut existing.verified_file) {
        Ok(fingerprint) => fingerprint,
        Err(VaultError::UnsafeChild) => return Ok(false),
        Err(error) => return Err(error),
    };
    if held_fingerprint != existing.fingerprint {
        return Ok(false);
    }
    let mut file = match fs::open_regular_file(destination, &existing.name) {
        Ok(file) => file,
        Err(VaultError::UnsafeChild | VaultError::Io) => return Ok(false),
        Err(error) => return Err(error),
    };
    let visible_fingerprint = match fs::fingerprint_open_regular_file(&mut file) {
        Ok(fingerprint) => fingerprint,
        Err(VaultError::UnsafeChild) => return Ok(false),
        Err(error) => return Err(error),
    };
    if visible_fingerprint != existing.fingerprint {
        return Ok(false);
    }
    let bytes = fs::read_open_file_prefix(&mut file, MAX_FRONTMATTER_BYTES)?;
    let Ok(contents) = std::str::from_utf8(&bytes) else {
        return Ok(false);
    };
    let Some(stored_source) = source_from_arthur_frontmatter(contents) else {
        return Ok(false);
    };
    Ok(normalize_source(&stored_source).is_ok_and(|source| source == incoming_source))
}
#[allow(dead_code)]
pub(super) fn serialize_note(
    title: &str,
    source: &str,
    markdown: &str,
) -> Result<String, VaultError> {
    if title.is_empty() {
        return Err(VaultError::InvalidName);
    }
    let source = normalize_source(source)?;
    let markdown = markdown.replace("\r\n", "\n").replace('\r', "\n");
    Ok(format!(
        "---\ntitle: {}\nsource: {}\n---\n\n{}",
        serde_json::to_string(title).map_err(|_| VaultError::InvalidName)?,
        serde_json::to_string(&source).map_err(|_| VaultError::InvalidSource)?,
        markdown
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static COUNT: AtomicU64 = AtomicU64::new(0);

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "arthur-frontmatter-{}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn matches_a_direct_regular_arthur_note_after_normalizing_both_sources() {
        let destination = temp();
        let outside = temp();
        fs::write(
            destination.join("article.md"),
            "---\ntitle: \"Article\"\nsource: \"HTTPS://Example.COM:443/a#old\"\n---\n\nBody",
        )
        .unwrap();
        fs::create_dir(destination.join("nested")).unwrap();
        fs::write(
            destination.join("nested/ignored.md"),
            serialize_note("Nested", "https://example.com/a", "Body").unwrap(),
        )
        .unwrap();
        fs::write(
            outside.join("source.md"),
            serialize_note("Linked", "https://example.com/a", "Body").unwrap(),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.join("source.md"), destination.join("linked.md"))
            .unwrap();
        let vault = Vault::open(&destination).unwrap();

        assert_eq!(
            find_existing_article(&vault.destination, "https://example.com/a")
                .unwrap()
                .map(|article| article.name),
            Some("article.md".to_owned())
        );

        drop(vault);
        fs::remove_dir_all(destination).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn matches_a_note_when_its_body_exceeds_the_frontmatter_prefix_bound() {
        let destination = temp();
        let source = "https://example.com/a";
        fs::write(
            destination.join("long-body.md"),
            serialize_note("Article", source, &"x".repeat(MAX_FRONTMATTER_BYTES + 1)).unwrap(),
        )
        .unwrap();
        let vault = Vault::open(&destination).unwrap();

        assert_eq!(
            find_existing_article(&vault.destination, source)
                .unwrap()
                .map(|article| article.name),
            Some("long-body.md".to_owned())
        );

        drop(vault);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn accepts_a_protocol_normalized_long_percent_encoded_source() {
        let raw = format!("https://example.test/{}", "é".repeat(1000));
        assert_eq!(raw.encode_utf16().count(), 1021);
        let normalized = crate::protocol::normalize_source(&raw).unwrap();
        assert!(normalized.len() > 2048);

        let destination = temp();
        fs::write(
            destination.join("long-source.md"),
            serialize_note("Article", &normalized, "Body").unwrap(),
        )
        .unwrap();
        let vault = Vault::open(&destination).unwrap();

        assert_eq!(
            find_existing_article(&vault.destination, &normalized)
                .unwrap()
                .map(|article| article.name),
            Some("long-source.md".to_owned())
        );

        drop(vault);
        fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn serializes_only_a_normalized_http_source() {
        assert_eq!(
            serialize_note("A \"title\"", "https://example.test/a", "Body\n").unwrap(),
            "---\ntitle: \"A \\\"title\\\"\"\nsource: \"https://example.test/a\"\n---\n\nBody\n"
        );
        assert_eq!(
            serialize_note("Article", "HTTPS://Example.COM:443/a#old", "Body").unwrap(),
            "---\ntitle: \"Article\"\nsource: \"https://example.com/a\"\n---\n\nBody"
        );
        assert_eq!(
            serialize_note("Article", "file:///tmp/article", "Body").err(),
            Some(VaultError::InvalidSource)
        );
    }

    #[test]
    fn ignores_nested_symlinked_malformed_non_arthur_and_unbounded_candidates() {
        let destination = temp();
        let outside = temp();
        let source = "https://example.com/a";
        fs::create_dir(destination.join("nested")).unwrap();
        fs::write(
            destination.join("nested/ignored.md"),
            serialize_note("Nested", source, "Body").unwrap(),
        )
        .unwrap();
        fs::write(
            outside.join("source.md"),
            serialize_note("Linked", source, "Body").unwrap(),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.join("source.md"), destination.join("linked.md"))
            .unwrap();
        fs::write(
            destination.join("extra-field.md"),
            "---\ntitle: \"Article\"\nsource: \"https://example.com/a\"\ntags: []\n---\n\nBody",
        )
        .unwrap();
        fs::write(
            destination.join("trailing-space.md"),
            "---\ntitle: \"Article\" \nsource: \"https://example.com/a\"\n---\n\nBody",
        )
        .unwrap();
        fs::write(
            destination.join("not-arthur.md"),
            "source: https://example.com/a",
        )
        .unwrap();
        fs::write(
            destination.join("invalid-source.md"),
            "---\ntitle: \"Article\"\nsource: \"file:///tmp/article\"\n---\n\nBody",
        )
        .unwrap();
        fs::create_dir(destination.join("directory.md")).unwrap();
        fs::write(
            destination.join("too-large.md"),
            format!(
                "---\ntitle: \"{}\"\nsource: \"{source}\"\n---\n\nBody",
                "x".repeat(70_000)
            ),
        )
        .unwrap();
        fs::write(
            destination.join("ignored.markdown"),
            serialize_note("Other", source, "Body").unwrap(),
        )
        .unwrap();
        let vault = Vault::open(&destination).unwrap();

        assert_eq!(
            find_existing_article(&vault.destination, source)
                .unwrap()
                .map(|article| article.name),
            None
        );

        drop(vault);
        fs::remove_dir_all(destination).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
