extends SceneTree


const PROTOCOL_SOURCE := "res://../../src-tauri/addon/protocol.gd"

func _initialize() -> void:
    var failures: Array[String] = []
    _test_codec(failures)
    _test_frame_composite(failures)
    if failures.is_empty():
        print("Gofer Godot protocol codec passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

## Loads `protocol.gd` from the repository rather than from a staged addon.
##
## The fixture project is not the project the addon is staged into, and copying the file in would
## make this test pass against a copy. Reading the shipped source is what makes a codec change
## either break here or be correct.
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

## Every value the wire carries, encoded and decoded back. A tag that survives this round trip is
## one the editor and the running game agree on; one that does not is a property the renderer would
## draw differently depending on which process read it.
func _test_codec(failures: Array[String]) -> void:
    var protocol := _load_protocol(failures)
    if protocol == null:
        return
    var samples: Array = [
        null,
        true,
        7,
        1.5,
        "res://main.tscn",
        Vector2(1, 2),
        Vector2i(1, 2),
        Vector3(1, 2, 3),
        Vector3i(1, 2, 3),
        Vector4(1, 2, 3, 4),
        Vector4i(1, 2, 3, 4),
        Quaternion(0, 0, 0, 1),
        Color(0.25, 0.5, 0.75, 1),
        Rect2(1, 2, 3, 4),
        Rect2i(1, 2, 3, 4),
        Plane(Vector3(0, 1, 0), 5),
        Transform2D(Vector2(1, 2), Vector2(3, 4), Vector2(5, 6)),
        Basis(Vector3(1, 2, 3), Vector3(4, 5, 6), Vector3(7, 8, 9)),
        Transform3D(Basis(Vector3(1, 2, 3), Vector3(4, 5, 6), Vector3(7, 8, 9)), Vector3(9, 8, 7)),
        [1, "two", Vector2(3, 3)],
        {"a": 1, "b": [Vector2(1, 1)]}
    ]
    for sample in samples:
        var round_trip: Dictionary = protocol.call("decode", protocol.call("encode", sample))
        if not round_trip["ok"]:
            failures.append("A %s did not survive the codec: %s"
                % [type_string(typeof(sample)), round_trip["message"]])
            continue
        if round_trip["value"] != sample:
            failures.append("A %s decoded as %s" % [sample, round_trip["value"]])

    var refusals := {
        "a value that is not tagged at all": 7,
        "a bool with a numeric payload": {"type": "bool", "value": 1},
        "a vector2 with three numbers": {"type": "vector2", "value": [1, 2, 3]},
        "a vector2 with a string in it": {"type": "vector2", "value": [1, "2"]},
        "a resource with no path": {"type": "resource", "value": {}},
        "an array that is not an array": {"type": "array", "value": 1},
        "a dictionary entry with no key": {"type": "dictionary", "value": [{"value": 1}]},
        "a tag nothing writes": {"type": "sprite", "value": null},
        "a node reference": {"type": "node", "value": {"path": "/root", "nodeType": "Node"}},
        "an opaque value": {"type": "opaque", "value": {"typeName": "Callable", "text": ""}}
    }
    for what in refusals:
        var refused: Dictionary = protocol.call("decode", refusals[what])
        if refused["ok"]:
            failures.append("The codec accepted %s" % what)
        elif str(refused["message"]).is_empty():
            failures.append("The codec refused %s without saying why" % what)

    for spelling in ["red", "skyblue", "#8b5a2b", "8b5a2b"]:
        var named: Dictionary = protocol.call("decode", {"type": "color", "value": spelling})
        if not named["ok"] or typeof(named["value"]) != TYPE_COLOR:
            failures.append("The codec refused the colour %s" % spelling)
    if protocol.call("decode", {"type": "color", "value": "red"})["value"] != Color.RED:
        failures.append("A named colour must decode to that colour")
    var unnamed: Dictionary = protocol.call("decode", {"type": "color", "value": "notacolour"})
    if unnamed["ok"] or not str(unnamed["message"]).contains("skyblue"):
        failures.append("A colour nobody can write must be refused with the spellings there are")

    _test_declared_types(protocol, failures)

## The wire has one array tag, so which packed array a value becomes is decided by the type the
## property was declared with. A coerced element is what this exists to refuse.
func _test_declared_types(protocol: GDScript, failures: Array[String]) -> void:
    var fitted: Dictionary = protocol.call("fit_to_declared_type", [1, 2, 3], TYPE_PACKED_INT32_ARRAY)
    if not fitted["ok"] or typeof(fitted["value"]) != TYPE_PACKED_INT32_ARRAY:
        failures.append("An int array must fit a PackedInt32Array")
    var coerced: Dictionary = protocol.call("fit_to_declared_type", [1, "two"], TYPE_PACKED_INT32_ARRAY)
    if coerced["ok"]:
        failures.append("A string element must not be coerced into a PackedInt32Array")
    var widened: Dictionary = protocol.call("fit_to_declared_type", 3, TYPE_FLOAT)
    if not widened["ok"] or typeof(widened["value"]) != TYPE_FLOAT:
        failures.append("A whole number must fit a float")
    var named: Dictionary = protocol.call("fit_to_declared_type", "position", TYPE_NODE_PATH)
    if not named["ok"] or typeof(named["value"]) != TYPE_NODE_PATH:
        failures.append("A string must fit a NodePath")
    var mismatched: Dictionary = protocol.call("fit_to_declared_type", "12", TYPE_INT)
    if mismatched["ok"]:
        failures.append("A string must not fit an int")
    var narrowed: Dictionary = protocol.call("fit_to_declared_type", 1.0, TYPE_INT)
    if not narrowed["ok"] or typeof(narrowed["value"]) != TYPE_INT or narrowed["value"] != 1:
        failures.append("A whole float must fit an int")
    var negative: Dictionary = protocol.call("fit_to_declared_type", -3.0, TYPE_INT)
    if not negative["ok"] or negative["value"] != -3:
        failures.append("A negative whole float must fit an int")
    var under: Dictionary = protocol.call("fit_to_declared_type", -2.9999999999999996, TYPE_INT)
    if not under["ok"] or under["value"] != -3:
        failures.append("A float a hair under a negative whole number must fit that number")
    var over: Dictionary = protocol.call("fit_to_declared_type", -3.0000000000000004, TYPE_INT)
    if not over["ok"] or over["value"] != -3:
        failures.append("A float a hair past a negative whole number must fit that number")
    var fractional: Dictionary = protocol.call("fit_to_declared_type", 1.5, TYPE_INT)
    if fractional["ok"]:
        failures.append("A fractional float must not fit an int")
    if not str(fractional.get("message", "")).contains("whole"):
        failures.append("A refused fraction must say what is wrong with it")
    for wild in [INF, -INF, NAN]:
        var boundless: Dictionary = protocol.call("fit_to_declared_type", wild, TYPE_INT)
        if boundless["ok"]:
            failures.append("%s must not fit an int" % str(wild))
    var untyped: Dictionary = protocol.call("fit_to_declared_type", "anything", TYPE_NIL)
    if not untyped["ok"] or untyped["value"] != "anything":
        failures.append("An undeclared type must take the value as it is")

## An editor screenshot is one image of several windows.
##
## On a real desktop the editor's dialogs are native windows of their own — the pinned 4.7.2
## reports `is_embedded() == false` for the "not a scene file" confirmation — so the base control's
## viewport texture is the editor *behind* whatever is being asked. A capture that reads only that
## texture shows an editor with nothing wrong with it while a modal is waiting for an answer.
## Compositing is the arithmetic that puts them back together, and it is arithmetic, so it is
## checked here rather than against a booted editor with a display.
func _test_frame_composite(failures: Array[String]) -> void:
    var protocol := _load_protocol(failures)
    if protocol == null:
        return
    var red := Color(1, 0, 0)
    var blue := Color(0, 0, 1)

    var composed: Image = protocol.call("compose_frame", _filled(8, 8, red), [
        {"image": _filled(2, 2, blue), "offset": Vector2i(3, 3)}
    ])
    if composed.get_size() != Vector2i(8, 8):
        failures.append("A composite keeps the size of the window it is drawn over")
    if composed.get_pixel(3, 3) != blue or composed.get_pixel(4, 4) != blue:
        failures.append("A window must be drawn where it sits on screen")
    if composed.get_pixel(2, 2) != red or composed.get_pixel(5, 5) != red:
        failures.append("A window must not be drawn past its own edges")

    var clipped: Image = protocol.call("compose_frame", _filled(8, 8, red), [
        {"image": _filled(4, 4, blue), "offset": Vector2i(6, 6)}
    ])
    if clipped.get_pixel(7, 7) != blue or clipped.get_pixel(5, 5) != red:
        failures.append("A window overhanging the screen must draw the part that overlaps")

    var negative: Image = protocol.call("compose_frame", _filled(8, 8, red), [
        {"image": _filled(4, 4, blue), "offset": Vector2i(-2, -2)}
    ])
    if negative.get_pixel(0, 0) != blue or negative.get_pixel(2, 2) != red:
        failures.append("A window starting off the top left must draw the part that overlaps")

    var outside: Image = protocol.call("compose_frame", _filled(8, 8, red), [
        {"image": _filled(2, 2, blue), "offset": Vector2i(40, 40)}
    ])
    if outside.get_pixel(7, 7) != red:
        failures.append("A window entirely off the screen must leave the screen alone")

    var stacked: Image = protocol.call("compose_frame", _filled(8, 8, red), [
        {"image": _filled(4, 4, blue), "offset": Vector2i(0, 0)},
        {"image": _filled(2, 2, Color(0, 1, 0)), "offset": Vector2i(0, 0)}
    ])
    if stacked.get_pixel(0, 0) != Color(0, 1, 0) or stacked.get_pixel(3, 3) != blue:
        failures.append("Windows must be composited in the order they are given")

    var alone: Image = protocol.call("compose_frame", _filled(8, 8, red), [])
    if alone.get_pixel(4, 4) != red:
        failures.append("A capture with no windows over it must be the window itself")

    var tags: Dictionary = protocol.get("TAG_FOR_TYPE")
    for declared in tags:
        var tag: String = tags[declared]
        var answered: Dictionary = protocol.call("decode", {"type": tag, "value": null})
        if str(answered.get("message", "")).contains("Unknown value type"):
            failures.append("%s is not a tag decode knows" % tag)
    var wrong: Dictionary = protocol.call(
        "fit_to_declared_type", "#5c8a3c", TYPE_COLOR
    )
    if wrong.get("ok", true):
        failures.append("a string is not a Color")
    for named in ["expected Color", '"type": "color"', "#5c8a3c", "hex string"]:
        if not str(wrong.get("message", "")).contains(named):
            failures.append("a colour under the wrong tag must name %s" % named)
    var number: Dictionary = protocol.call("fit_to_declared_type", "3", TYPE_INT)
    if not str(number.get("message", "")).contains('"type": "int"'):
        failures.append("an int under the wrong tag names the int tag")
    if not str(protocol.call("under_the_tag_it_takes", TYPE_CALLABLE, "x")).is_empty():
        failures.append("a type with no tag must gain nothing")

## A solid image of one colour, in the format a viewport texture is read back as.
func _filled(width: int, height: int, colour: Color) -> Image:
    var image := Image.create(width, height, false, Image.FORMAT_RGBA8)
    image.fill(colour)
    return image
