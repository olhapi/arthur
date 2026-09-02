mod frontmatter;
mod fs;
mod names;
mod transaction;
mod workspace;

pub use transaction::{MediaDisposition, MediaSpec, SaveSpec, SavedNote, VaultTransaction};

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
    InvalidChunk,
    MediaLimitExceeded,
    AttachmentConflict,
    SourceConflict,
    UnresolvedPlaceholder,
    Busy,
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
    workspace: workspace::Workspace,
}
impl Vault {
    pub fn open(destination: &Path) -> Result<Self, VaultError> {
        Self::open_for_writer(destination, workspace::DEFAULT_WRITER_ID)
    }

    pub fn open_for_writer(destination: &Path, writer_id: &str) -> Result<Self, VaultError> {
        if !destination.is_absolute() {
            return Err(VaultError::InvalidDestination);
        }
        let canonical_destination = destination
            .canonicalize()
            .map_err(|_| VaultError::InvalidDestination)?;
        if !canonical_destination.is_dir() {
            return Err(VaultError::NotDirectory);
        }
        let destination = fs::open_destination(&canonical_destination)?;
        let attachments = fs::open_or_create_child_directory(&destination, "attachments")?;
        let workspace = workspace::Workspace::open_for_writer(&destination, writer_id)?;
        Ok(Self {
            destination,
            attachments,
            canonical_destination,
            workspace,
        })
    }
    pub fn probe(destination: &Path) -> Result<VaultProbe, VaultError> {
        Self::probe_for_writer(destination, workspace::DEFAULT_WRITER_ID)
    }

    pub fn probe_for_writer(destination: &Path, writer_id: &str) -> Result<VaultProbe, VaultError> {
        let vault = Self::open_for_writer(destination, writer_id)?;
        fs::write_probe(&vault.destination)?;
        Ok(VaultProbe {
            canonical_destination: vault.canonical_destination.clone(),
            writable: true,
        })
    }
    pub fn begin(self, spec: SaveSpec) -> Result<VaultTransaction, VaultError> {
        VaultTransaction::new(self, spec)
    }
}
