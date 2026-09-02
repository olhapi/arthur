use crate::{
    framing::{FrameDecoder, encode_frame},
    protocol::{ClientMessage, HostMessage, parse_client, unsupported_hello},
    session::SessionManager,
};
use std::io::{self, Read, Write};

const READ_BUFFER_BYTES: usize = 16 * 1024;

pub fn run_native_host<R: Read, W: Write, E: Write>(
    input: R,
    output: W,
    diagnostics: E,
) -> io::Result<()> {
    run_native_host_with_sessions(input, output, diagnostics, SessionManager::new())
}

pub fn run_native_host_with_writer<R: Read, W: Write, E: Write>(
    input: R,
    output: W,
    diagnostics: E,
    writer_id: &str,
) -> io::Result<()> {
    run_native_host_with_sessions(
        input,
        output,
        diagnostics,
        SessionManager::with_writer_id(writer_id),
    )
}

#[cfg(feature = "acceptance-faults")]
pub fn run_native_host_before_note_rename_fault<R: Read, W: Write, E: Write>(
    input: R,
    output: W,
    diagnostics: E,
) -> io::Result<()> {
    run_native_host_with_sessions(
        input,
        output,
        diagnostics,
        SessionManager::with_before_note_rename_fault(),
    )
}

fn run_native_host_with_sessions<R: Read, W: Write, E: Write>(
    mut input: R,
    mut output: W,
    mut diagnostics: E,
    mut sessions: SessionManager,
) -> io::Result<()> {
    let mut decoder = FrameDecoder::new();
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    let result = 'host: loop {
        let read = match input.read(&mut buffer) {
            Ok(read) => read,
            Err(error) => break Err(error),
        };
        if read == 0 {
            match decoder.finish() {
                Ok(()) => break Ok(()),
                Err(_) => break invalid_native_frame(&mut output, &mut diagnostics),
            }
        }
        let values = match decoder.push(&buffer[..read]) {
            Ok(values) => values,
            Err(_) => break invalid_native_frame(&mut output, &mut diagnostics),
        };
        for value in values {
            let response = match parse_client(value.clone()) {
                Ok(message) => sessions.handle(message),
                Err(_) => match unsupported_hello(&value) {
                    Some((request_id, protocol_version)) => sessions.handle(ClientMessage::Hello {
                        request_id,
                        protocol_version,
                    }),
                    None => HostMessage::Error {
                        request_id: None,
                        session_id: None,
                        code: "invalid_message".to_owned(),
                        message: "The native message is invalid.".to_owned(),
                    },
                },
            };
            if let Err(error) = write_response(&mut output, &response) {
                break 'host Err(error);
            }
        }
    };
    sessions.abort_all();
    result
}

fn write_response<W: Write>(output: &mut W, message: &HostMessage) -> io::Result<()> {
    let frame = encode_frame(message)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid host response"))?;
    output.write_all(&frame)?;
    output.flush()
}

fn invalid_native_frame<W: Write, E: Write>(output: &mut W, diagnostics: &mut E) -> io::Result<()> {
    let _ = writeln!(diagnostics, "native message stream rejected");
    let response = HostMessage::Error {
        request_id: None,
        session_id: None,
        code: "invalid_native_frame".to_owned(),
        message: "The native message stream is invalid.".to_owned(),
    };
    write_response(output, &response)?;
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid native frame",
    ))
}
