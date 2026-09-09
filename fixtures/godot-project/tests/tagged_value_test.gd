extends SceneTree

## The tag table the model is given, decoded by the addon that has to answer it.
##
## `protocol/schemas/v2/godot-tool.json` carries one branch per tag under `$defs.taggedValue`, all
## of it printed from one table in `scripts/godot-vocabulary.mjs`. Nothing else holds that table to
## `Protocol.decode`: the schema could name a tag the codec has no arm for, or refuse a payload the
## codec takes, and every other suite would stay green. So one sample per branch is built from the
## branch's own payload shape and decoded here, and the two lists are compared both ways.
const PROTOCOL_SOURCE := "res://../../src-tauri/addon/protocol.gd"
const TOOL_SOURCE := "res://../../protocol/schemas/v2/godot-tool.json"

## A resource that exists in this project, for the one payload that has to load something.
const A_RESOURCE := "res://main.tscn"

## The tags `decode` answers for and the schema must not offer: each names something live in the
## process that wrote it, which no payload rebuilds.
const UNDECODABLE := ["Object", "Callable", "Signal", "RID"]

func _initialize() -> void:
    var failures: Array[String] = []
    var protocol := _load_protocol(failures)
    var branches := _load_branches(failures)
    if protocol != null and not branches.is_empty():
        _test_every_tag_decodes(protocol, branches, failures)
        _test_every_arm_is_offered(protocol, branches, failures)
    if failures.is_empty():
        print("Gofer Godot tagged values passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

func _load_protocol(failures: Array[String]) -> GDScript:
    var path := ProjectSettings.globalize_path(PROTOCOL_SOURCE)
    if not FileAccess.file_exists(path):
        failures.append("The addon protocol script is not at %s" % path)
        return null
    var script := GDScript.new()
    script.source_code = FileAccess.get_file_as_string(path)
    if script.reload() != OK:
        failures.append("The addon protocol script did not compile")
        return null
    return script

## Every `$defs.taggedValue` branch of the committed tool, as `{tag: payload schema}`.
func _load_branches(failures: Array[String]) -> Dictionary:
    var path := ProjectSettings.globalize_path(TOOL_SOURCE)
    if not FileAccess.file_exists(path):
        failures.append("The committed godot tool is not at %s" % path)
        return {}
    var tool_json: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
    if typeof(tool_json) != TYPE_DICTIONARY:
        failures.append("The committed godot tool is not an object")
        return {}
    var defs: Variant = (tool_json as Dictionary).get("parameters", {}).get("$defs", {})
    var listed: Variant = (defs as Dictionary).get("taggedValue", {}).get("oneOf", [])
    if typeof(listed) != TYPE_ARRAY or (listed as Array).is_empty():
        failures.append("The committed godot tool names no tagged value branches")
        return {}
    var branches := {}
    for branch in listed as Array:
        var properties: Dictionary = (branch as Dictionary).get("properties", {})
        var tag: String = str(properties.get("type", {}).get("const", ""))
        branches[tag] = properties.get("value", {})
    return branches

func _test_every_tag_decodes(protocol: GDScript, branches: Dictionary, failures: Array[String]) -> void:
    for tag in branches:
        var sample: Variant = _sample(branches[tag])
        var answered: Dictionary = protocol.call("decode", {"type": tag, "value": sample})
        if not answered.get("ok", false):
            failures.append(
                "%s is offered to the model and %s refuses the payload the schema gives it: %s"
                % [tag, "decode", str(answered.get("message", ""))]
            )

## The tags `decode` has an arm for are the tags the schema offers, and no others.
##
## Read by asking rather than by reading the source: a tag with no arm at all answers "is not
## supported", and the four that name something live answer with their own sentence.
func _test_every_arm_is_offered(protocol: GDScript, branches: Dictionary, failures: Array[String]) -> void:
    for kind in range(TYPE_MAX):
        var tag := type_string(kind)
        var answered: Dictionary = protocol.call("decode", {"type": tag, "value": null})
        var unknown: bool = str(answered.get("message", "")).contains("is not supported")
        if unknown and branches.has(tag):
            failures.append("%s is offered to the model and decode has no arm for it" % tag)
        if not unknown and not branches.has(tag) and not UNDECODABLE.has(tag):
            failures.append("%s decodes and the model is never told it may write one" % tag)
    for tag in UNDECODABLE:
        if branches.has(tag):
            failures.append("%s names something live and must not be offered" % tag)

## One payload of the shape a branch declares. Small on purpose: what is under test is whether the
## codec takes the shape at all, and a bigger sample says nothing more.
func _sample(shape: Dictionary) -> Variant:
    if shape.has("oneOf"):
        return _sample((shape["oneOf"] as Array)[0])
    match str(shape.get("type", "")):
        "null":
            return null
        "boolean":
            return true
        "integer", "number":
            return 1
        "string":
            return "res://main.tscn"
        "object":
            return _sample_object(shape)
        "array":
            return _sample_array(shape)
    return null

func _sample_object(shape: Dictionary) -> Dictionary:
    var made := {}
    for name in shape.get("properties", {}):
        if name == "path":
            made[name] = A_RESOURCE
        elif str(name) == "key" or str(name) == "value":
            made[name] = {"type": "int", "value": 1}
        else:
            made[name] = _sample(shape["properties"][name])
    return made

func _sample_array(shape: Dictionary) -> Array:
    var items: Dictionary = shape.get("items", {})
    var least: int = int(shape.get("minItems", 1))
    var made := []
    for _index in range(maxi(least, 1)):
        made.append(_sample(items) if not items.has("$ref") else {"type": "int", "value": 1})
    return made
