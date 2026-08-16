use super::{VaultError, names::validate_basename};
#[cfg(target_os = "macos")]
use rustix::fs::fcntl_fullfsync;
use rustix::fs::{
    AtFlags, CWD, Dir, FileType, Mode, OFlags, fstat, fsync, mkdirat, openat, renameat, statat,
    unlinkat,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use rustix::fs::{RenameFlags, renameat_with};
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::OwnedFd,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn directory_flags() -> OFlags {
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW
}

fn regular_read_flags() -> OFlags {
    OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK
}

fn is_type(fd: &OwnedFd, expected: FileType) -> Result<bool, VaultError> {
    Ok(FileType::from_raw_mode(fstat(fd).map_err(|_| VaultError::Io)?.st_mode) == expected)
}

pub(super) fn open_destination(path: &Path) -> Result<OwnedFd, VaultError> {
    let directory = openat(CWD, path, directory_flags(), Mode::empty())
        .map_err(|_| VaultError::InvalidDestination)?;
    if !is_type(&directory, FileType::Directory)? {
        return Err(VaultError::NotDirectory);
    }
    Ok(directory)
}

pub(super) fn open_or_create_child_directory(
    parent: &OwnedFd,
    name: &str,
) -> Result<OwnedFd, VaultError> {
    validate_basename(name)?;
    if let Err(error) = mkdirat(parent, name, Mode::RUSR | Mode::WUSR | Mode::XUSR)
        && error.raw_os_error() != 17
    {
        return Err(VaultError::NotWritable);
    }
    let directory = openat(parent, name, directory_flags(), Mode::empty())
        .map_err(|_| VaultError::UnsafeChild)?;
    if !is_type(&directory, FileType::Directory)? {
        return Err(VaultError::UnsafeChild);
    }
    Ok(directory)
}

pub(super) fn direct_children(root: &OwnedFd) -> Result<Vec<String>, VaultError> {
    let directory = Dir::read_from(root).map_err(|_| VaultError::Io)?;
    let mut names = Vec::new();
    for entry in directory {
        let entry = entry.map_err(|_| VaultError::Io)?;
        if let Ok(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

pub(super) fn read_regular_prefix(
    root: &OwnedFd,
    name: &str,
    maximum_bytes: usize,
) -> Result<Option<Vec<u8>>, VaultError> {
    validate_basename(name)?;
    let initial = statat(root, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| VaultError::Io)?;
    if FileType::from_raw_mode(initial.st_mode) != FileType::RegularFile {
        return Err(VaultError::UnsafeChild);
    }
    let fd = openat(root, name, regular_read_flags(), Mode::empty())
        .map_err(|_| VaultError::UnsafeChild)?;
    if !is_type(&fd, FileType::RegularFile)? {
        return Err(VaultError::UnsafeChild);
    }
    let file = File::from(fd);
    let mut bytes = Vec::new();
    file.take(maximum_bytes as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| VaultError::Io)?;
    Ok(Some(bytes))
}

fn durable_sync(file: &File) -> Result<(), VaultError> {
    fsync(file).map_err(|_| VaultError::Io)?;
    #[cfg(target_os = "macos")]
    fcntl_fullfsync(file).map_err(|_| VaultError::Io)?;
    Ok(())
}

#[allow(dead_code)]
pub(super) fn create_exclusive_and_sync(
    root: &OwnedFd,
    name: &str,
    bytes: &[u8],
) -> Result<(), VaultError> {
    validate_basename(name)?;
    let fd = openat(
        root,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|_| VaultError::AttachmentConflict)?;
    let mut file = File::from(fd);
    let result = file
        .write_all(bytes)
        .map_err(|_| VaultError::Io)
        .and_then(|()| durable_sync(&file));
    drop(file);
    if result.is_err() {
        let _ = unlinkat(root, name, AtFlags::empty());
    }
    result
}

#[allow(dead_code)]
pub(super) fn rename_replace(root: &OwnedFd, from: &str, to: &str) -> Result<(), VaultError> {
    validate_basename(from)?;
    validate_basename(to)?;
    renameat(root, from, root, to).map_err(|_| VaultError::Io)
}

#[allow(dead_code)]
pub(super) fn rename_no_replace(root: &OwnedFd, from: &str, to: &str) -> Result<(), VaultError> {
    validate_basename(from)?;
    validate_basename(to)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        renameat_with(root, from, root, to, RenameFlags::NOREPLACE)
            .map_err(|_| VaultError::AttachmentConflict)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err(VaultError::AttachmentConflict)
}

#[allow(dead_code)]
pub(super) fn remove_child(root: &OwnedFd, name: &str) -> Result<(), VaultError> {
    validate_basename(name)?;
    unlinkat(root, name, AtFlags::empty()).map_err(|_| VaultError::Io)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_regular_file_opens_are_nonblocking() {
        assert!(regular_read_flags().contains(OFlags::NONBLOCK));
    }
}
