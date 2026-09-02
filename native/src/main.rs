fn main() {
    let Some(writer_id) = writer_id() else {
        std::process::exit(1);
    };
    let result = {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        let stderr = std::io::stderr();
        arthur_native_host::run_native_host_with_writer(
            stdin.lock(),
            stdout.lock(),
            stderr.lock(),
            &writer_id,
        )
    };
    if result.is_err() {
        std::process::exit(1);
    }
}

fn writer_id() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path =
        std::path::PathBuf::from(home).join("Library/Application Support/Arthur/state/writer-id");
    let value = std::fs::read_to_string(path).ok()?;
    let candidate = value.strip_suffix('\n')?;
    let bytes = candidate.as_bytes();
    let valid = bytes.len() == 36
        && [8, 13, 18, 23]
            .into_iter()
            .all(|index| bytes[index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            [8, 13, 18, 23].contains(&index)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b');
    valid.then(|| candidate.to_owned())
}
