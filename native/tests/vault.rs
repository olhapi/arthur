use arthur_native_host::vault::{Vault, VaultError};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static COUNT: AtomicU64 = AtomicU64::new(0);
fn temp() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "arthur-vault-{}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&path).unwrap();
    path
}
#[test]
fn probe_is_writable_without_leaving_a_file() {
    let path = temp();
    let probe = Vault::probe(&path).unwrap();
    assert!(probe.writable);
    assert_eq!(fs::read_dir(&path).unwrap().count(), 1);
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn opens_a_root_symlink_and_rejects_symlinked_attachments() {
    let path = temp();
    let link = path.with_extension("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(Vault::open(&link).is_ok());
    fs::remove_dir(path.join("attachments")).unwrap();
    std::os::unix::fs::symlink("/tmp", path.join("attachments")).unwrap();
    assert_eq!(Vault::open(&path).err(), Some(VaultError::UnsafeChild));
    fs::remove_file(link).unwrap();
    fs::remove_dir_all(path).unwrap();
}
