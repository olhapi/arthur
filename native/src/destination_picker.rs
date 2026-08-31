use std::{path::PathBuf, process::Command};

const PICKER_SCRIPT: &str = r#"
tell current application
    activate
    POSIX path of (choose folder with prompt "Choose Arthur article folder")
end tell
"#;

pub fn choose_destination() -> Result<PathBuf, ()> {
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", PICKER_SCRIPT])
        .output()
        .map_err(|_| ())?;
    if !output.status.success() {
        return Err(());
    }
    let selected = String::from_utf8(output.stdout).map_err(|_| ())?;
    let destination = PathBuf::from(selected.trim());
    if !destination.is_absolute() || !destination.is_dir() {
        return Err(());
    }
    destination.canonicalize().map_err(|_| ())
}
