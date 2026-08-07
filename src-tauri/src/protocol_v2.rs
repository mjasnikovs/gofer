//! Protocol version 2: the persistent, authenticated editor session contract.
//!
//! `protocol/README.md` is the frozen specification and `protocol/fixtures/v2` the golden payloads
//! this module, the TypeScript client, and the Godot addon must agree on.

use serde::Serialize;
use serde_json::{Map, Value, json};

pub const PROTOCOL_VERSION: u64 = 2;
pub const SUPPORTED_PROTOCOL_VERSIONS: [u64; 1] = [PROTOCOL_VERSION];

pub const MAX_ENVELOPE_BYTES: usize = 1024 * 1024;
pub const MAX_IMAGE_ENVELOPE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_IMAGE_EDGE_PIXELS: u64 = 1920;
pub const MAX_ID_LENGTH: usize = 128;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const IMAGE_ENCODING: &str = "png-base64";
pub const SESSION_TOKEN_LENGTH: usize = 64;

pub const DOMAINS: [&str; 12] = [
    "session", "scene", "node", "project", "editor", "resource", "script", "debug", "runtime",
    "logs", "files", "docs",
];

pub const MUTATING_COMMANDS: [&str; 17] = [
    "session.undo",
    "session.redo",
    "scene.create",
    "scene.save",
    "scene.save_as",
    "scene.reload",
    "node.create",
    "node.instantiate",
    "node.duplicate",
    "node.rename",
    "node.reparent",
    "node.delete",
    "node.set_property",
    "node.add_to_group",
    "node.remove_from_group",
    "node.connect_signal",
    "node.disconnect_signal",
];

struct NumericValue {
    kind: &'static str,
    arity: usize,
    integral: bool,
}

const NUMERIC_VALUES: [NumericValue; 14] = [
    NumericValue {
        kind: "vector2",
        arity: 2,
        integral: false,
    },
    NumericValue {
        kind: "vector2i",
        arity: 2,
        integral: true,
    },
    NumericValue {
        kind: "vector3",
        arity: 3,
        integral: false,
    },
    NumericValue {
        kind: "vector3i",
        arity: 3,
        integral: true,
    },
    NumericValue {
        kind: "vector4",
        arity: 4,
        integral: false,
    },
    NumericValue {
        kind: "vector4i",
        arity: 4,
        integral: true,
    },
    NumericValue {
        kind: "quaternion",
        arity: 4,
        integral: false,
    },
    NumericValue {
        kind: "color",
        arity: 4,
        integral: false,
    },
    NumericValue {
        kind: "plane",
        arity: 4,
        integral: false,
    },
    NumericValue {
        kind: "rect2",
        arity: 4,
        integral: false,
    },
    NumericValue {
        kind: "rect2i",
        arity: 4,
        integral: true,
    },
    NumericValue {
        kind: "transform2d",
        arity: 6,
        integral: false,
    },
    NumericValue {
        kind: "basis",
        arity: 9,
        integral: false,
    },
    NumericValue {
        kind: "transform3d",
        arity: 12,
        integral: false,
    },
];

struct ObjectValue {
    kind: &'static str,
    required_strings: &'static [&'static str],
    optional_strings: &'static [&'static str],
    required_integers: &'static [&'static str],
    optional_integers: &'static [&'static str],
}

const OBJECT_VALUES: [ObjectValue; 4] = [
    ObjectValue {
        kind: "resource",
        required_strings: &["path", "resourceType"],
        optional_strings: &["uid"],
        required_integers: &[],
        optional_integers: &[],
    },
    ObjectValue {
        kind: "node",
        required_strings: &["path", "nodeType"],
        optional_strings: &[],
        required_integers: &[],
        optional_integers: &["instanceId"],
    },
    ObjectValue {
        kind: "object",
        required_strings: &["className"],
        optional_strings: &[],
        required_integers: &["instanceId"],
        optional_integers: &[],
    },
    ObjectValue {
        kind: "opaque",
        required_strings: &["typeName", "text"],
        optional_strings: &[],
        required_integers: &[],
        optional_integers: &[],
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvelopeKind {
    Handshake,
    Request,
    Response,
    Event,
    Error,
}

impl EnvelopeKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Handshake => "handshake",
            Self::Request => "request",
            Self::Response => "response",
            Self::Event => "event",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Readiness {
    Ready,
    Starting,
    Importing,
    Unavailable,
}

impl Readiness {
    pub(crate) fn parse(readiness: &str) -> Option<Self> {
        match readiness {
            "ready" => Some(Self::Ready),
            "starting" => Some(Self::Starting),
            "importing" => Some(Self::Importing),
            "unavailable" => Some(Self::Unavailable),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub readiness: Readiness,
    pub details: Value,
}

impl ProtocolError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_protocol_payload",
            message: message.into(),
            retryable: false,
            readiness: Readiness::Ready,
            details: json!({}),
        }
    }

    fn unsupported(version: u64) -> Self {
        Self {
            code: "unsupported_protocol_version",
            message: format!("Protocol version {version} is not supported"),
            retryable: false,
            readiness: Readiness::Unavailable,
            details: json!({"supportedVersions": SUPPORTED_PROTOCOL_VERSIONS}),
        }
    }

    fn too_large(actual: usize, limit: usize) -> Self {
        Self {
            code: "payload_too_large",
            message: format!("The envelope is {actual} bytes and the limit is {limit} bytes"),
            retryable: false,
            readiness: Readiness::Ready,
            details: json!({"actualBytes": actual, "limitBytes": limit}),
        }
    }

    /// Renders the error as the envelope a receiver sends back for `id`.
    pub fn to_envelope(&self, id: &str) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": EnvelopeKind::Error.name(),
            "id": id,
            "error": self,
        })
    }
}

// coverage-critical-start: protocol
/// Validates one decoded version 2 envelope and reports the kind it turned out to be.
pub fn validate_envelope(payload: &Value) -> Result<EnvelopeKind, ProtocolError> {
    let object = object_at(Some(payload), "payload")?;
    let version = positive_integer(object.get("protocolVersion"), "protocolVersion")?;
    if !SUPPORTED_PROTOCOL_VERSIONS.contains(&version) {
        return Err(ProtocolError::unsupported(version));
    }
    let kind = match non_empty_string(object.get("kind"), "kind")? {
        "handshake" => EnvelopeKind::Handshake,
        "request" => EnvelopeKind::Request,
        "response" => EnvelopeKind::Response,
        "event" => EnvelopeKind::Event,
        "error" => EnvelopeKind::Error,
        other => {
            return Err(ProtocolError::invalid(format!(
                "{other} is not an envelope kind"
            )));
        }
    };
    let id = non_empty_string(object.get("id"), "id")?;
    require(
        id.chars().count() <= MAX_ID_LENGTH,
        "id is longer than 128 characters",
    )?;

    match kind {
        EnvelopeKind::Handshake => validate_handshake(object)?,
        EnvelopeKind::Request => validate_request(object)?,
        EnvelopeKind::Response => validate_response(object)?,
        EnvelopeKind::Event => validate_event(object)?,
        EnvelopeKind::Error => validate_error(object.get("error"))?,
    }
    Ok(kind)
}

/// Validates one tagged Godot value wherever a command contract places one.
pub fn validate_value(value: &Value) -> Result<(), ProtocolError> {
    let object = object_at(Some(value), "value")?;
    let kind = non_empty_string(object.get("type"), "value.type")?;
    let payload = object.get("value");
    match kind {
        "null" => require(
            matches!(payload, None | Some(Value::Null)),
            "a null value carries no value",
        ),
        "bool" => require(
            payload.is_some_and(Value::is_boolean),
            "a bool value carries a boolean",
        ),
        "int" => integer(payload, "value").map(|_| ()),
        "float" => require(
            payload.is_some_and(Value::is_number),
            "a float value carries a number",
        ),
        "string" => require(
            payload.is_some_and(Value::is_string),
            "a string value carries a string",
        ),
        "array" => {
            for entry in array_at(payload, "value")? {
                validate_value(entry)?;
            }
            Ok(())
        }
        "dictionary" => {
            for entry in array_at(payload, "value")? {
                let entry = object_at(Some(entry), "dictionary entry")?;
                validate_value(entry.get("key").unwrap_or(&Value::Null))?;
                validate_value(entry.get("value").unwrap_or(&Value::Null))?;
            }
            Ok(())
        }
        _ => validate_composite_value(kind, payload),
    }
}

/// Reports the byte limit that applies to `payload`, which is larger for image frames.
pub fn max_envelope_bytes(payload: &Value) -> usize {
    let frame = match payload.get("kind").and_then(Value::as_str) {
        Some("response") => payload.pointer("/result/frame"),
        Some("event") => payload.pointer("/data/frame"),
        _ => None,
    };
    let encoding = frame
        .and_then(|frame| frame.get("encoding"))
        .and_then(Value::as_str);
    if encoding == Some(IMAGE_ENCODING) {
        return MAX_IMAGE_ENVELOPE_BYTES;
    }
    MAX_ENVELOPE_BYTES
}

/// Rejects a framed line that is larger than the limit its payload is allowed to use.
pub fn enforce_envelope_size(raw_bytes: usize, payload: &Value) -> Result<(), ProtocolError> {
    let limit = max_envelope_bytes(payload);
    if raw_bytes > limit {
        return Err(ProtocolError::too_large(raw_bytes, limit));
    }
    Ok(())
}

fn validate_handshake(object: &Map<String, Value>) -> Result<(), ProtocolError> {
    let token = non_empty_string(object.get("token"), "token")?;
    require(
        is_session_token(token),
        "token must be 64 lowercase hexadecimal characters",
    )?;
    let versions = array_at(object.get("acceptedVersions"), "acceptedVersions")?;
    require(!versions.is_empty(), "acceptedVersions must not be empty")?;
    for version in versions {
        positive_integer(Some(version), "acceptedVersions")?;
    }
    let client = object_at(object.get("client"), "client")?;
    non_empty_string(client.get("name"), "client.name")?;
    non_empty_string(client.get("addonVersion"), "client.addonVersion")?;
    let engine = non_empty_string(client.get("engineVersion"), "client.engineVersion")?;
    require(
        is_engine_version(engine),
        "client.engineVersion must be major.minor.patch.channel",
    )?;
    let path = non_empty_string(client.get("projectPath"), "client.projectPath")?;
    require(
        is_absolute_path(path),
        "client.projectPath must be absolute",
    )?;
    for capability in array_at(client.get("capabilities"), "client.capabilities")? {
        let capability = non_empty_string(Some(capability), "client.capabilities")?;
        require(
            DOMAINS.contains(&capability),
            "client.capabilities must name domains",
        )?;
    }
    Ok(())
}

fn validate_request(object: &Map<String, Value>) -> Result<(), ProtocolError> {
    let command = non_empty_string(object.get("command"), "command")?;
    require(
        is_domain_operation(command),
        "command must be a domain.operation name",
    )?;
    object_at(object.get("params"), "params")?;
    let revision = object.get("expectedRevision");
    if MUTATING_COMMANDS.contains(&command) {
        require(
            revision.is_some(),
            "a mutating command requires expectedRevision",
        )?;
    }
    if let Some(revision) = revision {
        non_negative_integer(Some(revision), "expectedRevision")?;
    }
    if let Some(timeout) = object.get("timeoutMs") {
        let timeout = positive_integer(Some(timeout), "timeoutMs")?;
        require(
            timeout <= MAX_TIMEOUT_MS,
            "timeoutMs must not exceed 600000",
        )?;
    }
    Ok(())
}

fn validate_response(object: &Map<String, Value>) -> Result<(), ProtocolError> {
    require(object.contains_key("result"), "result is required")?;
    if let Some(revision) = object.get("revision") {
        non_negative_integer(Some(revision), "revision")?;
    }
    Ok(())
}

fn validate_event(object: &Map<String, Value>) -> Result<(), ProtocolError> {
    non_negative_integer(object.get("sequence"), "sequence")?;
    let event = non_empty_string(object.get("event"), "event")?;
    require(
        is_domain_operation(event),
        "event must be a domain.operation name",
    )?;
    object_at(object.get("data"), "data")?;
    Ok(())
}

fn validate_error(value: Option<&Value>) -> Result<(), ProtocolError> {
    let error = object_at(value, "error")?;
    let code = non_empty_string(error.get("code"), "error.code")?;
    require(
        is_snake_case(code),
        "error.code must be lowercase snake case",
    )?;
    non_empty_string(error.get("message"), "error.message")?;
    require(
        error.get("retryable").is_some_and(Value::is_boolean),
        "error.retryable must be a boolean",
    )?;
    let readiness = non_empty_string(error.get("readiness"), "error.readiness")?;
    require(
        Readiness::parse(readiness).is_some(),
        "error.readiness is not a known state",
    )?;
    object_at(error.get("details"), "error.details")?;
    Ok(())
}

fn validate_composite_value(kind: &str, payload: Option<&Value>) -> Result<(), ProtocolError> {
    if let Some(numeric) = NUMERIC_VALUES.iter().find(|entry| entry.kind == kind) {
        let entries = array_at(payload, "value")?;
        require(
            entries.len() == numeric.arity,
            "the value has the wrong number of components",
        )?;
        for entry in entries {
            let component = number(Some(entry), "value")?;
            require(
                !numeric.integral || component.fract() == 0.0,
                "the components are integers",
            )?;
        }
        return Ok(());
    }
    let Some(spec) = OBJECT_VALUES.iter().find(|entry| entry.kind == kind) else {
        return Err(ProtocolError::invalid(format!(
            "{kind} is not a Godot value type"
        )));
    };
    let object = object_at(payload, "value")?;
    for name in spec.required_strings {
        non_empty_string(object.get(*name), name)?;
    }
    for name in spec.optional_strings {
        if let Some(field) = object.get(*name) {
            non_empty_string(Some(field), name)?;
        }
    }
    for name in spec.required_integers {
        integer(object.get(*name), name)?;
    }
    for name in spec.optional_integers {
        if let Some(field) = object.get(*name) {
            integer(Some(field), name)?;
        }
    }
    Ok(())
}

fn is_session_token(token: &str) -> bool {
    token.len() == SESSION_TOKEN_LENGTH
        && token
            .chars()
            .all(|character| character.is_ascii_digit() || matches!(character, 'a'..='f'))
}

fn is_absolute_path(path: &str) -> bool {
    let mut characters = path.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if first == '/' {
        return true;
    }
    first.is_ascii_alphabetic()
        && characters.next() == Some(':')
        && matches!(characters.next(), Some('/') | Some('\\'))
}

fn is_engine_version(version: &str) -> bool {
    let mut parts = version.split('.');
    let numbers = [parts.next(), parts.next(), parts.next()];
    let channel = parts.next();
    if parts.next().is_some() {
        return false;
    }
    numbers.into_iter().all(|part| part.is_some_and(is_digits))
        && channel.is_some_and(is_lowercase_word)
}

fn is_digits(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
}

fn is_lowercase_word(part: &str) -> bool {
    !part.is_empty() && part.chars().all(|character| character.is_ascii_lowercase())
}

fn is_domain_operation(name: &str) -> bool {
    let Some((domain, operation)) = name.split_once('.') else {
        return false;
    };
    DOMAINS.contains(&domain) && is_snake_case(operation)
}

fn is_snake_case(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && characters.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
        })
}

fn require(condition: bool, message: &str) -> Result<(), ProtocolError> {
    if condition {
        return Ok(());
    }
    Err(ProtocolError::invalid(message))
}

fn number(value: Option<&Value>, name: &str) -> Result<f64, ProtocolError> {
    value
        .and_then(Value::as_f64)
        .ok_or_else(|| ProtocolError::invalid(format!("{name} must be a number")))
}

fn integer(value: Option<&Value>, name: &str) -> Result<f64, ProtocolError> {
    let number = number(value, name)?;
    if number.fract() != 0.0 {
        return Err(ProtocolError::invalid(format!("{name} must be an integer")));
    }
    Ok(number)
}

fn positive_integer(value: Option<&Value>, name: &str) -> Result<u64, ProtocolError> {
    let number = integer(value, name)?;
    if number <= 0.0 {
        return Err(ProtocolError::invalid(format!("{name} must be positive")));
    }
    Ok(number as u64)
}

fn non_negative_integer(value: Option<&Value>, name: &str) -> Result<f64, ProtocolError> {
    let number = integer(value, name)?;
    if number < 0.0 {
        return Err(ProtocolError::invalid(format!(
            "{name} must not be negative"
        )));
    }
    Ok(number)
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

fn array_at<'a>(value: Option<&'a Value>, name: &str) -> Result<&'a Vec<Value>, ProtocolError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| ProtocolError::invalid(format!("{name} must be an array")))
}

fn object_at<'a>(
    value: Option<&'a Value>,
    name: &str,
) -> Result<&'a Map<String, Value>, ProtocolError> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| ProtocolError::invalid(format!("{name} must be an object")))
}
// coverage-critical-end: protocol

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use super::*;

    fn fixtures(kind: &str) -> Vec<PathBuf> {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/fixtures/v2")
            .join(kind);
        let mut paths: Vec<_> = fs::read_dir(directory)
            .expect("read protocol fixture directory")
            .map(|entry| entry.expect("read fixture entry").path())
            .collect();
        paths.sort();
        paths
    }

    fn fixture(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).expect("read fixture")).expect("parse fixture JSON")
    }

    fn prefix(path: &Path) -> String {
        path.file_name()
            .and_then(|name| name.to_str())
            .expect("fixture filename")
            .split('-')
            .next()
            .expect("fixture kind")
            .to_owned()
    }

    fn validate(path: &Path) -> Result<(), ProtocolError> {
        let payload = fixture(path);
        if prefix(path) == "value" {
            return validate_value(&payload);
        }
        validate_envelope(&payload).map(|_| ())
    }

    fn valid_fixture(name: &str) -> Value {
        fixture(
            &fixtures("valid")
                .into_iter()
                .find(|path| path.file_name().is_some_and(|file| file == name))
                .expect("named fixture"),
        )
    }

    #[test]
    fn accepts_every_valid_golden_fixture() {
        for path in fixtures("valid") {
            assert_eq!(validate(&path), Ok(()), "{}", path.display());
        }
    }

    #[test]
    fn rejects_every_invalid_golden_fixture() {
        for path in fixtures("invalid") {
            let error = validate(&path).expect_err("fixture must be invalid");
            assert_eq!(error.code, "invalid_protocol_payload", "{}", path.display());
            assert!(!error.retryable, "{}", path.display());
        }
    }

    #[test]
    fn reports_the_kind_of_every_valid_envelope() {
        for path in fixtures("valid")
            .into_iter()
            .filter(|path| prefix(path) != "value")
        {
            let kind = validate_envelope(&fixture(&path)).expect("valid envelope");
            assert_eq!(kind.name(), prefix(&path), "{}", path.display());
        }
    }

    #[test]
    fn rejects_unsupported_versions_with_supported_versions() {
        let path = fixtures("unsupported").pop().expect("unsupported fixture");
        assert_eq!(
            validate(&path),
            Err(ProtocolError {
                code: "unsupported_protocol_version",
                message: "Protocol version 3 is not supported".to_owned(),
                retryable: false,
                readiness: Readiness::Unavailable,
                details: json!({"supportedVersions": [2]}),
            })
        );
    }

    #[test]
    fn readers_ignore_unknown_optional_fields() {
        let mut payload = valid_fixture("request-scene-open.json");
        payload["futureOptionalField"] = json!({"nested": true});
        assert_eq!(validate_envelope(&payload), Ok(EnvelopeKind::Request));
    }

    #[test]
    fn the_handshake_result_publishes_the_frozen_limits() {
        let limits = valid_fixture("response-handshake-accepted.json")["result"]["limits"].clone();
        assert_eq!(
            limits,
            json!({
                "maxEnvelopeBytes": MAX_ENVELOPE_BYTES,
                "maxImageEnvelopeBytes": MAX_IMAGE_ENVELOPE_BYTES,
                "maxImageEdgePixels": MAX_IMAGE_EDGE_PIXELS,
            })
        );
    }

    #[test]
    fn only_image_frames_may_exceed_the_json_envelope_limit() {
        let screenshot = valid_fixture("response-runtime-screenshot.json");
        assert_eq!(max_envelope_bytes(&screenshot), MAX_IMAGE_ENVELOPE_BYTES);
        assert_eq!(
            enforce_envelope_size(MAX_ENVELOPE_BYTES + 1, &screenshot),
            Ok(())
        );
        assert_eq!(
            max_envelope_bytes(&valid_fixture("response-node-set-property.json")),
            MAX_ENVELOPE_BYTES
        );
        let mut streamed = valid_fixture("event-log-appended.json");
        assert_eq!(max_envelope_bytes(&streamed), MAX_ENVELOPE_BYTES);
        streamed["data"]["frame"] = json!({"encoding": IMAGE_ENCODING});
        assert_eq!(max_envelope_bytes(&streamed), MAX_IMAGE_ENVELOPE_BYTES);
        assert_eq!(
            max_envelope_bytes(&valid_fixture("request-scene-open.json")),
            MAX_ENVELOPE_BYTES
        );
        let error = enforce_envelope_size(
            MAX_ENVELOPE_BYTES + 1,
            &valid_fixture("event-log-appended.json"),
        )
        .expect_err("oversized envelopes are rejected");
        assert_eq!(error.code, "payload_too_large");
        assert_eq!(error.details["limitBytes"], json!(MAX_ENVELOPE_BYTES));
    }

    #[test]
    fn errors_render_as_correlated_envelopes() {
        let error = ProtocolError::invalid("params must be an object");
        assert_eq!(
            error.to_envelope("request-2"),
            json!({
                "protocolVersion": 2,
                "kind": "error",
                "id": "request-2",
                "error": {
                    "code": "invalid_protocol_payload",
                    "message": "params must be an object",
                    "retryable": false,
                    "readiness": "ready",
                    "details": {},
                },
            })
        );
        for kind in [
            EnvelopeKind::Handshake,
            EnvelopeKind::Request,
            EnvelopeKind::Response,
            EnvelopeKind::Event,
            EnvelopeKind::Error,
        ] {
            assert!(!kind.name().is_empty());
        }
    }

    #[test]
    fn envelope_validators_cover_every_branch() {
        let cases = [
            json!([]),
            json!({"protocolVersion": "2"}),
            json!({"protocolVersion": 2, "kind": "greeting", "id": "a"}),
            json!({"protocolVersion": 2, "kind": 2, "id": "a"}),
            json!({"protocolVersion": 2, "kind": "request", "id": ""}),
            json!({"protocolVersion": 2, "kind": "request", "id": "r"}),
            json!({"protocolVersion": 2, "kind": "request", "id": "r", "command": "scene.open"}),
            json!({
                "protocolVersion": 2, "kind": "request", "id": "r",
                "command": "scene open", "params": {}
            }),
            json!({
                "protocolVersion": 2, "kind": "request", "id": "r",
                "command": "scene.save", "params": {}
            }),
            json!({
                "protocolVersion": 2, "kind": "request", "id": "r",
                "command": "scene.save", "params": {}, "expectedRevision": 1.5
            }),
            json!({
                "protocolVersion": 2, "kind": "request", "id": "r",
                "command": "scene.list", "params": {}, "timeoutMs": 0
            }),
            json!({"protocolVersion": 2, "kind": "response", "id": "r", "revision": {}}),
            json!({"protocolVersion": 2, "kind": "event", "id": "s", "sequence": "1"}),
            json!({"protocolVersion": 2, "kind": "event", "id": "s", "sequence": 1, "event": ""}),
            json!({
                "protocolVersion": 2, "kind": "event", "id": "s", "sequence": 1,
                "event": "logs.appended"
            }),
            json!({"protocolVersion": 2, "kind": "error", "id": "r", "error": []}),
            error_envelope(json!({"code": "Bad", "message": "m", "retryable": true,
                "readiness": "ready", "details": {}})),
            error_envelope(json!({"code": "bad", "message": "", "retryable": true,
                "readiness": "ready", "details": {}})),
            error_envelope(json!({"code": "bad", "message": "m", "retryable": "yes",
                "readiness": "ready", "details": {}})),
            error_envelope(json!({"code": "bad", "message": "m", "retryable": true,
                "readiness": "warm", "details": {}})),
            error_envelope(json!({"code": "bad", "message": "m", "retryable": true,
                "readiness": "ready"})),
            handshake(json!({"token": 4})),
            handshake(json!({"acceptedVersions": {}})),
            handshake(json!({"acceptedVersions": []})),
            handshake(json!({"acceptedVersions": [0]})),
            handshake(json!({"client": "gofer"})),
            handshake(json!({"client": {"name": "gofer"}})),
        ];
        for case in cases {
            assert!(validate_envelope(&case).is_err(), "{case}");
        }
        assert_eq!(
            validate_envelope(&handshake(json!({"acceptedVersions": [2, 3]}))),
            Ok(EnvelopeKind::Handshake)
        );
    }

    #[test]
    fn value_validators_cover_every_branch() {
        let valid = [
            json!({"type": "null"}),
            json!({"type": "null", "value": null}),
            json!({"type": "bool", "value": false}),
            json!({"type": "int", "value": -3}),
            json!({"type": "float", "value": 0.5}),
            json!({"type": "string", "value": ""}),
            json!({"type": "array", "value": []}),
            json!({"type": "color", "value": [1, 1, 1, 1]}),
            json!({"type": "resource", "value": {"path": "res://a.tres", "resourceType": "Theme"}}),
            json!({"type": "node", "value": {"path": "/root", "nodeType": "Node"}}),
            json!({"type": "object", "value": {"className": "Timer", "instanceId": 4}}),
        ];
        for case in valid {
            assert_eq!(validate_value(&case), Ok(()), "{case}");
        }
        let invalid = [
            json!([]),
            json!({"type": ""}),
            json!({"type": "null", "value": 1}),
            json!({"type": "bool", "value": 1}),
            json!({"type": "int", "value": 1.5}),
            json!({"type": "float", "value": "1"}),
            json!({"type": "string", "value": 1}),
            json!({"type": "array", "value": {}}),
            json!({"type": "array", "value": [{"type": "sprite"}]}),
            json!({"type": "dictionary", "value": [1]}),
            json!({"type": "dictionary", "value": [{"key": {"type": "int", "value": 1}}]}),
            json!({"type": "color", "value": "white"}),
            json!({"type": "color", "value": [1, 1, 1, "1"]}),
            json!({"type": "resource", "value": []}),
            json!({"type": "resource", "value": {"path": "res://a.tres",
                "resourceType": "Theme", "uid": ""}}),
            json!({"type": "object", "value": {"className": "Timer"}}),
            json!({"type": "node", "value": {"path": "/root", "nodeType": "Node",
                "instanceId": 1.5}}),
        ];
        for case in invalid {
            assert!(validate_value(&case).is_err(), "{case}");
        }
    }

    #[test]
    fn primitive_validators_cover_every_branch() {
        assert!(is_session_token(&"a1".repeat(32)));
        assert!(!is_session_token("abc"));
        assert!(!is_session_token(&"A1".repeat(32)));
        assert!(is_absolute_path("/tmp/project"));
        assert!(is_absolute_path("C:\\projects\\game"));
        assert!(is_absolute_path("C:/projects/game"));
        assert!(!is_absolute_path(""));
        assert!(!is_absolute_path("projects/game"));
        assert!(!is_absolute_path("1:/projects"));
        assert!(!is_absolute_path("C|/projects"));
        assert!(!is_absolute_path("C:projects"));
        assert!(is_engine_version("4.7.1.stable"));
        assert!(!is_engine_version("4.7.1.stable.custom"));
        assert!(!is_engine_version("4.7.1"));
        assert!(!is_engine_version("4.7.x.stable"));
        assert!(!is_engine_version("4.7.1.STABLE"));
        assert!(!is_engine_version("4.7.1."));
        assert!(!is_engine_version("4..1.stable"));
        assert!(is_domain_operation("scene.save_as"));
        assert!(!is_domain_operation("scene"));
        assert!(!is_domain_operation("physics.step"));
        assert!(is_snake_case("code_2"));
        assert!(!is_snake_case(""));
        assert!(!is_snake_case("Code"));
        assert!(!is_snake_case("code-2"));
        assert!(require(true, "message").is_ok());
        assert!(number(None, "value").is_err());
        assert!(non_negative_integer(Some(&json!(-1)), "revision").is_err());
        assert!(non_empty_string(Some(&json!(1)), "id").is_err());
        assert!(array_at(Some(&json!({})), "value").is_err());
    }

    fn error_envelope(error: Value) -> Value {
        json!({"protocolVersion": 2, "kind": "error", "id": "request-1", "error": error})
    }

    fn handshake(overrides: Value) -> Value {
        let mut payload = valid_fixture("handshake-editor-session.json");
        for (key, value) in overrides.as_object().expect("handshake overrides") {
            payload[key] = value.clone();
        }
        payload
    }
}
