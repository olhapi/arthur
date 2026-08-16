use arthur_native_host::protocol::{parse_client, parse_host};
use serde_json::Value;

#[test]
fn shared_contract_fixtures_match_rust_validation() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../tests/contracts/native-messages.json")).unwrap();
    for message in fixtures["validClientMessages"].as_array().unwrap() {
        assert!(parse_client(message.clone()).is_ok());
    }
    for message in fixtures["invalidClientMessages"].as_array().unwrap() {
        assert!(parse_client(message.clone()).is_err());
    }
    for message in fixtures["validHostMessages"].as_array().unwrap() {
        assert!(parse_host(message.clone()).is_ok());
    }
    for message in fixtures["invalidHostMessages"].as_array().unwrap() {
        assert!(parse_host(message.clone()).is_err());
    }
}
