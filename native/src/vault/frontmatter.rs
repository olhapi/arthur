use super::VaultError;
#[allow(dead_code)]
pub(super) fn serialize_note(
    title: &str,
    source: &str,
    markdown: &str,
) -> Result<String, VaultError> {
    if title.is_empty() || source.is_empty() {
        return Err(VaultError::InvalidName);
    }
    Ok(format!(
        "---\ntitle: {}\nsource: {}\n---\n\n{}",
        serde_json::to_string(title).map_err(|_| VaultError::InvalidName)?,
        serde_json::to_string(source).map_err(|_| VaultError::InvalidSource)?,
        markdown
    ))
}
