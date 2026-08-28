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
        _test_climbing_paths(params, failures)
        _test_readback(params, failures)
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


## The wire's own backstop against a path that leaves the project.
##
## Godot resolves `res://../` out of the project and follows it: measured on the pinned 4.7.2,
## `Image.save_png("res://../escaped.png")` wrote a directory above the project and answered OK.
## The router refuses this in Rust before the socket, so this guard only ever fires for a caller
## with no router in front of it — which is exactly the caller the acceptance suite cannot be.
##
## The distinction it has to keep is prose against paths. A Label's `text` may say `../docs/readme`
## and mean nothing by it, so an unschemed string counts as a path only under a key that names one.
func _test_climbing_paths(params: GDScript, failures: Array[String]) -> void:
    var climbs: Array = [
        ["", "res://../escaped.png"],
        ["", "user://../escaped.tres"],
        ["path", "../outside.tscn"],
        ["path", ".."],
        ["files", "a/../../b.gd"]
    ]
    for case: Array in climbs:
        if not params.call("climbs_out_of_the_project", case[0], case[1]):
            failures.append("%s under `%s` climbs out" % [case[1], case[0]])

    var stays: Array = [
        ["", "res://scenes/main.tscn"],
        ["path", "res://a/b.gd"],
        ["text", "../docs/readme"],
        ["text", ".."],
        ["path", "a/b/c.gd"]
    ]
    for case: Array in stays:
        if params.call("climbs_out_of_the_project", case[0], case[1]):
            failures.append("%s under `%s` stays inside" % [case[1], case[0]])

    # The walk finds the first climbing path anywhere in the parameters, however deeply it is held.
    var nested := {"files": [{"path": "res://ok.gd"}, {"path": "res://../out.gd"}]}
    if params.call("a_path_that_climbs_out", "", nested) != "res://../out.gd":
        failures.append("The walk names the climbing path it found: %s" % str(nested))
    if not str(params.call("a_path_that_climbs_out", "", {"text": "../fine"})).is_empty():
        failures.append("Prose under a key that names no file is not a path")


## Whether a value read back out of Godot is the value that was written into it, and what to say
## when it is not.
##
## Every fact in here was measured on a real editor and then only ever re-proved by booting one.
## None of the arithmetic needs an editor to state: a float property stores 32 bits so a double
## drifts, an integer written to a float reads back as a float, and a cleared object property is a
## TYPE_OBJECT variant pointing at nothing rather than TYPE_NIL.
func _test_readback(params: GDScript, failures: Array[String]) -> void:
    var same: Array = [
        [5, 5.0],
        [1.0, 1.0 + 1e-9],
        [Vector2(1, 2), Vector2(1, 2)],
        [Color(1, 0, 0), Color(1, 0, 0)],
        [Transform2D.IDENTITY, Transform2D.IDENTITY]
    ]
    for case: Array in same:
        if not params.call("same_value", case[0], case[1]):
            failures.append("%s reads back as %s" % [str(case[0]), str(case[1])])

    var differ: Array = [[Vector2(1, 2), Vector2(1, 3)], [1.0, 2.0], ["a", "b"], [1, "1"]]
    for case: Array in differ:
        if params.call("same_value", case[0], case[1]):
            failures.append("%s does not read back as %s" % [str(case[0]), str(case[1])])

    # A number is not a string that looks like one, and a null is not an empty string.
    if params.call("is_null_object", null) or params.call("is_null_object", 0):
        failures.append("Only an object variant pointing at nothing is a null object")

    # Godot appends a number rather than refusing a name clash, and only an all-digit tail counts.
    if not str(params.call("made_unique", "UI", "UI2")).contains("already called UI"):
        failures.append("A name that came back with a number on it names the clash")
    if not str(params.call("made_unique", "Player", "PlayerShip")).is_empty():
        failures.append("A tail that is not digits is not Godot making a name unique")
    if not str(params.call("made_unique", "UI", "UI")).is_empty():
        failures.append("A name that came back unchanged is not a clash")

    # A property no scene holds is answered by name; a size is answered by its floor, and only when
    # the value that came back is the larger one.
    if not str(params.call("instead_of", "anchors_preset", 3, 0)).contains("anchor_left"):
        failures.append("anchors_preset names the four properties to write instead")
    if not str(params.call("instead_of", "anchors_preset", 3, 0)).contains("layout_mode"):
        failures.append("anchors_preset names the mode that makes the same write take")
    # And the case that mode cannot reach. Measured on a real editor: a Control inside a Container
    # is held at layout_mode 2, a write of 1 reads back 2, and the preset reads back 0 whatever is
    # tried — so a caller there needs the container's own sizing, not the mode.
    if not str(params.call("instead_of", "anchors_preset", 3, 0)).contains("size_flags_horizontal"):
        failures.append("anchors_preset names what to do inside a Container")

    # A dialog with a launch queued behind it is not the same situation as one that stopped a call
    # before it started anything, and the two used to share a sentence.
    var waiting := str(params.call("after_a_dialog", true))
    for named in ["waiting behind this dialog", "session.answer_dialog", "second one"]:
        if not waiting.contains(named):
            failures.append("a dialog holding a launch must name %s" % named)
    var nothing := str(params.call("after_a_dialog", false))
    if not nothing.contains("Nothing has started"):
        failures.append("a dialog that stopped a call before it started anything must say so")
    if not nothing.contains("session.answer_dialog"):
        failures.append("every dialog must name the call that answers one")
    if nothing.contains("waiting behind"):
        failures.append("a call that started nothing must not claim a launch is queued")

    # The script has the method and the node does not, which the refusal used to state as two
    # clauses that contradict each other.
    var stale := str(params.call("a_method_the_script_has_and_the_node_has_not", "_on_body_entered", ["_on_body_entered", "_ready"]))
    for named in ["_on_body_entered", "older instance", "scene.save", "scene.reload"]:
        if not stale.contains(named):
            failures.append("a stale script instance must name %s" % named)
    # A method the script really does not declare is the ordinary case and gains nothing here.
    if not str(params.call("a_method_the_script_has_and_the_node_has_not", "_on_area_entered", ["_on_body_entered", "_ready"])).is_empty():
        failures.append("a method the script does not declare is not a stale instance")
    if not str(params.call("a_method_the_script_has_and_the_node_has_not", "", ["_ready"])).is_empty():
        failures.append("no method named is not a stale instance")

    # The scene a caller is creating is the one the project starts with. Three of the four turns
    # that met `already_exists` named exactly this path.
    var main_again := str(params.call("also_the_main_scene", "res://main.tscn", "res://main.tscn"))
    for named in ["main scene", "application/run/main_scene", "project.set_setting"]:
        if not main_again.contains(named):
            failures.append("replacing the main scene must name %s" % named)
    # Any other path, and a project that names none, gain nothing.
    if not str(params.call("also_the_main_scene", "res://coin.tscn", "res://main.tscn")).is_empty():
        failures.append("a scene that is not the main scene gains no sentence")
    if not str(params.call("also_the_main_scene", "res://main.tscn", "")).is_empty():
        failures.append("a project with no main scene gains no sentence")

    # A scene path written where a class name belongs. Every clause is what the turn that met this
    # went looking for and did not find: what a type is here, where a scene goes instead, and that
    # inheriting one scene from another is not something this tool does.
    var as_scene := str(params.call("a_type_that_is_a_scene", "res://pickup.tscn"))
    for named in ["res://pickup.tscn", "class name", "node.instantiate", "inherit"]:
        if not as_scene.contains(named):
            failures.append("a scene path written as a type must name %s" % named)
    if not str(params.call("a_type_that_is_a_scene", "scenes/coin.tscn")).contains("node.instantiate"):
        failures.append("a scene path without the scheme is still a scene path")
    # And a real class name is left entirely alone, or every mistyped type gains a paragraph.
    for plain in ["Node2D", "Area2D", "CharacterBody2D", "Contrl"]:
        if not str(params.call("a_type_that_is_a_scene", plain)).is_empty():
            failures.append("%s is a class name and must gain no sentence" % plain)
    var grew: String = params.call(
        "grew_to_its_minimum", "size", Vector2(0, 0), Vector2(1, 23)
    )
    if not grew.contains("custom_minimum_size"):
        failures.append("A size held at its floor says how to lower the floor")
    if not str(params.call("grew_to_its_minimum", "size", Vector2(64, 64), Vector2(8, 8))).is_empty():
        failures.append("A size that came back smaller is a different thing entirely")
    if not str(params.call("grew_to_its_minimum", "position", Vector2(0, 0), Vector2(1, 1))).is_empty():
        failures.append("Only `size` has this floor")

    # The hint strings are the ones a real 4.7.2 engine publishes for these properties.
    var out_of_range: String = params.call(
        "outside_the_values_it_takes", "grow_horizontal", "Left,Right,Both", 3
    )
    for named in ["3 is not one", "grow_horizontal", "0 Left", "1 Right", "2 Both"]:
        if not out_of_range.contains(named):
            failures.append("an out-of-range enum must name %s" % named)
    # In range is not this refusal, whichever shape the hint string is written in.
    for held in [0, 1, 2]:
        if not str(
            params.call("outside_the_values_it_takes", "grow_horizontal", "Left,Right,Both", held)
        ).is_empty():
            failures.append("%d is one of grow_horizontal's values" % held)
    # `anchors_preset` numbers its own names, and 15 is Full Rect — a value it has. Its refusal is
    # about layout_mode, and a list of seventeen numbers would bury the sentence that says so.
    var presets := (
        "Custom:-1,Full Rect:15,Top Left:0,Top Right:1,Bottom Right:3,Bottom Left:2,Center Left:4"
    )
    for held in [-1, 15, 0, 3]:
        if not str(
            params.call("outside_the_values_it_takes", "anchors_preset", presets, held)
        ).is_empty():
            failures.append("anchors_preset holds %d and must gain no list" % held)
    if not str(
        params.call("outside_the_values_it_takes", "anchors_preset", presets, 99)
    ).contains("-1 Custom"):
        failures.append("an explicitly numbered enum keeps the numbers it publishes")
    if not str(params.call("instead_of", "anchors_preset", 15, 0, presets)).contains("layout_mode"):
        failures.append("the property with its own sentence keeps it")
    if not str(params.call("instead_of", "grow_horizontal", 3, 1, "Left,Right,Both")).contains(
        "2 Both"
    ):
        failures.append("instead_of reaches the enum sentence")
    # A property with no enum hint, and a value that is not a number, are both left alone.
    if not str(params.call("outside_the_values_it_takes", "text", "", 3)).is_empty():
        failures.append("a property with no enum hint gains nothing")
    if not str(
        params.call("outside_the_values_it_takes", "grow_horizontal", "Left,Right,Both", "Both")
    ).is_empty():
        failures.append("a value that is not a number is a type_mismatch, not this")

    var reached: String = params.call(
        "as_far_as_the_path_goes",
        "/Main/PauseMenu",
        PackedStringArray(["Panel", "Title"]),
        "Box"
    )
    for named in ["/Main/PauseMenu", "Panel, Title", "called Box"]:
        if not reached.contains(named):
            failures.append("a path that stopped matching must name %s" % named)
    if not str(
        params.call("as_far_as_the_path_goes", "/Main/Player", PackedStringArray(), "Sprite")
    ).contains("no children at all"):
        failures.append("a node with nothing under it says so rather than listing nothing")
    # Long enough to be cut, and the count of what was cut is part of the sentence.
    var many := PackedStringArray()
    for index in range(20):
        many.append("Child%d" % index)
    var trimmed: String = params.call("as_far_as_the_path_goes", "/Main", many, "Missing")
    for named in ["Child0", "Child11", "and 8 more"]:
        if not trimmed.contains(named):
            failures.append("a long list must name %s" % named)
    if trimmed.contains("Child12"):
        failures.append("and it must stop at twelve")
    # Nothing to say is said as nothing, so the caller's sentence is unchanged.
    if not str(
        params.call("as_far_as_the_path_goes", "", PackedStringArray(["A"]), "B")
    ).is_empty():
        failures.append("a path that reached nowhere gains no clause")

    # `layout_mode` is decided by the parent, so the sentence is about the three shapes rather than
    # about the number written. It answers whatever value came in, in range or not.
    for asked in [1, 9]:
        var placed: String = params.call("instead_of", "layout_mode", asked, 3)
        for named in ["node.reparent", "Container", "size_flags_horizontal", "uncontrolled"]:
            if not placed.contains(named):
                failures.append("layout_mode asked %d must name %s" % [asked, named])
