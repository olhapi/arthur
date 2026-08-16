pub(crate) fn zod_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || !bytes
            .iter()
            .copied()
            .enumerate()
            .all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                _ => byte.is_ascii_hexdigit(),
            })
    {
        return false;
    }
    if value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
        || value == "00000000-0000-0000-0000-000000000000"
    {
        return true;
    }
    matches!(bytes[14].to_ascii_lowercase(), b'1'..=b'8')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}
