fn main() {
    let result = {
        let stdin = std::io::stdin();
        let stdout = std::io::stdout();
        let stderr = std::io::stderr();
        arthur_native_host::run_native_host_before_note_rename_fault(
            stdin.lock(),
            stdout.lock(),
            stderr.lock(),
        )
    };
    if result.is_err() {
        std::process::exit(1);
    }
}
