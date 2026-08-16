use super::{VaultError, names::validate_basename};
#[cfg(target_os = "macos")]
use rustix::fs::fcntl_fullfsync;
use rustix::fs::{
    AtFlags, CWD, Dir, FileType, FlockOperation, Mode, OFlags, flock, fstat, fsync, mkdirat,
    openat, renameat, statat, unlinkat,
};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use rustix::fs::{RenameFlags, renameat_with};
use rustix::io::Errno;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::OwnedFd,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static COUNTER: AtomicU64 = AtomicU64::new(0);
const REAP_ATTEMPTS: usize = 32;

fn directory_flags() -> OFlags {
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW
}

fn regular_read_flags() -> OFlags {
    OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK
}

fn is_type(fd: &OwnedFd, expected: FileType) -> Result<bool, VaultError> {
    Ok(FileType::from_raw_mode(fstat(fd).map_err(|_| VaultError::Io)?.st_mode) == expected)
}

fn sync_directory(directory: &OwnedFd) -> Result<(), VaultError> {
    if !is_type(directory, FileType::Directory)? {
        return Err(VaultError::Io);
    }
    fsync(directory).map_err(|_| VaultError::Io)
}

pub(super) fn sync_owned_directory(directory: &OwnedFd) -> Result<(), VaultError> {
    sync_directory(directory)
}

pub(super) fn open_destination(path: &Path) -> Result<OwnedFd, VaultError> {
    let directory = openat(CWD, path, directory_flags(), Mode::empty())
        .map_err(|_| VaultError::InvalidDestination)?;
    if !is_type(&directory, FileType::Directory)? {
        return Err(VaultError::NotDirectory);
    }
    match flock(&directory, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => {}
        Err(error) if error == Errno::WOULDBLOCK => return Err(VaultError::Busy),
        Err(_) => return Err(VaultError::Io),
    }
    Ok(directory)
}

pub(super) fn open_or_create_child_directory(
    parent: &OwnedFd,
    name: &str,
) -> Result<OwnedFd, VaultError> {
    validate_basename(name)?;
    let created = match mkdirat(parent, name, Mode::RUSR | Mode::WUSR | Mode::XUSR) {
        Ok(()) => true,
        Err(Errno::EXIST) => false,
        Err(_) => return Err(VaultError::NotWritable),
    };
    let directory = match openat(parent, name, directory_flags(), Mode::empty()) {
        Ok(directory) => directory,
        Err(_) => {
            if created {
                cleanup_new_child_directory(parent, name);
            }
            return Err(VaultError::UnsafeChild);
        }
    };
    let is_directory = match is_type(&directory, FileType::Directory) {
        Ok(is_directory) => is_directory,
        Err(error) => {
            drop(directory);
            if created {
                cleanup_new_child_directory(parent, name);
            }
            return Err(error);
        }
    };
    if !is_directory {
        drop(directory);
        if created {
            cleanup_new_child_directory(parent, name);
        }
        return Err(VaultError::UnsafeChild);
    }
    if created && sync_directory(parent).is_err() {
        drop(directory);
        cleanup_new_child_directory(parent, name);
        return Err(VaultError::Io);
    }
    Ok(directory)
}

pub(super) fn open_child_directory(parent: &OwnedFd, name: &str) -> Result<OwnedFd, VaultError> {
    validate_basename(name)?;
    let directory = openat(parent, name, directory_flags(), Mode::empty())
        .map_err(|_| VaultError::UnsafeChild)?;
    if !is_type(&directory, FileType::Directory)? {
        return Err(VaultError::UnsafeChild);
    }
    Ok(directory)
}

pub(super) fn create_private_child_directory(
    parent: &OwnedFd,
    name: &str,
) -> Result<OwnedFd, VaultError> {
    validate_basename(name)?;
    match mkdirat(parent, name, Mode::RUSR | Mode::WUSR | Mode::XUSR) {
        Ok(()) => {}
        Err(Errno::EXIST) => return Err(VaultError::InvalidTransition),
        Err(_) => return Err(VaultError::Io),
    }
    let directory = match openat(parent, name, directory_flags(), Mode::empty()) {
        Ok(directory) => directory,
        Err(_) => {
            cleanup_new_child_directory(parent, name);
            return Err(VaultError::UnsafeChild);
        }
    };
    if !is_type(&directory, FileType::Directory)? {
        drop(directory);
        cleanup_new_child_directory(parent, name);
        return Err(VaultError::UnsafeChild);
    }
    if sync_directory(parent).is_err() {
        drop(directory);
        cleanup_new_child_directory(parent, name);
        return Err(VaultError::Io);
    }
    Ok(directory)
}

fn cleanup_new_child_directory(parent: &OwnedFd, name: &str) {
    let _ = unlinkat(parent, name, AtFlags::REMOVEDIR);
    let _ = sync_directory(parent);
}

pub(super) fn direct_children(root: &OwnedFd) -> Result<Vec<String>, VaultError> {
    let directory = Dir::read_from(root).map_err(|_| VaultError::Io)?;
    let mut names = Vec::new();
    for entry in directory {
        let entry = entry.map_err(|_| VaultError::Io)?;
        if let Ok(name) = entry.file_name().to_str()
            && !matches!(name, "." | "..")
            && validate_basename(name).is_ok()
        {
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

pub(super) fn sync_file(file: &File) -> Result<(), VaultError> {
    durable_sync(file)
}

pub(super) fn create_exclusive_file(root: &OwnedFd, name: &str) -> Result<File, VaultError> {
    validate_basename(name)?;
    let fd = openat(
        root,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::RUSR | Mode::WUSR,
    )
    .map_err(|error| match error {
        Errno::EXIST => VaultError::AttachmentConflict,
        _ => VaultError::Io,
    })?;
    Ok(File::from(fd))
}

#[allow(dead_code)]
pub(super) fn create_exclusive_and_sync(
    root: &OwnedFd,
    name: &str,
    bytes: &[u8],
) -> Result<(), VaultError> {
    create_exclusive_and_sync_with_writer(root, name, bytes, |file, bytes| file.write_all(bytes))
}

fn create_exclusive_and_sync_with_writer<F>(
    root: &OwnedFd,
    name: &str,
    bytes: &[u8],
    writer: F,
) -> Result<(), VaultError>
where
    F: FnOnce(&mut File, &[u8]) -> std::io::Result<()>,
{
    validate_basename(name)?;
    let mut file = create_exclusive_file(root, name)?;
    let result = writer(&mut file, bytes)
        .map_err(|_| VaultError::Io)
        .and_then(|()| durable_sync(&file));
    drop(file);
    let result = result.and_then(|()| sync_directory(root));
    if result.is_err() {
        let _ = unlinkat(root, name, AtFlags::empty());
        let _ = sync_directory(root);
    }
    result
}

#[allow(dead_code)]
pub(super) fn rename_replace(root: &OwnedFd, from: &str, to: &str) -> Result<(), VaultError> {
    validate_basename(from)?;
    validate_basename(to)?;
    renameat(root, from, root, to).map_err(|_| VaultError::Io)?;
    sync_directory(root)
}

fn rename_no_replace_unsynced(root: &OwnedFd, from: &str, to: &str) -> Result<(), VaultError> {
    validate_basename(from)?;
    validate_basename(to)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        match renameat_with(root, from, root, to, RenameFlags::NOREPLACE) {
            Ok(()) => Ok(()),
            Err(Errno::EXIST) => Err(VaultError::AttachmentConflict),
            Err(_) => Err(VaultError::Io),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err(VaultError::Io)
}

#[allow(dead_code)]
pub(super) fn rename_no_replace(root: &OwnedFd, from: &str, to: &str) -> Result<(), VaultError> {
    rename_no_replace_unsynced(root, from, to)?;
    sync_directory(root)
}

pub(super) fn rename_replace_between(
    from_root: &OwnedFd,
    from: &str,
    to_root: &OwnedFd,
    to: &str,
) -> Result<(), VaultError> {
    validate_basename(from)?;
    validate_basename(to)?;
    renameat(from_root, from, to_root, to).map_err(|_| VaultError::Io)?;
    sync_directory(from_root)?;
    sync_directory(to_root)
}

pub(super) fn rename_no_replace_between(
    from_root: &OwnedFd,
    from: &str,
    to_root: &OwnedFd,
    to: &str,
) -> Result<(), VaultError> {
    validate_basename(from)?;
    validate_basename(to)?;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        match renameat_with(from_root, from, to_root, to, RenameFlags::NOREPLACE) {
            Ok(()) => {
                sync_directory(from_root)?;
                sync_directory(to_root)
            }
            Err(Errno::EXIST) => Err(VaultError::AttachmentConflict),
            Err(_) => Err(VaultError::Io),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    Err(VaultError::Io)
}

#[allow(dead_code)]
pub(super) fn remove_child(root: &OwnedFd, name: &str) -> Result<(), VaultError> {
    validate_basename(name)?;
    unlinkat(root, name, AtFlags::empty()).map_err(|_| VaultError::Io)?;
    sync_directory(root)
}

#[allow(dead_code)]
pub(super) fn remove_empty_child_directory(root: &OwnedFd, name: &str) -> Result<(), VaultError> {
    validate_basename(name)?;
    unlinkat(root, name, AtFlags::REMOVEDIR).map_err(|_| VaultError::Io)?;
    sync_directory(root)
}

pub(super) fn remove_tree_no_follow(root: &OwnedFd, name: &str) -> Result<(), VaultError> {
    validate_basename(name)?;
    let metadata = statat(root, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| VaultError::Io)?;
    if FileType::from_raw_mode(metadata.st_mode) != FileType::Directory {
        unlinkat(root, name, AtFlags::empty()).map_err(|_| VaultError::Io)?;
        return sync_directory(root);
    }
    let directory = openat(root, name, directory_flags(), Mode::empty())
        .map_err(|_| VaultError::UnsafeChild)?;
    for child in direct_children(&directory)? {
        remove_tree_no_follow(&directory, &child)?;
    }
    drop(directory);
    unlinkat(root, name, AtFlags::REMOVEDIR).map_err(|_| VaultError::Io)?;
    sync_directory(root)
}

pub(super) fn child_exists(root: &OwnedFd, name: &str) -> Result<bool, VaultError> {
    validate_basename(name)?;
    match statat(root, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => Ok(true),
        Err(Errno::NOENT) => Ok(false),
        Err(_) => Err(VaultError::Io),
    }
}

pub(super) fn child_directory_matches(
    root: &OwnedFd,
    name: &str,
    expected: &OwnedFd,
) -> Result<bool, VaultError> {
    validate_basename(name)?;
    let current = openat(root, name, directory_flags(), Mode::empty())
        .map_err(|_| VaultError::UnsafeChild)?;
    let matches = match (fstat(&current), fstat(expected)) {
        (Ok(current), Ok(expected)) => {
            FileType::from_raw_mode(current.st_mode) == FileType::Directory
                && current.st_dev == expected.st_dev
                && current.st_ino == expected.st_ino
        }
        _ => return Err(VaultError::Io),
    };
    Ok(matches)
}

/// Removes an empty child directory only after moving it into an internal
/// reaper name and comparing that entry with the held directory descriptor.
/// The caller's public child name is never passed directly to `unlinkat`, so a
/// path swap before the move is restored rather than deleted.
pub(super) fn remove_owned_empty_child_directory(
    root: &OwnedFd,
    name: &str,
    expected: &OwnedFd,
) -> Result<bool, VaultError> {
    let Some(reap_name) = move_child_to_reaper(root, name)? else {
        return Ok(false);
    };

    match child_directory_matches(root, &reap_name, expected) {
        Ok(true) => {
            // Revalidate immediately before the final removal. The reaper name
            // is minted internally while the destination's exclusive lock is
            // held; a crash leaves a recognized reaper for the next open.
            if !child_directory_matches(root, &reap_name, expected)? {
                restore_reaper(root, &reap_name, name);
                return Ok(false);
            }
            remove_empty_child_directory(root, &reap_name)?;
            Ok(true)
        }
        Ok(false) | Err(VaultError::UnsafeChild) => {
            // A concurrent replacement was moved, not removed. Restore it
            // without replacement when its original entry is still vacant.
            restore_reaper(root, &reap_name, name);
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

/// Reclaims an Arthur-owned stale stage or reaper entry. The source path is
/// first moved to an internal reaper name, so destructive cleanup never acts
/// through the externally visible stage pathname.
pub(super) fn remove_stale_child_no_follow(root: &OwnedFd, name: &str) -> Result<(), VaultError> {
    let Some(reap_name) = move_child_to_reaper(root, name)? else {
        return Ok(());
    };
    let metadata =
        statat(root, &reap_name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| VaultError::Io)?;
    if FileType::from_raw_mode(metadata.st_mode) == FileType::Directory {
        let directory = open_child_directory(root, &reap_name)?;
        for child in direct_children(&directory)? {
            remove_tree_no_follow(&directory, &child)?;
        }
        drop(directory);
        remove_empty_child_directory(root, &reap_name)
    } else {
        unlinkat(root, &reap_name, AtFlags::empty()).map_err(|_| VaultError::Io)?;
        sync_directory(root)
    }
}

fn move_child_to_reaper(root: &OwnedFd, name: &str) -> Result<Option<String>, VaultError> {
    validate_basename(name)?;
    for _ in 0..REAP_ATTEMPTS {
        let reap_name = reaper_name()?;
        match rename_no_replace_unsynced(root, name, &reap_name) {
            Ok(()) => return Ok(Some(reap_name)),
            Err(VaultError::AttachmentConflict) => continue,
            Err(error) => match child_exists(root, name) {
                Ok(false) => return Ok(None),
                Ok(true) | Err(_) => return Err(error),
            },
        }
    }
    Err(VaultError::Io)
}

fn reaper_name() -> Result<String, VaultError> {
    let mut entropy = [0u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut entropy))
        .map_err(|_| VaultError::Io)?;
    Ok(format!(
        ".arthur-reap-{}",
        entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn restore_reaper(root: &OwnedFd, reap_name: &str, name: &str) {
    let _ = rename_no_replace_unsynced(root, reap_name, name);
    let _ = sync_directory(root);
}

pub(super) fn hash_regular_file(root: &OwnedFd, name: &str) -> Result<String, VaultError> {
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
    let mut file = File::from(fd);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| VaultError::Io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
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
    let create_synced = sync_directory(root).is_ok();
    let removed = unlinkat(root, &name, AtFlags::empty()).is_ok();
    let removal_synced = removed && sync_directory(root).is_ok();
    if create_synced && removal_synced {
        Ok(())
    } else {
        Err(VaultError::NotWritable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "arthur-vault-fs-{}-{}",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn candidate_regular_file_opens_are_nonblocking() {
        assert!(regular_read_flags().contains(OFlags::NONBLOCK));
    }

    #[test]
    fn synchronizes_an_owned_directory_descriptor() {
        let path = temp();
        let root = open_destination(&path).unwrap();

        assert_eq!(sync_directory(&root), Ok(()));

        drop(root);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn creates_exclusively_and_cleans_up_after_a_write_failure() {
        let path = temp();
        let root = open_destination(&path).unwrap();

        create_exclusive_and_sync(&root, "article.md", b"first").unwrap();
        assert_eq!(fs::read(path.join("article.md")).unwrap(), b"first");
        assert_eq!(
            create_exclusive_and_sync(&root, "article.md", b"second").err(),
            Some(VaultError::AttachmentConflict)
        );
        assert_eq!(fs::read(path.join("article.md")).unwrap(), b"first");

        assert_eq!(
            create_exclusive_and_sync_with_writer(
                &root,
                "partial.md",
                b"ignored",
                |file, _| -> std::io::Result<()> {
                    file.write_all(b"partial")?;
                    Err(std::io::Error::other("injected write failure"))
                },
            ),
            Err(VaultError::Io)
        );
        assert!(!path.join("partial.md").exists());

        drop(root);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn renames_with_replace_and_no_replace_semantics() {
        let path = temp();
        let root = open_destination(&path).unwrap();

        create_exclusive_and_sync(&root, "replace-source.md", b"new").unwrap();
        create_exclusive_and_sync(&root, "replace-destination.md", b"old").unwrap();
        rename_replace(&root, "replace-source.md", "replace-destination.md").unwrap();
        assert!(!path.join("replace-source.md").exists());
        assert_eq!(
            fs::read(path.join("replace-destination.md")).unwrap(),
            b"new"
        );

        create_exclusive_and_sync(&root, "move-source.md", b"move").unwrap();
        rename_no_replace(&root, "move-source.md", "move-destination.md").unwrap();
        assert!(!path.join("move-source.md").exists());
        assert_eq!(fs::read(path.join("move-destination.md")).unwrap(), b"move");

        create_exclusive_and_sync(&root, "conflict-source.md", b"source").unwrap();
        create_exclusive_and_sync(&root, "conflict-destination.md", b"destination").unwrap();
        assert_eq!(
            rename_no_replace(&root, "conflict-source.md", "conflict-destination.md"),
            Err(VaultError::AttachmentConflict)
        );
        assert_eq!(
            fs::read(path.join("conflict-source.md")).unwrap(),
            b"source"
        );
        assert_eq!(
            fs::read(path.join("conflict-destination.md")).unwrap(),
            b"destination"
        );

        assert_eq!(
            rename_no_replace(&root, "missing-source.md", "missing-destination.md"),
            Err(VaultError::Io)
        );

        drop(root);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn removes_files_and_only_empty_child_directories() {
        let path = temp();
        let root = open_destination(&path).unwrap();

        create_exclusive_and_sync(&root, "remove.md", b"remove").unwrap();
        remove_child(&root, "remove.md").unwrap();
        assert!(!path.join("remove.md").exists());

        let empty = open_or_create_child_directory(&root, "empty").unwrap();
        drop(empty);
        remove_empty_child_directory(&root, "empty").unwrap();
        assert!(!path.join("empty").exists());

        let nonempty = open_or_create_child_directory(&root, "nonempty").unwrap();
        create_exclusive_and_sync(&nonempty, "child.md", b"child").unwrap();
        drop(nonempty);
        assert_eq!(
            remove_empty_child_directory(&root, "nonempty"),
            Err(VaultError::Io)
        );
        assert_eq!(fs::read(path.join("nonempty/child.md")).unwrap(), b"child");

        write_probe(&root).unwrap();
        assert_eq!(fs::read_dir(&path).unwrap().count(), 1);

        drop(root);
        fs::remove_dir_all(path).unwrap();
    }
}
