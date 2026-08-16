mod frontmatter;
mod fs;
mod names;

use rustix::fs::{CWD, FileType, Mode, OFlags, fstat, mkdirat, openat};
use std::{
    os::fd::OwnedFd,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    InvalidDestination,
    NotDirectory,
    NotWritable,
    UnsafeChild,
    InvalidName,
    InvalidSource,
    InvalidTransition,
    MediaLimitExceeded,
    AttachmentConflict,
    UnresolvedPlaceholder,
    Io,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultProbe {
    pub canonical_destination: PathBuf,
    pub writable: bool,
}
#[allow(dead_code)]
pub struct Vault {
    destination: OwnedFd,
    attachments: OwnedFd,
    canonical_destination: PathBuf,
}
impl Vault {
    pub fn open(destination: &Path) -> Result<Self, VaultError> {
        if !destination.is_absolute() {
            return Err(VaultError::InvalidDestination);
        }
        let canonical_destination = destination
            .canonicalize()
            .map_err(|_| VaultError::InvalidDestination)?;
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW;
        let destination = openat(CWD, &canonical_destination, flags, Mode::empty())
            .map_err(|_| VaultError::InvalidDestination)?;
        if !FileType::from_raw_mode(fstat(&destination).map_err(|_| VaultError::Io)?.st_mode)
            .is_dir()
        {
            return Err(VaultError::NotDirectory);
        }
        if let Err(error) = mkdirat(
            &destination,
            "attachments",
            Mode::RUSR | Mode::WUSR | Mode::XUSR,
        ) && error.raw_os_error() != 17
        {
            return Err(VaultError::NotWritable);
        }
        let attachments = openat(&destination, "attachments", flags, Mode::empty())
            .map_err(|_| VaultError::UnsafeChild)?;
        if !FileType::from_raw_mode(fstat(&attachments).map_err(|_| VaultError::Io)?.st_mode)
            .is_dir()
        {
            return Err(VaultError::UnsafeChild);
        }
        Ok(Self {
            destination,
            attachments,
            canonical_destination,
        })
    }
    pub fn probe(destination: &Path) -> Result<VaultProbe, VaultError> {
        let vault = Self::open(destination)?;
        fs::write_probe(&vault.destination)?;
        Ok(VaultProbe {
            canonical_destination: vault.canonical_destination.clone(),
            writable: true,
        })
    }
}
