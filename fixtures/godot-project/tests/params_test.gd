extends SceneTree

# What the editor commands decide before they touch the editor.
#
# `params.gd` is the half of the addon that needs no editor, so it is loaded from source rather than
# staged and every refusal it can make is checked in a second. Before it existed, all of this lived
# inside `plugin.gd`, which extends EditorPlugin — so a `tile_size` of zero, an atlas coordinate off
# the end of its grid, and an unknown key name each cost a real editor boot to reach, and the
# 50-second acceptance suite was the only instrument that could reach one.

## Staged into the fixture project by `scripts/godot-test.mjs`, fresh from source for this run.
##
## `params.gd` preloads `protocol.gd`, and GDScript resolves a preload against `res://` at parse
## time, so the two have to sit where the shipped addon sits before either can be loaded at all.
const PARAMS_SOURCE := "res://addons/gofer/params.gd"

func _initialize() -> void:
    var failures: Array[String] = []
    var params := _load_params(failures)
    if params != null:
        _test_tile_size(params, failures)
        _test_atlas_coords(params, failures)
        _test_shapes(params, failures)
        _test_input_events(params, failures)
        _test_check_declared(params, failures)
    if failures.is_empty():
        print("Gofer Godot command parameters passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

## Loads the staged `params.gd`. The staging is a copy of the shipped source made for this run, so
## there is no second copy for this to drift from.
func _load_params(failures: Array[String]) -> GDScript:
    if not ResourceLoader.exists(PARAMS_SOURCE):
        failures.append("The addon params script is not at %s" % PARAMS_SOURCE)
        return null
    return load(PARAMS_SOURCE) as GDScript

## The code a refusal carries, or "" when the answer is not one.
func _refusal(answer: Variant) -> String:
    if typeof(answer) != TYPE_DICTIONARY:
        return ""
    var failure: Variant = (answer as Dictionary).get("_gofer_error", null)
    if typeof(failure) != TYPE_DICTIONARY:
        return ""
    return str((failure as Dictionary).get("code", ""))

func _test_tile_size(params: GDScript, failures: Array[String]) -> void:
    # One number, two numbers, and the default when a command names none.
    if params.call("tile_size", {})["value"] != Vector2i(16, 16):
        failures.append("A command naming no tileSize must take the 16x16 default")
    if params.call("tile_size", {"tileSize": 32})["value"] != Vector2i(32, 32):
        failures.append("One number is a square tile")
    if params.call("tile_size", {"tileSize": [24, 8]})["value"] != Vector2i(24, 8):
        failures.append("Two numbers are width and height")
    # A tile with no area is not a tile, and neither is a sentence.
    if _refusal(params.call("tile_size", {"tileSize": 0})) != "invalid_params":
        failures.append("A tileSize of zero must be refused")
    if _refusal(params.call("tile_size", {"tileSize": [16, -1]})) != "invalid_params":
        failures.append("A negative tileSize must be refused")
    if _refusal(params.call("tile_size", {"tileSize": "big"})) != "invalid_params":
        failures.append("A tileSize that is not numbers must be refused")

func _test_atlas_coords(params: GDScript, failures: Array[String]) -> void:
    var grid := Vector2i(4, 4)
    var empty: Variant = params.call("atlas_coords", {}, "tiles", grid)
    if (empty["value"] as Array).size() != 0:
        failures.append("A command naming no tiles asks for none")
    var pair: Variant = params.call("atlas_coords", {"tiles": [[1, 2]]}, "tiles", grid)
    if (pair["value"] as Array)[0] != Vector2i(1, 2):
        failures.append("A [column, row] pair becomes one coordinate")
    # Off the end of the atlas is its own code, because it is the one a caller can act on.
    if _refusal(params.call("atlas_coords", {"tiles": [[9, 0]]}, "tiles", grid)) \
            != "tile_out_of_atlas":
        failures.append("A tile outside the atlas must say so by name")
    if _refusal(params.call("atlas_coords", {"tiles": [[1]]}, "tiles", grid)) != "invalid_params":
        failures.append("An entry that is not a pair must be refused")
    if _refusal(params.call("atlas_coords", {"tiles": "all"}, "tiles", grid)) != "invalid_params":
        failures.append("Tiles that are not a list must be refused")

func _test_shapes(params: GDScript, failures: Array[String]) -> void:
    var rectangle: Variant = params.call("build_shape", "RectangleShape2D", {"size": [8, 4]})
    if not (rectangle["value"] is RectangleShape2D) \
            or (rectangle["value"] as RectangleShape2D).size != Vector2(8, 4):
        failures.append("A RectangleShape2D takes its size from the command")
    var circle: Variant = params.call("build_shape", "CircleShape2D", {"radius": 3})
    if not (circle["value"] is CircleShape2D) \
            or not is_equal_approx((circle["value"] as CircleShape2D).radius, 3.0):
        failures.append("A CircleShape2D takes its radius from the command")
    # A shape with no dimensions is refused rather than built at some default the caller cannot see.
    if _refusal(params.call("build_shape", "CircleShape2D", {})) != "invalid_params":
        failures.append("A CircleShape2D with no radius must be refused")
    if _refusal(params.call("build_shape", "RectangleShape2D", {"size": [8]})) != "invalid_params":
        failures.append("A RectangleShape2D with one number must be refused")
    # And the refusal carries the shape it wanted. `size` is optional in the parameter table because
    # four of the five shapes do not take one, so the table cannot say a rectangle needs it and this
    # sentence is the only place a caller hears it. Two live turns sent `create_shape` with a
    # shapeType and no dimensions at all, twice each, and read "takes size as two numbers" without
    # writing one.
    for missing in [
        ["RectangleShape2D", "\"size\": [32, 32]"],
        ["CircleShape2D", "\"radius\": 8"],
        ["CapsuleShape2D", "\"radius\": 8, \"height\": 32"],
        ["SegmentShape2D", "\"points\": [0, 0, 64, 0]"],
    ]:
        var said: String = params.call("build_shape", missing[0], {})["_gofer_error"]["message"]
        if not said.contains(missing[1]):
            failures.append("%s must be refused with an example: %s" % [missing[0], said])
    # A world boundary is the infinite floor a level rests on, and takes nothing.
    if not (params.call("build_shape", "WorldBoundaryShape2D", {})["value"] \
            is WorldBoundaryShape2D):
        failures.append("A world boundary is built from no dimensions at all")

## The codec answers with the protocol's own `{ok, events, message}` rather than a `_gofer_error`,
## because it is `Protocol.decode_failed` underneath — the handler turns a refusal into one.
func _test_input_events(params: GDScript, failures: Array[String]) -> void:
    var decoded: Dictionary = params.call("decode_input_events", [{"kind": "key", "key": "Enter"}])
    if not decoded["ok"]:
        failures.append("Enter is Godot's own name for the key and must decode: %s" % str(decoded))
    elif (decoded["events"] as Array).size() != 1:
        failures.append("One event decodes to one event")
    # The name a browser uses, which is the mistake the key vocabulary exists to prevent.
    var browser: Dictionary = params.call(
        "decode_input_events", [{"kind": "key", "key": "Return"}]
    )
    if browser["ok"]:
        failures.append("Return is the browser's name and must be refused")
    elif not str(browser["message"]).contains("Return"):
        failures.append("A refused key must name the key: %s" % str(browser))
    if params.call("decode_input_events", "A")["ok"]:
        failures.append("Events that are not a list must be refused")

    # The round trip: what the editor answers with is what a caller may send back.
    var event := InputEventKey.new()
    event.keycode = OS.find_keycode_from_string("Escape")
    var encoded: Variant = params.call("encode_input_events", [event])
    if (encoded as Array).size() != 1 or (encoded as Array)[0]["key"] != "Escape":
        failures.append("An encoded key event names the key the way Godot does: %s" % str(encoded))


## The backstop behind the router's own check, which used to cost a booted editor to reach.
##
## Every refusal here is arithmetic over `COMMAND_PARAMS`, and the table is generated beside it, so
## a name no handler reads and a required name left out are both answerable from source. A command
## the table does not carry is not checked at all — absence is "not declared yet", never "takes
## nothing" — and that distinction is the one a real editor was previously the only witness to.
func _test_check_declared(params: GDScript, failures: Array[String]) -> void:
    if not params.call("check_declared", "scene.open", {"path": "res://a.tscn"}).is_empty():
        failures.append("A call naming exactly what it declares is not refused")

    var unknown: Dictionary = params.call(
        "check_declared", "scene.open", {"path": "res://a.tscn", "nope": 1}
    )
    if unknown.is_empty():
        failures.append("A parameter no handler reads must be refused")
    else:
        var error: Dictionary = unknown["_gofer_error"]
        if error["code"] != "unknown_param":
            failures.append("An unknown name is refused as unknown_param: %s" % str(error))
        elif not str(error["message"]).contains("nope"):
            failures.append("A refusal names the parameter: %s" % str(error))

    var missing: Dictionary = params.call("check_declared", "scene.open", {})
    if missing.is_empty():
        failures.append("A required parameter left out must be refused")
    else:
        var error: Dictionary = missing["_gofer_error"]
        if error["code"] != "missing_param":
            failures.append("A required name is refused as missing_param: %s" % str(error))
        elif not str(error["message"]).contains("path"):
            failures.append("A refusal names the parameter: %s" % str(error))

    # Absence is not emptiness: an undeclared command is unchecked, so adding one cannot silently
    # start refusing its own parameters.
    if not params.call("check_declared", "scene.not_a_command", {"anything": 1}).is_empty():
        failures.append("A command the table does not carry is not checked")

    # `expectedRevision` and `timeoutMs` ride the envelope, and the table leaves them out on
    # purpose. A caller that sends one among the parameters instead has made the mistake this
    # refuses — the field never reaches a handler from there, so accepting it would be silence.
    if params.call("check_declared", "scene.save", {"expectedRevision": 3}).is_empty():
        failures.append("An envelope field sent as a parameter must be refused")
