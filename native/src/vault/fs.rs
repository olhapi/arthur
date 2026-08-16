use super::VaultError;
use rustix::fs::{AtFlags, Mode, OFlags, openat, unlinkat};
use std::{
    os::fd::OwnedFd,
    sync::atomic::{AtomicU64, Ordering},
};
static COUNTER: AtomicU64 = AtomicU64::new(0);
pub(super) fn write_probe(root: &OwnedFd) -> Result<(), VaultError> {
    let name = format!(
        ".arthur-probe-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let file = openat(
        root,
        &name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|_| VaultError::NotWritable)?;
    drop(file);
    unlinkat(root, &name, AtFlags::empty()).map_err(|_| VaultError::NotWritable)
}
