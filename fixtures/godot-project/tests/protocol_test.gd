extends SceneTree

# Version 2 is the persistent editor session contract frozen in protocol/README.md, and the only
# one left: version 1 retired with the one-shot bridge it served. The same golden fixtures Rust and
# TypeScript consume are validated here.

const SUPPORTED_V2_VERSIONS := [2]

const MAX_ENVELOPE_BYTES := 1048576
const MAX_IMAGE_ENVELOPE_BYTES := 16777216
const MAX_IMAGE_EDGE_PIXELS := 1920
const MAX_ID_LENGTH := 128
const MAX_TIMEOUT_MS := 600000
const IMAGE_ENCODING := "png-base64"
const SESSION_TOKEN_LENGTH := 64

const ENVELOPE_KINDS := ["handshake", "request", "response", "event", "error"]
const READINESS_STATES := ["ready", "starting", "importing", "unavailable"]
const DOMAINS := [
    "session",
    "scene",
    "node",
    "project",
    "editor",
    "resource",
    "script",
    "debug",
    "runtime",
    "logs",
    "files",
    "docs"
]
const MUTATING_COMMANDS := [
    "session.undo",
    "session.redo",
    "scene.create",
    "scene.save",
    "scene.save_as",
    "scene.reload",
    "node.create",
    "node.duplicate",
    "node.rename",
    "node.reparent",
    "node.delete",
    "node.set_property",
    "node.add_to_group",
    "node.remove_from_group",
    "node.connect_signal",
    "node.disconnect_signal"
]
const NUMERIC_VALUES := {
    "vector2": [2, false],
    "vector2i": [2, true],
    "vector3": [3, false],
    "vector3i": [3, true],
    "vector4": [4, false],
    "vector4i": [4, true],
    "quaternion": [4, false],
    "color": [4, false],
    "plane": [4, false],
    "rect2": [4, false],
    "rect2i": [4, true],
    "transform2d": [6, false],
    "basis": [9, false],
    "transform3d": [12, false]
}
const OBJECT_VALUES := {
    "resource": [["path", "resourceType"], ["uid"], [], []],
    "node": [["path", "nodeType"], [], [], ["instanceId"]],
    "object": [["className"], [], ["instanceId"], []],
    "opaque": [["typeName", "text"], [], [], []]
}

func _initialize() -> void:
    var failures: Array[String] = []
    var protocol_path := ProjectSettings.globalize_path("res://../../protocol/fixtures")
    var v2_path := protocol_path.path_join("v2")
    _test_v2_fixtures(v2_path.path_join("valid"), true, failures)
    _test_v2_fixtures(v2_path.path_join("invalid"), false, failures)
    _test_v2_unsupported(v2_path.path_join("unsupported/handshake-version-3.json"), failures)
    _test_v2_limits(v2_path.path_join("valid"), failures)
    if failures.is_empty():
        print("Gofer Godot protocol fixtures passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

func _test_v2_fixtures(directory: String, expected: bool, failures: Array[String]) -> void:
    var files := DirAccess.get_files_at(directory)
    files.sort()
    for filename in files:
        if not filename.ends_with(".json"):
            continue
        var payload: Variant = _read_json(directory.path_join(filename), failures)
        if payload == null:
            continue
        var kind := filename.get_slice("-", 0)
        var accepted := (
            _validate_v2_value(payload) if kind == "value"
            else _validate_v2_envelope(payload) == kind
        )
        if accepted != expected:
            failures.append("Unexpected v2 validation result for %s/%s" % [directory, filename])

func _test_v2_unsupported(path: String, failures: Array[String]) -> void:
    var payload: Variant = _read_json(path, failures)
    if payload == null:
        return
    if _validate_v2_envelope(payload) != "":
        failures.append("Unsupported v2 versions must not validate")
    var error := _validate_v2_version(payload)
    if error.get("code") != "unsupported_protocol_version":
        failures.append("Unsupported v2 versions must use the unsupported_protocol_version code")
    if error.get("details", {}).get("supportedVersions") != SUPPORTED_V2_VERSIONS:
        failures.append("Unsupported v2 version errors must list supportedVersions")

func _test_v2_limits(directory: String, failures: Array[String]) -> void:
    var accepted: Variant = _read_json(
        directory.path_join("response-handshake-accepted.json"), failures
    )
    if accepted != null:
        var limits: Variant = accepted.get("result", {}).get("limits", {})
        if (
            limits.get("maxEnvelopeBytes") != MAX_ENVELOPE_BYTES
            or limits.get("maxImageEnvelopeBytes") != MAX_IMAGE_ENVELOPE_BYTES
            or limits.get("maxImageEdgePixels") != MAX_IMAGE_EDGE_PIXELS
        ):
            failures.append("The handshake result must publish the frozen protocol limits")
    var screenshot: Variant = _read_json(
        directory.path_join("response-runtime-screenshot.json"), failures
    )
    if screenshot != null and _max_envelope_bytes(screenshot) != MAX_IMAGE_ENVELOPE_BYTES:
        failures.append("Image frames may use the 16 MiB envelope limit")
    var log_event: Variant = _read_json(directory.path_join("event-log-appended.json"), failures)
    if log_event != null and _max_envelope_bytes(log_event) != MAX_ENVELOPE_BYTES:
        failures.append("Envelopes without an image frame keep the 1 MiB limit")

func _read_json(path: String, failures: Array[String]) -> Variant:
    var file := FileAccess.open(path, FileAccess.READ)
    if file == null:
        failures.append("Could not open fixture: %s" % path)
        return null
    var payload: Variant = JSON.parse_string(file.get_as_text())
    if payload == null:
        failures.append("Could not parse fixture: %s" % path)
    return payload

func _validate_v2_version(payload: Dictionary) -> Dictionary:
    var version: Variant = payload.get("protocolVersion")
    if _is_integer(version) and int(version) in SUPPORTED_V2_VERSIONS:
        return {}
    return {
        "code": "unsupported_protocol_version",
        "message": "Protocol version %s is not supported" % version,
        "details": {"supportedVersions": SUPPORTED_V2_VERSIONS}
    }

func _validate_v2_envelope(payload: Variant) -> String:
    if typeof(payload) != TYPE_DICTIONARY:
        return ""
    var version: Variant = payload.get("protocolVersion")
    if not _is_positive_integer(version) or not int(version) in SUPPORTED_V2_VERSIONS:
        return ""
    var raw_kind: Variant = payload.get("kind")
    if not _is_non_empty_string(raw_kind):
        return ""
    var kind := String(raw_kind)
    if not kind in ENVELOPE_KINDS:
        return ""
    var id: Variant = payload.get("id")
    if not _is_non_empty_string(id) or String(id).length() > MAX_ID_LENGTH:
        return ""
    var valid := false
    match kind:
        "handshake":
            valid = _validate_v2_handshake(payload)
        "request":
            valid = _validate_v2_request(payload)
        "response":
            valid = _validate_v2_response(payload)
        "event":
            valid = _validate_v2_event(payload)
        "error":
            valid = _validate_v2_error(payload.get("error"))
    if not valid:
        return ""
    return kind

func _validate_v2_handshake(payload: Dictionary) -> bool:
    var token: Variant = payload.get("token")
    if not _is_non_empty_string(token) or not _is_session_token(String(token)):
        return false
    var versions: Variant = payload.get("acceptedVersions")
    if typeof(versions) != TYPE_ARRAY or (versions as Array).is_empty():
        return false
    for version in versions:
        if not _is_positive_integer(version):
            return false
    var client: Variant = payload.get("client")
    if typeof(client) != TYPE_DICTIONARY:
        return false
    if not _is_non_empty_string(client.get("name")):
        return false
    if not _is_non_empty_string(client.get("addonVersion")):
        return false
    var engine: Variant = client.get("engineVersion")
    if not _is_non_empty_string(engine):
        return false
    if not _matches(String(engine), "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[a-z]+$"):
        return false
    var project_path: Variant = client.get("projectPath")
    if not _is_non_empty_string(project_path):
        return false
    if not _matches(String(project_path), "^(/|[A-Za-z]:[\\\\/])"):
        return false
    var capabilities: Variant = client.get("capabilities")
    if typeof(capabilities) != TYPE_ARRAY:
        return false
    for capability in capabilities:
        if not capability in DOMAINS:
            return false
    return true

func _validate_v2_request(payload: Dictionary) -> bool:
    var command: Variant = payload.get("command")
    if not _is_non_empty_string(command) or not _is_domain_operation(String(command)):
        return false
    if typeof(payload.get("params")) != TYPE_DICTIONARY:
        return false
    if String(command) in MUTATING_COMMANDS and not payload.has("expectedRevision"):
        return false
    if payload.has("expectedRevision") and not _is_non_negative_integer(payload.get("expectedRevision")):
        return false
    if not payload.has("timeoutMs"):
        return true
    var timeout: Variant = payload.get("timeoutMs")
    return _is_positive_integer(timeout) and timeout <= MAX_TIMEOUT_MS

func _validate_v2_response(payload: Dictionary) -> bool:
    if not payload.has("result"):
        return false
    if not payload.has("revision"):
        return true
    return _is_non_negative_integer(payload.get("revision"))

func _validate_v2_event(payload: Dictionary) -> bool:
    if not _is_non_negative_integer(payload.get("sequence")):
        return false
    var event: Variant = payload.get("event")
    if not _is_non_empty_string(event) or not _is_domain_operation(String(event)):
        return false
    return typeof(payload.get("data")) == TYPE_DICTIONARY

func _validate_v2_error(value: Variant) -> bool:
    if typeof(value) != TYPE_DICTIONARY:
        return false
    var code: Variant = value.get("code")
    if not _is_non_empty_string(code) or not _is_snake_case(String(code)):
        return false
    if not _is_non_empty_string(value.get("message")):
        return false
    if typeof(value.get("retryable")) != TYPE_BOOL:
        return false
    if not value.get("readiness") in READINESS_STATES:
        return false
    return typeof(value.get("details")) == TYPE_DICTIONARY

func _validate_v2_value(value: Variant) -> bool:
    if typeof(value) != TYPE_DICTIONARY:
        return false
    var raw_kind: Variant = value.get("type")
    if not _is_non_empty_string(raw_kind):
        return false
    var kind := String(raw_kind)
    var payload: Variant = value.get("value")
    match kind:
        "null":
            return payload == null
        "bool":
            return typeof(payload) == TYPE_BOOL
        "int":
            return _is_integer(payload)
        "float":
            return _is_number(payload)
        "string":
            return typeof(payload) == TYPE_STRING
        "array":
            if typeof(payload) != TYPE_ARRAY:
                return false
            for entry in payload:
                if not _validate_v2_value(entry):
                    return false
            return true
        "dictionary":
            if typeof(payload) != TYPE_ARRAY:
                return false
            for entry in payload:
                if typeof(entry) != TYPE_DICTIONARY:
                    return false
                if not _validate_v2_value(entry.get("key")):
                    return false
                if not _validate_v2_value(entry.get("value")):
                    return false
            return true
    return _validate_v2_composite(kind, payload)

func _validate_v2_composite(kind: String, payload: Variant) -> bool:
    if NUMERIC_VALUES.has(kind):
        var numeric: Array = NUMERIC_VALUES[kind]
        if typeof(payload) != TYPE_ARRAY or (payload as Array).size() != numeric[0]:
            return false
        for component in payload:
            if not _is_number(component):
                return false
            if numeric[1] and not _is_integer(component):
                return false
        return true
    if not OBJECT_VALUES.has(kind) or typeof(payload) != TYPE_DICTIONARY:
        return false
    var spec: Array = OBJECT_VALUES[kind]
    for name in spec[0]:
        if not _is_non_empty_string(payload.get(name)):
            return false
    for name in spec[1]:
        if payload.has(name) and not _is_non_empty_string(payload.get(name)):
            return false
    for name in spec[2]:
        if not _is_integer(payload.get(name)):
            return false
    for name in spec[3]:
        if payload.has(name) and not _is_integer(payload.get(name)):
            return false
    return true

func _max_envelope_bytes(payload: Variant) -> int:
    if typeof(payload) != TYPE_DICTIONARY:
        return MAX_ENVELOPE_BYTES
    var body: Variant = null
    match payload.get("kind"):
        "response":
            body = payload.get("result")
        "event":
            body = payload.get("data")
    if typeof(body) != TYPE_DICTIONARY:
        return MAX_ENVELOPE_BYTES
    var frame: Variant = body.get("frame")
    if typeof(frame) != TYPE_DICTIONARY or frame.get("encoding") != IMAGE_ENCODING:
        return MAX_ENVELOPE_BYTES
    return MAX_IMAGE_ENVELOPE_BYTES

func _is_session_token(token: String) -> bool:
    return token.length() == SESSION_TOKEN_LENGTH and _matches(token, "^[0-9a-f]+$")

func _is_domain_operation(name: String) -> bool:
    var parts := name.split(".")
    if parts.size() != 2 or not parts[0] in DOMAINS:
        return false
    return _is_snake_case(parts[1])

func _is_snake_case(name: String) -> bool:
    return _matches(name, "^[a-z][a-z0-9_]*$")

func _matches(value: String, pattern: String) -> bool:
    var expression := RegEx.new()
    expression.compile(pattern)
    return expression.search(value) != null

func _is_number(value: Variant) -> bool:
    return typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT

func _is_integer(value: Variant) -> bool:
    return _is_number(value) and value == floor(value)

func _is_positive_integer(value: Variant) -> bool:
    return _is_integer(value) and value > 0

func _is_non_negative_integer(value: Variant) -> bool:
    return _is_integer(value) and value >= 0

func _is_non_empty_string(value: Variant) -> bool:
    return typeof(value) == TYPE_STRING and not value.is_empty()
