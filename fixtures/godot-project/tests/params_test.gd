extends SceneTree


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
        _test_moved_from_the_editor(params, failures)
        _test_read_by_both_halves(params, failures)
        _test_node_decisions(params, failures)
        _test_tileset_plan(params, failures)
        _test_texture_plan(params, failures)
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

## The sentence a refusal carries, or "" when the answer is not one. Two refusals may share a code
## and mean different things — a texture too wide and a texture too heavy are both `invalid_params`
## — so a test that only reads the code cannot tell them apart.
func _said(answer: Variant) -> String:
    if typeof(answer) != TYPE_DICTIONARY:
        return ""
    var failure: Variant = (answer as Dictionary).get("_gofer_error", null)
    if typeof(failure) != TYPE_DICTIONARY:
        return ""
    return str((failure as Dictionary).get("message", ""))

func _test_tile_size(params: GDScript, failures: Array[String]) -> void:
    if params.call("tile_size", {})["value"] != Vector2i(16, 16):
        failures.append("A command naming no tileSize must take the 16x16 default")
    if params.call("tile_size", {"tileSize": 32})["value"] != Vector2i(32, 32):
        failures.append("One number is a square tile")
    if params.call("tile_size", {"tileSize": [24, 8]})["value"] != Vector2i(24, 8):
        failures.append("Two numbers are width and height")
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
    if _refusal(params.call("build_shape", "CircleShape2D", {})) != "invalid_params":
        failures.append("A CircleShape2D with no radius must be refused")
    if _refusal(params.call("build_shape", "RectangleShape2D", {"size": [8]})) != "invalid_params":
        failures.append("A RectangleShape2D with one number must be refused")
    for missing in [
        ["RectangleShape2D", "\"size\": [32, 32]"],
        ["CircleShape2D", "\"radius\": 8"],
        ["CapsuleShape2D", "\"radius\": 8, \"height\": 32"],
        ["SegmentShape2D", "\"points\": [0, 0, 64, 0]"],
    ]:
        var said: String = params.call("build_shape", missing[0], {})["_gofer_error"]["message"]
        if not said.contains(missing[1]):
            failures.append("%s must be refused with an example: %s" % [missing[0], said])
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
    var browser: Dictionary = params.call(
        "decode_input_events", [{"kind": "key", "key": "Return"}]
    )
    if browser["ok"]:
        failures.append("Return is the browser's name and must be refused")
    elif not str(browser["message"]).contains("Return"):
        failures.append("A refused key must name the key: %s" % str(browser))
    if params.call("decode_input_events", "A")["ok"]:
        failures.append("Events that are not a list must be refused")

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

    if not params.call("check_declared", "scene.not_a_command", {"anything": 1}).is_empty():
        failures.append("A command the table does not carry is not checked")

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

    if params.call("is_null_object", null) or params.call("is_null_object", 0):
        failures.append("Only an object variant pointing at nothing is a null object")

    if not str(params.call("made_unique", "UI", "UI2")).contains("already called UI"):
        failures.append("A name that came back with a number on it names the clash")
    if not str(params.call("made_unique", "Player", "PlayerShip")).is_empty():
        failures.append("A tail that is not digits is not Godot making a name unique")
    if not str(params.call("made_unique", "UI", "UI")).is_empty():
        failures.append("A name that came back unchanged is not a clash")

    if not str(params.call("instead_of", "anchors_preset", 3, 0)).contains("anchor_left"):
        failures.append("anchors_preset names the four properties to write instead")
    if not str(params.call("instead_of", "anchors_preset", 3, 0)).contains("layout_mode"):
        failures.append("anchors_preset names the mode that makes the same write take")
    if not str(params.call("instead_of", "anchors_preset", 3, 0)).contains("size_flags_horizontal"):
        failures.append("anchors_preset names what to do inside a Container")

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

    var stale := str(params.call("a_method_the_script_has_and_the_node_has_not", "_on_body_entered", ["_on_body_entered", "_ready"]))
    for named in ["_on_body_entered", "older instance", "scene.save", "scene.reload"]:
        if not stale.contains(named):
            failures.append("a stale script instance must name %s" % named)
    if not str(params.call("a_method_the_script_has_and_the_node_has_not", "_on_area_entered", ["_on_body_entered", "_ready"])).is_empty():
        failures.append("a method the script does not declare is not a stale instance")
    if not str(params.call("a_method_the_script_has_and_the_node_has_not", "", ["_ready"])).is_empty():
        failures.append("no method named is not a stale instance")

    var main_again := str(params.call("also_the_main_scene", "res://main.tscn", "res://main.tscn"))
    for named in ["main scene", "application/run/main_scene", "project.set_setting"]:
        if not main_again.contains(named):
            failures.append("replacing the main scene must name %s" % named)
    if not str(params.call("also_the_main_scene", "res://coin.tscn", "res://main.tscn")).is_empty():
        failures.append("a scene that is not the main scene gains no sentence")
    if not str(params.call("also_the_main_scene", "res://main.tscn", "")).is_empty():
        failures.append("a project with no main scene gains no sentence")

    var as_scene := str(params.call("a_type_that_is_a_scene", "res://pickup.tscn"))
    for named in ["res://pickup.tscn", "class name", "node.instantiate", "inherit"]:
        if not as_scene.contains(named):
            failures.append("a scene path written as a type must name %s" % named)
    if not str(params.call("a_type_that_is_a_scene", "scenes/coin.tscn")).contains("node.instantiate"):
        failures.append("a scene path without the scheme is still a scene path")
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

    var out_of_range: String = params.call(
        "outside_the_values_it_takes", "grow_horizontal", "Left,Right,Both", 3
    )
    for named in ["3 is not one", "grow_horizontal", "0 Left", "1 Right", "2 Both"]:
        if not out_of_range.contains(named):
            failures.append("an out-of-range enum must name %s" % named)
    for held in [0, 1, 2]:
        if not str(
            params.call("outside_the_values_it_takes", "grow_horizontal", "Left,Right,Both", held)
        ).is_empty():
            failures.append("%d is one of grow_horizontal's values" % held)
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
    var many := PackedStringArray()
    for index in range(20):
        many.append("Child%d" % index)
    var trimmed: String = params.call("as_far_as_the_path_goes", "/Main", many, "Missing")
    for named in ["Child0", "Child11", "and 8 more"]:
        if not trimmed.contains(named):
            failures.append("a long list must name %s" % named)
    if trimmed.contains("Child12"):
        failures.append("and it must stop at twelve")
    if not str(
        params.call("as_far_as_the_path_goes", "", PackedStringArray(["A"]), "B")
    ).is_empty():
        failures.append("a path that reached nowhere gains no clause")

    for asked in [1, 9]:
        var placed: String = params.call("instead_of", "layout_mode", asked, 3)
        for named in ["node.reparent", "Container", "size_flags_horizontal", "uncontrolled"]:
            if not placed.contains(named):
                failures.append("layout_mode asked %d must name %s" % [asked, named])


## The decisions that used to sit inside `plugin.gd`, reached without an editor.
##
## Each of these was written behind `extends EditorPlugin` and touched no editor at all — a texture
## size refused for being too big, a setting name that belongs to another command, a path given its
## `res://` prefix. Reaching one cost a staged addon and an xvfb boot. They cost a second here, and
## this is the test that says the move kept their answers.
func _test_moved_from_the_editor(params: GDScript, failures: Array[String]) -> void:
    for asked: Variant in [8, [8, 8]]:
        var square: Dictionary = params.call("texture_size", asked)
        if square.get("value") != Vector2i(8, 8):
            failures.append("texture_size %s must be 8x8, and is %s" % [asked, square])
    if _refusal(params.call("texture_size", "16")) != "invalid_params":
        failures.append("a texture size that is neither a number nor a pair is refused")
    if _refusal(params.call("texture_size", 0)) != "invalid_params":
        failures.append("a texture with no pixels on a side is refused")
    var wide: Dictionary = params.call("texture_size", [8192, 1])
    if _refusal(wide) != "invalid_params" or not _said(wide).contains("on a side"):
        failures.append("a texture past the edge limit is refused for its edge, not %s" % wide)
    var heavy: Dictionary = params.call("texture_size", [4096, 4096])
    if _refusal(heavy) != "invalid_params" or not _said(heavy).contains("at most"):
        failures.append("a texture inside both edges is refused for its pixels, not %s" % heavy)

    for asked: Variant in ["res://a.png", "a.png", "./a.png", "/a.png"]:
        var wanted: String = "res://a.png"
        if params.call("as_resource_path", asked) != wanted:
            failures.append("as_resource_path %s must be %s" % [asked, wanted])
    if params.call("as_resource_path", "  ") != "":
        failures.append("a path of nothing but spaces names nothing")

    var listed: Dictionary = params.call("rescan_paths_param", {"path": ["a.png", "a.png", ""]})
    if listed.get("value") != ["res://a.png"]:
        failures.append("a rescan list is prefixed, deduplicated and emptied, not %s" % listed)
    if (params.call("rescan_paths_param", {}) as Dictionary).get("value") != []:
        failures.append("a rescan with no path at all asks for nothing")
    if _refusal(params.call("rescan_paths_param", {"path": 7})) != "invalid_params":
        failures.append("a rescan path that is not text is refused")
    var too_many: Array = []
    for index in range(300):
        too_many.append("a%d.png" % index)
    if _refusal(params.call("rescan_paths_param", {"path": too_many})) != "too_many_paths":
        failures.append("a rescan past the path limit is refused by its own code")

    for pair: Array in [
        ["autoload/Score", "project.set_autoload"],
        ["input/jump", "project.set_input_action"],
        ["editor_plugins/gofer", "project.set_plugin_enabled"],
        ["display/window/size/viewport_width", ""]
    ]:
        if params.call("reserved_setting_command", pair[0]) != pair[1]:
            failures.append("%s belongs to %s" % [pair[0], pair[1]])

    var words: PackedStringArray = params.call("words_of", "  Window   SIZE ")
    if Array(words) != ["window", "size"]:
        failures.append("a query is lowered, split and emptied, not %s" % words)
    if not params.call("name_holds_every_word", "display/window/size/viewport_width", words):
        failures.append("both words are in the name, in the other order")
    if params.call("name_holds_every_word", "display/window/vsync", words):
        failures.append("a name missing one of the words does not match")
    if not params.call("name_holds_every_word", "anything", params.call("words_of", "")):
        failures.append("no words matches everything")
    var asked: PackedStringArray = params.call("words_of", "show line numbers?")
    if Array(asked) != ["show", "line", "numbers"]:
        failures.append("a question mark is not part of the word before it, and %s says it is" % asked)
    if not params.call("name_holds_every_word", "text_editor/appearance/gutters/show_line_numbers", asked):
        failures.append("the setting the live turn could not find is found now")
    if Array(params.call("words_of", "show_line_numbers")) != ["show_line_numbers"]:
        failures.append("an underscored name is one word, not three")

    for pair: Array in [["/Main/", "/Main"], ["/Main///", "/Main"], ["/", "/"], [" /Main ", "/Main"]]:
        if params.call("batch_parent_key", pair[0]) != pair[1]:
            failures.append("batch_parent_key %s must be %s" % [pair[0], pair[1]])

    var unknown: Dictionary = params.call("unknown_command_error", "scene.fly")
    var said: Dictionary = unknown.get("_gofer_error", {})
    if said.get("code") != "unknown_command" or not str(said.get("message")).contains("scene.fly"):
        failures.append("an unknown command is named in its own refusal, not %s" % unknown)
    if said.get("retryable") != false:
        failures.append("an unknown command does not become known by being asked again")


## The two functions both halves of the addon read, written once.
##
## `authored_groups` and `icon_class` each existed twice, byte for byte — once in `plugin.gd` for
## the edited scene and once in `runtime.gd` for the running one. Both take a `Node` and neither
## asks it whether it is being edited or played, which is why one copy answers both. A `Node` is
## all this test needs, so the pair is now reachable without an editor or a game.
func _test_read_by_both_halves(params: GDScript, failures: Array[String]) -> void:
    var node := Node2D.new()
    node.name = "Coin"
    node.add_to_group("pickups")
    node.add_to_group("_edit_group_")
    var groups: Array = params.call("authored_groups", node)
    if groups != ["pickups"]:
        failures.append("an engine group is not one the author wrote, and %s says it is" % [groups])

    if params.call("icon_class", node) != "Node2D":
        failures.append("a node with no script is drawn as its own class")
    var named := GDScript.new()
    named.source_code = "class_name GoferProbeCoin\nextends Node2D\n"
    named.reload()
    node.set_script(named)
    if params.call("icon_class", node) != "GoferProbeCoin":
        failures.append("a script that names itself is what the node is drawn as")
    var anonymous := GDScript.new()
    anonymous.source_code = "extends Node2D\n"
    anonymous.reload()
    node.set_script(anonymous)
    if params.call("icon_class", node) != "Node2D":
        failures.append("a script with no class_name leaves the engine class showing")
    node.free()


## What the node commands work out about a node, none of which asks the editor.
##
## The second batch out of `plugin.gd`: which signals a node really has, which property a near miss
## meant, what a swap has to give back. All of it took a `Node`, none of it took an editor, and all
## of it cost an xvfb boot to reach.
func _test_node_decisions(params: GDScript, failures: Array[String]) -> void:
    var root := Node2D.new()
    root.name = "Main"
    var child := Sprite2D.new()
    child.name = "Player"
    root.add_child(child)

    if params.call("nearest_property", child, "Position") != "position":
        failures.append("a property misspelled by case is corrected to the real name")
    if params.call("nearest_property", child, "positionValue") != "position":
        failures.append("a name with something stuck on the end is corrected to the name")
    if params.call("nearest_property", child, "Positon") != "":
        failures.append("a typo inside a name is not a prefix of it, and is not guessed at")
    if params.call("nearest_property", child, "position") != "":
        failures.append("a property spelled exactly right has nothing to correct")
    if params.call("nearest_property", child, "flip_h") != "":
        failures.append("a property that is exactly right, underscores and all, is left alone")
    if params.call("nearest_property", child, "Transform") == "Transform":
        failures.append("an inspector heading is never offered as a property")
    if params.call("nearest_property", child, "pos") != "":
        failures.append("a stub too short to be a near miss is not guessed at")

    var refused: Dictionary = params.call(
        "property_not_found_error", child, "/Main/Player", "positionValue"
    )
    if _refusal(refused) != "property_not_found":
        failures.append("a property that is not there is refused by its own code")
    if not _said(refused).contains("Did you mean position?"):
        failures.append("a near miss is offered by name, not %s" % _said(refused))
    var nothing_near: Dictionary = params.call("property_not_found_error", child, "/Main/Player", "zzzz")
    if not _said(nothing_near).contains("node.inspect"):
        failures.append("a property with nothing near it is answered with how to list them all")

    var signals: Array = params.call("node_signals", child)
    for named in ["frame_changed", "ready"]:
        if not signals.has(named):
            failures.append("a node's signals must include %s: %s" % [named, signals])
    var offered: String = params.call("the_signals_it_does_have", child, "pressed")
    if not offered.contains("frame_changed"):
        failures.append("a signal that is not there is answered with the ones that are")

    var owned: Dictionary = {}
    params.call("who_owned_what", root, owned)
    if not owned.has("/Player"):
        failures.append("a swap records the owner of every child by path, not %s" % [owned])

    if params.call("instance_cycle", "res://main.tscn", "res://main.tscn").is_empty():
        failures.append("a scene instantiated inside itself is refused")
    if not str(params.call("instance_cycle", "res://main.tscn", "")).is_empty():
        failures.append("with no scene open there is no cycle to make")
    if not str(params.call("instance_cycle", "res://main.tscn", "res://other.tscn")).is_empty():
        failures.append("a scene that does not reach the open one is allowed")

    var quiet: String = params.call("why_the_editor_cannot_see_it", child, [] as Array[String])
    if quiet.contains("autoload"):
        failures.append("a session that registered no autoload does not mention them")
    var loud: String = params.call(
        "why_the_editor_cannot_see_it", child, ["Score"] as Array[String]
    )
    if not loud.contains("Score") or not loud.contains("godot_session"):
        failures.append("a registered autoload is named, with what to do about it")

    root.free()


## What `resource.create_tileset` refuses, and what it cuts when it refuses nothing.
##
## Every one of these five used to sit inside `EditorPlugin`, where reaching one cost a real editor
## boot — and four of them were reached by nothing at all.
func _test_tileset_plan(params: GDScript, failures: Array[String]) -> void:
    var atlas := Vector2i(32, 16)

    var whole: Dictionary = params.call("tileset_plan", {"tileSize": 16}, "res://a.png", atlas)
    var plan: Dictionary = whole.get("value", {})
    if plan.get("grid") != Vector2i(2, 1):
        failures.append("a 32x16 atlas cut at 16 is a 2x1 grid, not %s" % [plan.get("grid")])
    if plan.get("tiles") != [Vector2i(0, 0), Vector2i(1, 0)]:
        failures.append("naming no tiles cuts the whole grid, not %s" % [plan.get("tiles")])
    if not (plan.get("solid") as Array).is_empty():
        failures.append("naming no solid tiles gives collision to none of them")

    var all_solid: Dictionary = params.call(
        "tileset_plan", {"tileSize": 16, "solid": "all"}, "res://a.png", atlas
    )
    if all_solid["value"]["solid"] != all_solid["value"]["tiles"]:
        failures.append("solid: all is every tile the plan cuts")

    var too_big: Dictionary = params.call(
        "tileset_plan", {"tileSize": 64}, "res://a.png", atlas
    )
    if _refusal(too_big) != "tile_size_too_large":
        failures.append("an atlas that does not hold one tile is refused: %s" % [too_big])

    var too_many: Dictionary = params.call(
        "tileset_plan", {"tileSize": 1}, "res://a.png", Vector2i(4096, 4096)
    )
    if _refusal(too_many) != "too_many_tiles":
        failures.append("a grid past the tile cap is refused: %s" % [too_many])

    var undefined: Dictionary = params.call(
        "tileset_plan",
        {"tileSize": 16, "tiles": [[0, 0]], "solid": [[1, 0]]},
        "res://a.png",
        atlas
    )
    if _refusal(undefined) != "tile_not_defined":
        failures.append("a solid tile that is not being created is refused: %s" % [undefined])

    if _refusal(params.call("tileset_paths", {"texture": "res://a.png"})) != "invalid_params":
        failures.append("a tileset with no path is refused")
    if _refusal(
        params.call("tileset_paths", {"path": "res://a.tscn", "texture": "res://a.png"})
    ) != "invalid_params":
        failures.append("a tileset written anywhere but a .tres is refused")


## What `resource.create_texture` draws, and what it refuses to draw.
func _test_texture_plan(params: GDScript, failures: Array[String]) -> void:
    var drawn: Dictionary = params.call("texture_plan", {
        "path": "res://tile.png",
        "size": 8,
        "background": "skyblue",
        "rects": [{"x": 0, "y": 0, "width": 4, "height": 4, "color": "#8b5a2b"}],
    })
    var plan: Dictionary = drawn.get("value", {})
    if plan.get("size") != Vector2i(8, 8):
        failures.append("one number is both sides of the texture, not %s" % [plan.get("size")])
    if plan.get("background") != Color.SKY_BLUE:
        failures.append("a named background is that colour, not %s" % [plan.get("background")])
    var rects: Array = plan.get("rects", [])
    if rects.size() != 1 or rects[0]["area"] != Rect2i(0, 0, 4, 4):
        failures.append("a rect inside the canvas is drawn as written: %s" % [rects])

    var clipped: Dictionary = params.call("texture_plan", {
        "path": "res://tile.png",
        "size": 8,
        "rects": [{"x": 6, "y": 6, "width": 8, "height": 8, "color": "red"}],
    })
    if clipped["value"]["rects"][0]["area"] != Rect2i(6, 6, 2, 2):
        failures.append("a rect over the edge is clipped to the canvas")

    if _refusal(params.call("texture_plan", {"path": "res://t.tres", "size": 8})) != "invalid_params":
        failures.append("a texture written anywhere but a .png is refused")
    if _refusal(params.call("texture_plan", {"path": "res://t.png", "size": 8, "background": "notacolour"})) != "unsupported_color":
        failures.append("a background nobody can read is refused")

    var runaway: Array = []
    for _index in range(513):
        runaway.append({"x": 0, "y": 0, "width": 1, "height": 1, "color": "red"})
    var too_many: Dictionary = params.call(
        "texture_plan", {"path": "res://t.png", "size": 8, "rects": runaway}
    )
    if _refusal(too_many) != "too_many_rects":
        failures.append("a paint past the rect cap is refused: %s" % [too_many])

    var outside: Dictionary = params.call("texture_plan", {
        "path": "res://t.png",
        "size": 8,
        "rects": [{"x": 20, "y": 20, "width": 4, "height": 4, "color": "red"}],
    })
    if _refusal(outside) != "invalid_params":
        failures.append("a rect entirely off the canvas is refused: %s" % [outside])
