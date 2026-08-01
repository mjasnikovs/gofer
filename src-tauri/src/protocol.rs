use serde::Serialize;
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;
pub const SUPPORTED_PROTOCOL_VERSIONS: [u64; 1] = [PROTOCOL_VERSION];

#[derive(Clone, Copy, Debug)]
pub enum EnvelopeKind {
    Request,
    Response,
    Event,
    Error,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
    pub details: ProtocolErrorDetails,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolErrorDetails {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub supported_versions: Vec<u64>,
}

impl ProtocolError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_protocol_payload",
            message: message.into(),
            details: ProtocolErrorDetails {
                supported_versions: Vec::new(),
            },
        }
    }

    fn unsupported(version: u64) -> Self {
        Self {
            code: "unsupported_protocol_version",
            message: format!("Protocol version {version} is not supported"),
            details: ProtocolErrorDetails {
                supported_versions: SUPPORTED_PROTOCOL_VERSIONS.to_vec(),
            },
        }
    }
}

// coverage-critical-start: protocol
pub fn validate_envelope(payload: &Value, kind: EnvelopeKind) -> Result<(), ProtocolError> {
    let object = payload
        .as_object()
        .ok_or_else(|| ProtocolError::invalid("The top-level payload must be an object"))?;
    let version = positive_integer(object.get("protocolVersion"), "protocolVersion")?;
    non_empty_string(object.get("id"), "id")?;

    match kind {
        EnvelopeKind::Request => {
            non_empty_string(object.get("command"), "command")?;
            object_value(object.get("params"), "params")?;
        }
        EnvelopeKind::Response => {
            if !object.contains_key("result") {
                return Err(ProtocolError::invalid("result is required"));
            }
        }
        EnvelopeKind::Event => {
            non_negative_integer(object.get("sequence"), "sequence")?;
            non_empty_string(object.get("event"), "event")?;
            object_value(object.get("data"), "data")?;
        }
        EnvelopeKind::Error => validate_error(object.get("error"))?,
    }

    if !SUPPORTED_PROTOCOL_VERSIONS.contains(&version) {
        return Err(ProtocolError::unsupported(version));
    }
    Ok(())
}

fn validate_error(value: Option<&Value>) -> Result<(), ProtocolError> {
    let error = value
        .and_then(Value::as_object)
        .ok_or_else(|| ProtocolError::invalid("error must be an object"))?;
    let code = non_empty_string(error.get("code"), "error.code")?;
    if !is_error_code(code) {
        return Err(ProtocolError::invalid(
            "error.code must contain lowercase letters, numbers, or underscores",
        ));
    }
    non_empty_string(error.get("message"), "error.message")?;
    object_value(error.get("details"), "error.details")
}

fn is_error_code(code: &str) -> bool {
    let mut characters = code.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn positive_integer(value: Option<&Value>, name: &str) -> Result<u64, ProtocolError> {
    let integer = value
        .and_then(Value::as_u64)
        .ok_or_else(|| ProtocolError::invalid(format!("{name} must be an integer")))?;
    if integer == 0 {
        return Err(ProtocolError::invalid(format!("{name} must be positive")));
    }
    Ok(integer)
}

fn non_negative_integer(value: Option<&Value>, name: &str) -> Result<u64, ProtocolError> {
    value
        .and_then(Value::as_u64)
        .ok_or_else(|| ProtocolError::invalid(format!("{name} must be a non-negative integer")))
}

fn non_empty_string<'a>(value: Option<&'a Value>, name: &str) -> Result<&'a str, ProtocolError> {
    let string = value
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::invalid(format!("{name} must be a string")))?;
    if string.is_empty() {
        return Err(ProtocolError::invalid(format!("{name} must not be empty")));
    }
    Ok(string)
}

fn object_value(value: Option<&Value>, name: &str) -> Result<(), ProtocolError> {
    if value.is_some_and(Value::is_object) {
        return Ok(());
    }
    Err(ProtocolError::invalid(format!("{name} must be an object")))
}
// coverage-critical-end: protocol

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;

    fn fixtures(kind: &str) -> Vec<PathBuf> {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/fixtures")
            .join(kind);
        let mut paths: Vec<_> = fs::read_dir(directory)
            .expect("read protocol fixture directory")
            .map(|entry| entry.expect("read fixture entry").path())
            .collect();
        paths.sort();
        paths
    }

    fn fixture(path: &Path) -> (EnvelopeKind, Value) {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .expect("fixture filename");
        let kind = match name.split('-').next() {
            Some("request") => EnvelopeKind::Request,
            Some("response") => EnvelopeKind::Response,
            Some("event") => EnvelopeKind::Event,
            Some("error") => EnvelopeKind::Error,
            _ => panic!("unknown fixture kind: {name}"),
        };
        let value = serde_json::from_slice(&fs::read(path).expect("read fixture"))
            .expect("parse fixture JSON");
        (kind, value)
    }

    #[test]
    fn accepts_every_valid_golden_fixture() {
        for path in fixtures("valid") {
            let (kind, value) = fixture(&path);
            assert_eq!(
                validate_envelope(&value, kind),
                Ok(()),
                "{}",
                path.display()
            );
        }
    }

    #[test]
    fn rejects_every_invalid_golden_fixture() {
        for path in fixtures("invalid") {
            let (kind, value) = fixture(&path);
            let error = validate_envelope(&value, kind).expect_err("fixture must be invalid");
            assert_eq!(error.code, "invalid_protocol_payload", "{}", path.display());
        }
    }

    #[test]
    fn rejects_unsupported_versions_with_supported_versions() {
        let path = fixtures("unsupported").pop().expect("unsupported fixture");
        let (kind, value) = fixture(&path);
        assert_eq!(
            validate_envelope(&value, kind),
            Err(ProtocolError {
                code: "unsupported_protocol_version",
                message: "Protocol version 2 is not supported".to_owned(),
                details: ProtocolErrorDetails {
                    supported_versions: vec![1]
                },
            })
        );
    }

    #[test]
    fn readers_ignore_unknown_optional_fields() {
        let path = fixtures("valid")
            .into_iter()
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("request"))
            })
            .expect("request fixture");
        let (_, mut value) = fixture(&path);
        value["futureOptionalField"] = serde_json::json!({"nested": true});
        assert_eq!(validate_envelope(&value, EnvelopeKind::Request), Ok(()));
    }

    #[test]
    fn primitive_protocol_validators_cover_every_branch() {
        assert!(is_error_code("valid_2"));
        assert!(!is_error_code(""));
        assert!(!is_error_code("Invalid"));
        assert!(!is_error_code("invalid-code"));
        assert!(positive_integer(Some(&serde_json::json!(0)), "version").is_err());
        assert!(non_empty_string(Some(&serde_json::json!("")), "id").is_err());
        assert!(object_value(Some(&serde_json::json!({})), "data").is_ok());
        assert!(object_value(None, "data").is_err());
        assert!(
            validate_envelope(
                &serde_json::json!({"protocolVersion": 1, "id": "response"}),
                EnvelopeKind::Response,
            )
            .is_err()
        );
    }
}
