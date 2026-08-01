extends SceneTree

const SUPPORTED_PROTOCOL_VERSIONS := [1]

func _initialize() -> void:
    var failures: Array[String] = []
    var protocol_path := ProjectSettings.globalize_path("res://../../protocol/fixtures")
    _test_fixtures(protocol_path.path_join("valid"), true, failures)
    _test_fixtures(protocol_path.path_join("invalid"), false, failures)
    _test_unsupported(protocol_path.path_join("unsupported/request-version-2.json"), failures)
    if failures.is_empty():
        print("Gofer Godot protocol fixtures passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

func _test_fixtures(directory: String, expected: bool, failures: Array[String]) -> void:
    var files := DirAccess.get_files_at(directory)
    files.sort()
    for filename in files:
        if not filename.ends_with(".json"):
            continue
        var payload: Variant = _read_json(directory.path_join(filename), failures)
        if payload == null:
            continue
        var kind := filename.get_slice("-", 0)
        if _validate(payload, kind) != expected:
            failures.append("Unexpected validation result for %s/%s" % [directory, filename])

func _test_unsupported(path: String, failures: Array[String]) -> void:
    var payload: Variant = _read_json(path, failures)
    if payload == null:
        return
    var error := _validate_version(payload)
    if error.get("code") != "unsupported_protocol_version":
        failures.append("Unsupported versions must use the unsupported_protocol_version code")
    if error.get("details", {}).get("supportedVersions") != SUPPORTED_PROTOCOL_VERSIONS:
        failures.append("Unsupported version errors must list supportedVersions")

func _read_json(path: String, failures: Array[String]) -> Variant:
    var file := FileAccess.open(path, FileAccess.READ)
    if file == null:
        failures.append("Could not open fixture: %s" % path)
        return null
    var payload: Variant = JSON.parse_string(file.get_as_text())
    if payload == null:
        failures.append("Could not parse fixture: %s" % path)
    return payload

func _validate(payload: Variant, kind: String) -> bool:
    if typeof(payload) != TYPE_DICTIONARY:
        return false
    if not _is_positive_integer(payload.get("protocolVersion")):
        return false
    if not _is_non_empty_string(payload.get("id")):
        return false
    if kind == "request":
        return _is_non_empty_string(payload.get("command")) and typeof(payload.get("params")) == TYPE_DICTIONARY
    if kind == "response":
        return payload.has("result")
    if kind == "event":
        return (
            _is_non_negative_integer(payload.get("sequence"))
            and _is_non_empty_string(payload.get("event"))
            and typeof(payload.get("data")) == TYPE_DICTIONARY
        )
    if kind == "error":
        return _validate_error(payload.get("error"))
    return false

func _validate_error(value: Variant) -> bool:
    if typeof(value) != TYPE_DICTIONARY:
        return false
    var code: Variant = value.get("code")
    if not _is_non_empty_string(code) or not _is_error_code(code):
        return false
    return _is_non_empty_string(value.get("message")) and typeof(value.get("details")) == TYPE_DICTIONARY

func _is_error_code(code: String) -> bool:
    var expression := RegEx.new()
    expression.compile("^[a-z][a-z0-9_]*$")
    return expression.search(code) != null

func _is_positive_integer(value: Variant) -> bool:
    return (typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT) and value > 0 and value == floor(value)

func _is_non_negative_integer(value: Variant) -> bool:
    return (typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT) and value >= 0 and value == floor(value)

func _is_non_empty_string(value: Variant) -> bool:
    return typeof(value) == TYPE_STRING and not value.is_empty()

func _validate_version(payload: Dictionary) -> Dictionary:
    var version: Variant = payload.get("protocolVersion")
    if version in SUPPORTED_PROTOCOL_VERSIONS:
        return {}
    return {
        "code": "unsupported_protocol_version",
        "message": "Protocol version %s is not supported" % version,
        "details": {"supportedVersions": SUPPORTED_PROTOCOL_VERSIONS}
    }
