## The decisions the editor commands make before they touch the editor.
##
## Parameter checks, tile and atlas arithmetic, shape construction, and the input-event codec. None
## of it needs an editor, and all of it used to sit inside `plugin.gd`, which `extends EditorPlugin`
## — so every refused tile size and every unknown key name cost a real editor boot to exercise, and
## the acceptance suite was the only instrument that could reach one.
##
## Preloadable, like `protocol.gd` beside it, which is what lets `params_test.gd` drive the whole of
## this headlessly in about a second. The handlers keep the `EditorInterface` calls; this is what
## they decide with before they make them.

const Protocol := preload("res://addons/gofer/protocol.gd")

## The parameters each command accepts, as the backstop behind the router's own check.
##
## The router refuses a malformed call in Rust before it crosses the socket, which is where a model
## should learn about one — the answer arrives in microseconds and carries an example. This table is
## what makes that an optimization rather than the only guard: a call from the renderer, from a
## test, or from a Gofer whose Rust half is older than this addon is held to the same contract.
##
## `expectedRevision` and `timeoutMs` are absent on purpose. Both are lifted onto the envelope by
## the caller, so a handler that looked for them among its parameters would refuse every call that
## was actually well formed.
# GENERATED-BEGIN command-params sha256:80a058a090ba4b8b
const COMMAND_PARAMS: Dictionary = {
    "session.get_state": {"required": [], "optional": []},
    "session.answer_dialog": {"required": ["button"], "optional": []},
    "session.undo": {"required": [], "optional": []},
    "session.redo": {"required": [], "optional": []},
    "scene.list": {"required": [], "optional": []},
    "scene.open": {"required": ["path"], "optional": []},
    "scene.create": {"required": ["path", "rootType"], "optional": ["rootName"]},
    "scene.get_tree": {"required": [], "optional": ["root", "depth", "limit"]},
    "scene.save": {"required": [], "optional": []},
    "scene.save_as": {"required": ["path"], "optional": []},
    "scene.reload": {"required": [], "optional": []},
    "node.inspect": {"required": ["node"], "optional": ["properties", "scene"]},
    "node.create": {"required": ["parent", "type", "name"], "optional": ["index", "scene"]},
    "node.create_nodes": {"required": ["nodes"], "optional": ["scene"]},
    "node.instantiate": {"required": ["parent", "path"], "optional": ["name", "index", "scene"]},
    "node.duplicate": {"required": ["node"], "optional": ["name", "scene"]},
    "node.rename": {"required": ["node", "name"], "optional": ["scene"]},
    "node.reparent": {"required": ["node", "newParent"], "optional": ["index", "scene"]},
    "node.change_type": {"required": ["node", "type"], "optional": ["scene"]},
    "node.delete": {"required": ["node"], "optional": ["scene"]},
    "node.set_property": {"required": ["node", "property", "value"], "optional": ["scene"]},
    "node.set_properties": {"required": ["properties"], "optional": ["scene"]},
    "node.add_to_group": {"required": ["node", "group"], "optional": []},
    "node.remove_from_group": {"required": ["node", "group"], "optional": []},
    "node.connect_signal": {"required": ["node", "signal", "method"], "optional": ["target", "binds", "deferred", "oneShot"]},
    "node.disconnect_signal": {"required": ["node", "signal", "method"], "optional": ["target", "binds"]},
    "node.set_cells": {"required": ["node", "cells"], "optional": []},
    "node.get_cells": {"required": ["node"], "optional": ["limit"]},
    "project.get_settings": {"required": [], "optional": []},
    "project.search_settings": {"required": ["query"], "optional": []},
    "project.get_setting": {"required": ["name"], "optional": []},
    "project.set_setting": {"required": ["name", "value"], "optional": []},
    "project.reset_setting": {"required": ["name"], "optional": []},
    "project.list_autoloads": {"required": [], "optional": []},
    "project.set_autoload": {"required": ["name", "path"], "optional": ["enabled"]},
    "project.remove_autoload": {"required": ["name"], "optional": []},
    "project.list_input_actions": {"required": [], "optional": ["names"]},
    "project.set_input_action": {"required": ["name", "events"], "optional": ["deadzone"]},
    "project.remove_input_action": {"required": ["name"], "optional": []},
    "project.reset_input_action": {"required": ["name"], "optional": []},
    "project.list_plugins": {"required": [], "optional": []},
    "project.set_plugin_enabled": {"required": ["plugin", "enabled"], "optional": []},
    "editor.search_settings": {"required": ["query"], "optional": []},
    "editor.get_setting": {"required": ["name"], "optional": []},
    "editor.set_setting": {"required": ["name", "value"], "optional": []},
    "resource.rescan": {"required": [], "optional": ["path"]},
    "resource.create_tileset": {"required": ["path", "texture"], "optional": ["tileSize", "tiles", "solid"]},
    "resource.create_texture": {"required": ["path", "size"], "optional": ["background", "rects"]},
    "resource.create_shape": {"required": ["path", "shapeType"], "optional": ["size", "radius", "height", "points"]},
    "resource.describe_tileset": {"required": ["path"], "optional": []},
    "runtime.run": {"required": [], "optional": ["scene"]},
    "runtime.stop": {"required": [], "optional": []},
    "runtime.restart": {"required": [], "optional": []},
    "runtime.get_state": {"required": [], "optional": []},
    "runtime.get_tree": {"required": [], "optional": ["root", "depth", "limit"]},
    "runtime.inspect_node": {"required": ["path"], "optional": ["properties"]},
    "runtime.input": {"required": ["events"], "optional": []},
    "runtime.capture": {"required": [], "optional": ["source"]},
    "runtime.wait": {"required": [], "optional": ["frames", "ms"]},
    "runtime.pause": {"required": [], "optional": []},
    "runtime.resume": {"required": [], "optional": []},
    "runtime.get_monitors": {"required": [], "optional": ["monitors"]},
}
# GENERATED-END command-params

## The tile size a TileSet takes when a command names none.
const DEFAULT_TILE_SIZE := 16

## One refusal, in the shape every handler answers with.
static func error(code: String, message: String, details: Dictionary = {}) -> Dictionary:
    return {
        "_gofer_error": {
            "code": code,
            "message": message,
            "retryable": false,
            "readiness": "ready",
            "details": details
        }
    }


## The tile size a TileSet command was given, or the sentence saying why it is not one.
static func tile_size(params: Dictionary) -> Dictionary:
    var raw: Variant = params.get("tileSize", null)
    var size := Vector2i(DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE)
    if raw != null:
        if typeof(raw) == TYPE_INT or typeof(raw) == TYPE_FLOAT:
            size = Vector2i(int(raw), int(raw))
        elif typeof(raw) == TYPE_ARRAY and (raw as Array).size() == 2:
            size = Vector2i(int((raw as Array)[0]), int((raw as Array)[1]))
        else:
            return error(
                "invalid_params",
                "tileSize is one number or two, as 16 or [16, 16]",
            )
    if size.x < 1 or size.y < 1:
        return error(
            "invalid_params", "tileSize must be positive, and this one is %s" % str(size)
        )
    return {"value": size}


## A list of atlas coordinates a command was given, each checked against the atlas it names.
static func atlas_coords(params: Dictionary, key: String, grid: Vector2i) -> Dictionary:
    var raw: Variant = params.get(key, null)
    var coords: Array = []
    if raw == null:
        return {"value": coords}
    if typeof(raw) != TYPE_ARRAY:
        return error(
            "invalid_params", "%s is a list of [column, row] pairs" % key, {"parameter": key}
        )
    for entry in raw as Array:
        if typeof(entry) != TYPE_ARRAY or (entry as Array).size() != 2:
            return error(
                "invalid_params",
                "Each %s entry is a [column, row] pair, and %s is not one" % [key, str(entry)],
                {"parameter": key}
            )
        var pair := Vector2i(int((entry as Array)[0]), int((entry as Array)[1]))
        if pair.x < 0 or pair.y < 0 or pair.x >= grid.x or pair.y >= grid.y:
            return error(
                "tile_out_of_atlas",
                (
                    "Tile (%d, %d) is outside the atlas, which is %d columns by %d rows"
                    % [pair.x, pair.y, grid.x, grid.y]
                ),
                {"tile": [pair.x, pair.y], "grid": [grid.x, grid.y]}
            )
        coords.append(pair)
    return {"value": coords}


## Vector2i coordinates as the wire carries them.
static func coords_list(coords: Array) -> Array:
    var list: Array = []
    for entry in coords:
        list.append([entry.x, entry.y])
    return list


## The collision shape a command names, built from its own dimensions.
static func build_shape(shape_type: String, params: Dictionary) -> Dictionary:
    match shape_type:
        "RectangleShape2D":
            var size := Protocol.numbers(params.get("size", null), 2)
            if size.is_empty():
                return error(
                    "invalid_params",
                    "A RectangleShape2D takes size as two numbers: \"size\": [32, 32]"
                )
            var rectangle := RectangleShape2D.new()
            rectangle.size = Vector2(size[0], size[1])
            return {"value": rectangle}
        "CircleShape2D":
            var radius: Variant = params.get("radius", null)
            if not typeof(radius) in [TYPE_INT, TYPE_FLOAT]:
                return error(
                    "invalid_params",
                    "A CircleShape2D takes radius as a number: \"radius\": 8"
                )
            var circle := CircleShape2D.new()
            circle.radius = float(radius)
            return {"value": circle}
        "CapsuleShape2D":
            var radius: Variant = params.get("radius", null)
            var height: Variant = params.get("height", null)
            if not typeof(radius) in [TYPE_INT, TYPE_FLOAT] \
                    or not typeof(height) in [TYPE_INT, TYPE_FLOAT]:
                return error(
                    "invalid_params",
                    "A CapsuleShape2D takes radius and height as numbers: \"radius\": 8, \"height\": 32"
                )
            var capsule := CapsuleShape2D.new()
            capsule.radius = float(radius)
            capsule.height = float(height)
            return {"value": capsule}
        "SegmentShape2D":
            var points := Protocol.numbers(params.get("points", null), 4)
            if points.is_empty():
                return error(
                    "invalid_params",
                    "A SegmentShape2D takes points as four numbers — ax, ay, bx, by: \"points\": [0, 0, 64, 0]"
                )
            var segment := SegmentShape2D.new()
            segment.a = Vector2(points[0], points[1])
            segment.b = Vector2(points[2], points[3])
            return {"value": segment}
    # A world boundary is the infinite floor a 2D level rests on and takes no dimensions.
    return {"value": WorldBoundaryShape2D.new()}


## Input events as the wire carries them, with Godot's own name for each key.
static func encode_input_events(events: Array) -> Array:
    var encoded: Array = []
    for event in events:
        if event is InputEventKey:
            var key := OS.get_keycode_string(event.physical_keycode)
            if key.is_empty():
                key = OS.get_keycode_string(event.keycode)
            encoded.append({"kind": "key", "key": key})
        elif event is InputEventMouseButton:
            encoded.append({"kind": "mouse_button", "button": event.button_index})
        elif event is InputEventJoypadButton:
            encoded.append({"kind": "joypad_button", "button": event.button_index})
        elif event is InputEventJoypadMotion:
            encoded.append({"kind": "joypad_motion", "axis": event.axis, "axisValue": event.axis_value})
        elif event is InputEvent:
            encoded.append({"kind": "other", "description": event.as_text()})
    return encoded


## Input events as Godot takes them, or the sentence naming what was wrong.
static func decode_input_events(raw: Variant) -> Dictionary:
    if typeof(raw) != TYPE_ARRAY:
        return Protocol.decode_failed("events must be an array of input event objects")
    var events: Array[InputEvent] = []
    for entry in raw:
        if typeof(entry) != TYPE_DICTIONARY:
            return Protocol.decode_failed("an input event must be an object carrying a kind")
        var kind := str(entry.get("kind", ""))
        match kind:
            "key":
                var key_name := str(entry.get("key", ""))
                var code := OS.find_keycode_from_string(key_name)
                if code == KEY_NONE:
                    return Protocol.decode_failed("Unknown key '%s'" % key_name)
                var key_event := InputEventKey.new()
                key_event.physical_keycode = code
                events.append(key_event)
            "mouse_button":
                var mouse_button := int(entry.get("button", 0))
                if mouse_button < 1:
                    return Protocol.decode_failed("A mouse_button event requires a button index of 1 or higher")
                var mouse_event := InputEventMouseButton.new()
                mouse_event.button_index = mouse_button
                events.append(mouse_event)
            "joypad_button":
                var pad_button := int(entry.get("button", -1))
                if pad_button < 0:
                    return Protocol.decode_failed("A joypad_button event requires a button index")
                var joypad_event := InputEventJoypadButton.new()
                joypad_event.button_index = pad_button
                events.append(joypad_event)
            _:
                return Protocol.decode_failed("Input event kind '%s' is not supported" % kind)
    return {"ok": true, "events": events, "message": ""}


## Holds one request to the parameters its command declares, for the commands that declare any.
##
## A command with no entry in `COMMAND_PARAMS` is not checked here — absence is "not declared yet",
## never "takes nothing" — so adding a command cannot silently start refusing its own parameters.
##
## Names only. What a value has to *be* stays with the handler and with `Protocol.decode`, which is
## where the engine's own answer lives; this catches the request that named something no handler
## reads, which used to reach a handler and be quietly ignored.
static func check_declared(command: String, params: Dictionary) -> Dictionary:
    if not COMMAND_PARAMS.has(command):
        return {}
    var declared: Dictionary = COMMAND_PARAMS[command]
    var required: Array = declared["required"]
    var accepted: Array = required + (declared["optional"] as Array)
    for key in params:
        if not accepted.has(key):
            return error(
                "unknown_param",
                "%s has no `%s` parameter. It takes %s." % [command, key, ", ".join(accepted)],
                {"param": key, "takes": accepted}
            )
    for name in required:
        if not params.has(name):
            return error(
                "missing_param",
                "%s requires `%s`. It takes %s." % [command, name, ", ".join(accepted)],
                {"param": name, "takes": accepted}
            )
    return {}


## The first path in these parameters that climbs out of the project, or an empty string.
##
## Godot resolves `res://../` out of the project and follows it. Measured against the pinned 4.7.2:
## `Image.save_png("res://../escaped.png")` and `ResourceSaver.save(shape, "res://../escaped.tres")`
## both wrote one directory above the project, and both answered OK. The router refuses this before
## the socket; this is the wire's own backstop, which is also the desktop client's.
##
## A `..` inside a path, not a `..` inside a value: a Label's text may say anything, so a string
## counts as a path only when it carries the scheme or a separator.
static func a_path_that_climbs_out(under: String, value: Variant) -> String:
    match typeof(value):
        TYPE_STRING, TYPE_STRING_NAME:
            if climbs_out_of_the_project(under, str(value)):
                return str(value)
        TYPE_ARRAY:
            for entry: Variant in value as Array:
                var found := a_path_that_climbs_out(under, entry)
                if not found.is_empty():
                    return found
        TYPE_DICTIONARY:
            var held: Dictionary = value
            for key: Variant in held:
                var found := a_path_that_climbs_out(str(key), held[key])
                if not found.is_empty():
                    return found
    return ""

## The keys whose value is a file, so a `..` in one is a path climbing rather than prose.
##
## A node's `text` may say anything, `../docs/readme` included. A string carrying the scheme is a
## path wherever it sits; everything else has to be named here. `path` covers the nested one a
## resource value holds.
const A_KEY_THAT_NAMES_A_FILE: Array[String] = [
    "path", "paths", "texture", "scene", "file", "files", "from", "to"
]

## Whether one string is a path, and climbs.
static func climbs_out_of_the_project(under: String, text: String) -> bool:
    var path := text
    var schemed := false
    if path.begins_with("res://"):
        path = path.substr(6)
        schemed = true
    elif path.begins_with("user://"):
        path = path.substr(7)
        schemed = true
    if not schemed and not A_KEY_THAT_NAMES_A_FILE.has(under):
        return false
    if not schemed and path == "..":
        return true
    for segment in path.split("/"):
        if segment == "..":
            return true
    return false


## Whether a name came back with a number on the end, which is Godot making it unique.
##
## A node's name is unique among its siblings and Godot does not refuse a clash — it appends a
## number and carries on. Two live turns in one run renamed a node to `UI` and to `Player` under
## parents that already had one, and were told only that the write asked for `UI` and Godot holds
## `UI2`: the mismatch, and not the reason for it.
##
## Only a tail that is entirely digits counts, so `Player` answering `PlayerShip` is not this.
static func made_unique(wanted: Variant, found: Variant) -> String:
    var asked := str(wanted)
    var held := str(found)
    if asked.is_empty() or held == asked or not held.begins_with(asked):
        return ""
    if not held.substr(asked.length()).is_valid_int():
        return ""
    return (
        ". A sibling is already called %s, and Godot makes a node's name unique among its siblings "
        + "rather than refusing the clash. Rename or remove that one first, or choose another name."
    ) % asked

## The properties a caller reaches for that read back as something else, and the way to get what
## they wanted.
##
## `anchors_preset` is the one everybody reaches for, because a full-screen panel is the commonest
## thing anyone asks a `Control` for. Watched in four live turns, all of them laying out a UI.
##
## **It is not the inspector's own control, and a scene does store it.** That is what this sentence
## used to say, and it was measured on children only. Measured again on a real 4.7.2 editor, root
## and child both:
##
## * A scene root takes the write, reads back 15, and the saved `.tscn` holds
##   `anchors_preset = 15` with `anchor_right = 1.0`, `anchor_bottom = 1.0` under it. Godot gives a
##   `Control` with no `Control` parent `layout_mode = 3`, uncontrolled, and the preset applies.
## * A child of a plain `Control` starts at `layout_mode = 0`, position, where the preset has
##   nowhere to go: it reads back 0 and the anchors under it do not move.
## * The same child, sent `layout_mode = 1` first, takes the same write, reads back 15, and is
##   saved with it.
## * A child of a **Container** cannot be put there at all: `layout_mode` is held at 2 and a write
##   of 1 reads back 2. `anchors_preset` reads back 0 there whatever is tried. Individual anchors
##   are still stored, and `size_flags_horizontal` is what the container actually reads.
##
## The last of those four is the one this sentence got wrong on its first writing, which is the
## same mistake it was replacing: measured on children of a plain Control and generalised to every
## child. A caller inside a container, told to "set layout_mode to 1 first", is told to make a write
## that cannot take either.
##
## So the refusal is still right — that write did not take — and what it says about *why* has to be
## the fact rather than the guess, because a model told "this can never take" stops looking for the
## one line that makes it take, and a model told the wrong line spends a call on it.
const NO_SCENE_HOLDS := {
    "anchors_preset":
    (
        " `anchors_preset` only applies to a Control whose `layout_mode` is anchors, and reads back"
        + " 0 when it is not. A scene root is already there: Godot gives a Control with no Control"
        + " parent layout_mode 3, uncontrolled, and stores the preset. A Control under a plain"
        + " Control starts at 0, position — set `layout_mode` to 1 first and the same write takes."
        + " A Control inside a Container cannot be put there at all: the container holds"
        + " `layout_mode` at 2 and places the node itself, so size that one with"
        + " size_flags_horizontal, size_flags_vertical and custom_minimum_size. Where anchors do"
        + " apply, setting anchor_left, anchor_top, anchor_right and anchor_bottom works without"
        + " the preset — 0 and 1 are the edges, so 0, 0, 1, 1 is the whole parent — with"
        + " offset_right and offset_bottom at 0 to sit flush."
    ),
    # The property the sentence above tells a caller to set, which most nodes will not take either.
    # Measured on 4.7.2, every shape, every value: a Control with no Control parent holds 3 whatever
    # is written; a Control inside a Container holds 2 whatever is written; a Control under a plain
    # Control takes 0 and 1, and 2 and 3 there fall back to 0. So the parent decides it and the
    # write only reports whether the caller agreed.
    "layout_mode":
    (
        " `layout_mode` says where a Control already sits, and its parent decides it — a write"
        + " that disagrees is dropped with no error. A Control with no Control parent is held at"
        + " 3, uncontrolled. A Control inside a Container is held at 2, container, and the"
        + " container places it: size that one with size_flags_horizontal, size_flags_vertical and"
        + " custom_minimum_size. Only a Control under a plain Control takes a write, and only 0,"
        + " position, or 1, anchors — 2 and 3 there fall back to 0. Moving the node to a different"
        + " parent with node.reparent is what changes this; writing the property again is not."
    ),
}

## What follows the text of a dialog the editor is waiting on, and it is not the same sentence twice.
##
## `_respond_dialog_open` answers two situations with one message. Before the launch — an editor
## already asking something when `run` arrives — **nothing has started**. In the sweep, after
## `_runtime_play()` has been pressed and the editor turned the launch into a question, **the game
## is queued behind the dialog** and answering it starts one.
##
## Watched on `loc-06-recover`: four dialogs, four `session.answer_dialog` calls, and then a `run`
## answered `already_running` — because the launch behind the last dialog had gone through while
## the caller thought its `run` had been refused. Neither did the message name the call that
## answers a dialog, which every caller needs and this one had to find for itself.
static func after_a_dialog(launch_is_waiting: bool) -> String:
    if launch_is_waiting:
        return (
            " The game was already asked to start and is waiting behind this dialog: answer it with"
            + " session.answer_dialog and it starts by itself. Running it again would ask for a"
            + " second one."
        )
    return (
        " Nothing has started. Answer it with session.answer_dialog — the buttons do what they say —"
        + " and then send this again."
    )

## What to say when the script has the method and the node does not, which reads as a contradiction.
##
## `node.connect_signal` refuses on `target.has_method(method)` — the **node's** view — and then
## lists what the script declares, which is the **resource's** view. When the two disagree the
## message says both in consecutive clauses and means neither:
##
## ```text
## method_not_found: /Coin has no method _on_body_entered to receive body_entered.
## Its script declares _on_body_entered.
## ```
##
## Watched once, live, on a local Qwen3.8 turn writing a coin scene. Once is below the bar for a
## repair — a repair guesses at what the caller meant — and a sentence that contradicts itself is
## wrong at any count, so this is not a repair.
##
## What is actually true: the file and the script resource are up to date, and the node in the
## edited scene is still holding an older instance of it. The turn found the way out for itself on
## the next two calls — `godot_scene save`, then `godot_scene reload` — and that is what this says.
static func a_method_the_script_has_and_the_node_has_not(method: String, named: Array) -> String:
    if method.is_empty() or not named.has(method):
        return ""
    return (
        ". Its script does declare %s — the node in the edited scene is still holding an older"
        + " instance of that script, which is why it answers that it has no such method. Save the"
        + " scene with scene.save and reload it with scene.reload, then connect."
    ) % method

## What to add when the scene a caller is trying to create is the one the project starts with.
##
## `scene.create` refuses a path that already holds a scene, and says to open it or to save over it
## with `save_as`. Watched four times across four turns, and **three of the four named
## `res://main.tscn`** — an arena, a shooter and a 3D scene, each of them building the game the
## project starts with and reaching for the path it starts at.
##
## Neither way onward is what they wanted. Opening it keeps the old scene; `save_as` writes the
## scene currently being edited, which is the old one until something else is made first. What they
## wanted is the editor's own Set As Main Scene: a scene of its own, and the project pointed at it.
## That leaves the fixture's scene where it is, which is also the honest outcome — nothing has to be
## destroyed to start somewhere new.
##
## `main_scene` is passed in rather than read here, because everything in this file is decided
## before the editor is touched and `ProjectSettings` is the editor.
static func also_the_main_scene(path: String, main_scene: String) -> String:
    if main_scene.is_empty() or path != main_scene:
        return ""
    return (
        " %s is also this project's main scene. If you are replacing what the game starts with,"
        + " make your scene at its own path and then point the project at it with"
        + " project.set_setting on application/run/main_scene — that is what the editor's own Set"
        + " As Main Scene does, and it leaves this scene where it is."
    ) % path

## What to say when a caller wrote a scene path where a node type belongs.
##
## `ClassDB.instantiate("res://pickup.tscn")` answers null, like any other name the class database
## does not have, and the refusal that follows says only "Could not instantiate res://pickup.tscn".
## That is true and it is the wrong shape of true: the caller did not misspell a class, it reached
## for something this tool does not do.
##
## Watched once, on a task asking for a scene inheritance chain. The turn wrote
## `{"op": "create", "rootType": "res://pickup.tscn"}`, was told the sentence above, tried the same
## thing at another path, then reached for `bash godot --headless --script` — refused by the
## workspace rule — and then asked the user to let it enable an editor plugin. Four calls and a
## question, spent on a refusal that named nothing to do next.
##
## Two facts are needed and both are cheap: a type here is a class name, and a scene goes *inside*
## another scene with `node.instantiate`. The third — that nothing here makes one scene inherit
## from another — is what stops the next call being the same call.
static func a_type_that_is_a_scene(node_type: String) -> String:
    var lowered := node_type.to_lower()
    if not (
        lowered.begins_with("res://")
        or lowered.ends_with(".tscn")
        or lowered.ends_with(".scn")
    ):
        return ""
    return (
        " %s is a scene, and a type here is a Godot class name — Node2D, Area2D, Control. To put"
        + " that scene inside this one, use node.instantiate, which takes the scene's path. No"
        + " call here makes one scene inherit from another."
    ) % node_type

## The numbers an enum property takes, read out of the hint string the engine publishes for it.
##
## Two shapes, both measured on 4.7.2: bare names counting from zero — `Left,Right,Both` — and
## explicit pairs — `Custom:-1,Full Rect:15,Top Left:0`. A pair sets where whatever follows it
## counts from, which is why `next` is assigned rather than incremented.
static func _the_numbers_an_enum_takes(hint_string: String) -> Dictionary:
    var values := {}
    var next := 0
    for piece in hint_string.split(",", false):
        var named := piece
        var number := next
        var colon := piece.rfind(":")
        if colon > 0 and piece.substr(colon + 1).is_valid_int():
            named = piece.substr(0, colon)
            number = int(piece.substr(colon + 1))
        values[number] = named.strip_edges()
        next = number + 1
    return values

## What a readback mismatch says when the write named a number the property's enum does not have.
##
## Godot refuses an out-of-range enum inside the property's own setter: `set_h_grow_direction` calls
## it "Index is out of bounds", writes that to the editor's stderr where no caller can read it, and
## leaves the property where it was. What comes back is a readback mismatch naming two numbers and
## nothing about the set either belongs to. Measured on 4.7.2: `grow_horizontal` asked for 3 holds
## 1, `mouse_filter` asked for 9 holds 0.
##
## Only a number outside the set gets this. `anchors_preset` asked for 15 is asking for Full Rect,
## which the enum has — that write is refused for its layout_mode, and NO_SCENE_HOLDS answers it.
## A flags property is not an enum either: `size_flags_horizontal` publishes `Fill:1,Expand:2` as a
## bitmask, where a combination no name lists is still a legal value.
static func outside_the_values_it_takes(
    property: String, hint_string: String, wanted: Variant
) -> String:
    if hint_string.is_empty() or typeof(wanted) != TYPE_INT:
        return ""
    var values := _the_numbers_an_enum_takes(hint_string)
    if values.is_empty() or values.has(int(wanted)):
        return ""
    var listed := PackedStringArray()
    for number in values:
        listed.append("%d %s" % [number, values[number]])
    return (
        " %d is not one of `%s`'s values. It takes %s. Godot refuses a number outside that set"
        + " inside the property's own setter, so the property still holds what it held before and"
        + " nothing about the write said so."
    ) % [int(wanted), property, ", ".join(listed)]

## How many children a refusal lists before it says how many are left.
##
## Enough that a real scene's node is in the list, short enough that the sentence is still read. The
## widest node in the fixtures holds nine.
const NAMES_AT_MOST := 12

## What a node path reached before it stopped matching, and what was there instead.
##
## `node_not_found` repeats the path back, which is the one thing the caller already knew. Four
## refusals in the recordings say nothing else, and two of them are consecutive — `/PauseMenu/Box`
## and then `/PauseMenu/Title` — a caller guessing at names under a node it could not see. A third
## asked for `@Area2D@214/@CollisionShape2D@212`, guessing at names the engine had made up. The
## deepest part of the path that does exist, and the names under it, ends all three in one answer.
static func as_far_as_the_path_goes(
    reached: String, present: PackedStringArray, missing: String
) -> String:
    if reached.is_empty() or missing.is_empty():
        return ""
    if present.is_empty():
        return (
            " %s is there and has no children at all, so nothing under it is called %s."
            % [reached, missing]
        )
    var shown := present
    var rest := 0
    if present.size() > NAMES_AT_MOST:
        shown = present.slice(0, NAMES_AT_MOST)
        rest = present.size() - NAMES_AT_MOST
    var listed := ", ".join(shown)
    if rest > 0:
        listed += " and %d more" % rest
    return (
        " %s is there and holds %s, and nothing under it is called %s."
        % [reached, listed, missing]
    )

static func instead_of(
    property: String, wanted: Variant, found: Variant, hint_string: String = ""
) -> String:
    if NO_SCENE_HOLDS.has(property):
        return String(NO_SCENE_HOLDS[property])
    var outside := outside_the_values_it_takes(property, hint_string, wanted)
    if not outside.is_empty():
        return outside
    return grew_to_its_minimum(property, wanted, found)

## Whether a `size` that came back larger than it was asked for hit the node's own floor.
##
## `Control.size` is clamped to `get_combined_minimum_size()`, and a `Label`'s minimum is the text
## in it. Measured on a real 4.7.2 editor: a `Panel`, a `ColorRect` and a `Panel` inside a
## `VBoxContainer` all take a size of (64, 64) exactly, and a `Label` asked for (0, 0) comes back
## (1, 23). So this is not a property that cannot be written — it is one with a floor, and only a
## write that lands under the floor is refused.
##
## Both live turns that met it asked for a smaller size than the node would take: a `Label` at
## (0, 0) answering (1, 23), and a body at (64, 64) answering (80, 80). Told apart by the values
## rather than by the name, because a size that came back *smaller* is a different thing entirely
## and has no such explanation.
static func grew_to_its_minimum(property: String, wanted: Variant, found: Variant) -> String:
    if property != "size":
        return ""
    if typeof(wanted) != TYPE_VECTOR2 or typeof(found) != TYPE_VECTOR2:
        return ""
    var asked: Vector2 = wanted
    var held: Vector2 = found
    if held.x < asked.x or held.y < asked.y:
        return ""
    return (
        " A Control's size is held at its own minimum, which for a Label is the text in it, so a"
        + " smaller one cannot be written. Set custom_minimum_size to lower that floor, or leave"
        + " the size alone and place the node with its anchors and offsets."
    )

## Whether a value read back out of Godot is the value that was written into it.
##
## Three things make an exact comparison wrong here, and none of them is a failed write. A property
## the engine declares as a float stores 32 bits, so a double that goes in comes back a few bits
## away from itself, and the types built out of floats carry the same drift. A number written as 5
## and stored as a float reads back as 5.0. And a property that holds no object is not `TYPE_NIL` —
## it is a `TYPE_OBJECT` variant with a null pointer, so clearing one reads back as a different type
## than the null that cleared it.
static func same_value(wanted: Variant, found: Variant) -> bool:
    var left: Variant = null if is_null_object(wanted) else wanted
    var right: Variant = null if is_null_object(found) else found
    if typeof(left) in [TYPE_INT, TYPE_FLOAT] and typeof(right) in [TYPE_INT, TYPE_FLOAT]:
        return is_equal_approx(float(left), float(right))
    if typeof(left) != typeof(right):
        return false
    match typeof(left):
        TYPE_VECTOR2, TYPE_VECTOR3, TYPE_VECTOR4, TYPE_QUATERNION, TYPE_COLOR, TYPE_PLANE, TYPE_RECT2, TYPE_AABB, TYPE_BASIS, TYPE_TRANSFORM2D, TYPE_TRANSFORM3D:
            return left.is_equal_approx(right)
    return left == right

## Whether a value is an object variant pointing at nothing, which is how an empty resource or node
## property reads.
static func is_null_object(value: Variant) -> bool:
    return typeof(value) == TYPE_OBJECT and not is_instance_valid(value)


## The decisions the editor commands make that reach no editor at all.
##
## Every one of these was written inside `plugin.gd`, where `extends EditorPlugin` put it behind a
## real editor boot: a refused texture size, a reserved setting name, a path that needed the
## `res://` prefix. None of them ever touched `EditorInterface`. They are here for the reason the
## header gives — this is what the handlers decide with before they make an editor call — and
## `params_test.gd` reaches all of them from source in about a second.

## How many files one `resource.rescan` may name. A batch is what this command is for now, and a
## project walk is cheaper than importing more files than this one by one.
const MAX_RESCAN_PATHS := 256

## The atlas a tileset command will cut up, and the cells one paint may write, both capped so a
## mistyped tile size or a runaway rectangle cannot spend minutes inside the editor's main loop.
## A texture no larger than this on a side, and no more than this many pixels in it. A tile is 16
## and a sprite sheet is a few hundred; a caller asking for more than this wanted a photograph, and
## this operation draws rectangles.
##
## The two numbers, rather than one per side, because the cost this guards is area and a ground
## strip is not square. Two recorded live runs asked for a floor as wide as the window — 1152x64 and
## 1280x40 — and a per-side cap of 1024 refused both, though each draws a twelfth of the pixels the
## 1024x1024 square it allowed does. The default project window is wider than 1024, so the shape the
## cap refused first was the most ordinary one there is.
const MAX_TEXTURE_EDGE := 4096

const MAX_TEXTURE_PIXELS := 1048576

static func unknown_command_error(command: String) -> Dictionary:
    return {
        "_gofer_error": {
            "code": "unknown_command",
            "message": "Command '%s' is not implemented" % command,
            "retryable": false,
            "readiness": "ready",
            "details": {}
        }
    }

## A setting under autoload/, input/, or editor_plugins/ has its own typed command that enforces
## the structure of its value; routing the write through it keeps malformed entries out of
## project.godot. Returns the command to use, or an empty string for ordinary settings.
static func reserved_setting_command(name: String) -> String:
    if name.begins_with("autoload/"):
        return "project.set_autoload"
    if name.begins_with("input/"):
        return "project.set_input_action"
    if name.begins_with("editor_plugins/"):
        return "project.set_plugin_enabled"
    return ""

## The words a search query is made of, lowered, with the punctuation between them thrown away.
##
## A settings name is `text_editor/appearance/gutters/show_line_numbers` — slashes and underscores
## and never a space. The search matched the whole query as one substring, so every natural way to
## ask was a guaranteed miss: one live turn asked for "line numbers", "split mode", "grid step",
## "filesystem split", "2d snap" and eight more, got nothing every time, and concluded two of the
## three things it wanted were not settings. `show_line_numbers` was there the whole time.
##
## Split on the punctuation as well as the spaces, which is what "thrown away" above means and what
## the body did not do: it split on `" "` alone, so `show line numbers?` asked for a word ending in
## a question mark and no setting has one. Underscores and digits stay inside a word, because a
## settings name is full of both — `show_line_numbers` is one word here and matches the name it
## names, while `line numbers.` is two and matches it as well.
static func words_of(query: String) -> PackedStringArray:
    var words := PackedStringArray()
    var runs := RegEx.create_from_string("\\w+")
    for found in runs.search_all(query.to_lower()):
        words.append(found.get_string())
    return words

## Whether a setting's name holds every word asked for, in any order. No words matches everything,
## and one word behaves exactly as the substring match it replaces.
static func name_holds_every_word(name: String, words: PackedStringArray) -> bool:
    var lowered := name.to_lower()
    for word in words:
        if not lowered.contains(word):
            return false
    return true

## A path named either way, as Godot names it.
static func as_resource_path(value: Variant) -> String:
    var path := str(value).strip_edges()
    if path.is_empty() or path.begins_with("res://"):
        return path
    return "res://" + path.trim_prefix("./").trim_prefix("/")

## Reads `path` as one file or as a list of them, which is what lets a caller rescan everything it
## just wrote in a single command.
##
## One call per file is what produced the batch that broke: the tool takes one path, so eight new
## sprites are eight requests, and the editor answers them inside one another. A list is both the
## shape `reimport_files` already wanted and the shape that stops an agent from having to send a
## storm of them.
static func rescan_paths_param(params: Dictionary) -> Dictionary:
    var raw: Variant = params.get("path", null)
    var listed: Array = []
    if raw == null:
        return {"value": listed}
    if typeof(raw) == TYPE_STRING or typeof(raw) == TYPE_STRING_NAME:
        var single := str(raw)
        if not single.is_empty():
            listed.append(as_resource_path(single))
        return {"value": listed}
    if typeof(raw) != TYPE_ARRAY and typeof(raw) != TYPE_PACKED_STRING_ARRAY:
        return error(
            "invalid_params",
            "resource.rescan takes a path or a list of paths",
            {"path": raw}
        )
    for entry: Variant in raw:
        if typeof(entry) != TYPE_STRING and typeof(entry) != TYPE_STRING_NAME:
            return error(
                "invalid_params",
                "resource.rescan takes a path or a list of paths",
                {"path": entry}
            )
        var named := str(entry)
        if named.is_empty():
            continue
        var resource_path := as_resource_path(named)
        if not listed.has(resource_path):
            listed.append(resource_path)
    if listed.size() > MAX_RESCAN_PATHS:
        return error(
            "too_many_paths",
            "resource.rescan takes at most %d paths at a time, and this one names %d"
            % [MAX_RESCAN_PATHS, listed.size()],
            {"limit": MAX_RESCAN_PATHS}
        )
    return {"value": listed}

## The pixel size of a texture, written as one number or as two.
static func texture_size(raw: Variant) -> Dictionary:
    var width := 0
    var height := 0
    if typeof(raw) == TYPE_INT or typeof(raw) == TYPE_FLOAT:
        width = int(raw)
        height = width
    elif (typeof(raw) == TYPE_ARRAY and (raw as Array).size() == 2):
        width = int((raw as Array)[0])
        height = int((raw as Array)[1])
    else:
        return error(
            "invalid_params",
            "resource.create_texture takes size as one number or two, and %s is neither" % str(raw)
        )
    if width < 1 or height < 1 or width > MAX_TEXTURE_EDGE or height > MAX_TEXTURE_EDGE:
        return error(
            "invalid_params",
            (
                "A texture is between 1 and %d pixels on a side, and %dx%d is not"
                % [MAX_TEXTURE_EDGE, width, height]
            ),
            {"limit": MAX_TEXTURE_EDGE}
        )
    if width * height > MAX_TEXTURE_PIXELS:
        return error(
            "invalid_params",
            (
                (
                    "A texture holds at most %d pixels, and %dx%d holds %d. Draw it smaller and "
                    + "scale the node up, or tile a small one with texture_repeat."
                )
                % [MAX_TEXTURE_PIXELS, width, height, width * height]
            ),
            {"limit": MAX_TEXTURE_PIXELS}
        )
    return {"value": Vector2i(width, height)}

## The path an entry's children will name it by, with a trailing slash and a doubled slash taken off.
##
## Only the caller's own spelling is matched. A batch names a parent the way it named the entry that
## created it, and anything else falls through to the tree, where a path that is really wrong is
## answered by `node_not_found` naming it.
static func batch_parent_key(path: String) -> String:
    var trimmed := path.strip_edges()
    while trimmed.length() > 1 and trimmed.ends_with("/"):
        trimmed = trimmed.substr(0, trimmed.length() - 1)
    return trimmed

## The groups a scene author wrote, without the ones the engine keeps for itself.
##
## An underscore is Godot's own prefix — `_edit_group_`, and the internal groups a node joins for
## processing — and a caller asking what a node is in means the ones somebody typed.
##
## One copy, read by both halves of the addon. It was written twice, byte for byte, once in
## `plugin.gd` for the edited scene and once in `runtime.gd` for the running one, and the two say
## the same thing about the same `Node`: the editor is not what decides it.
static func authored_groups(node: Node) -> Array:
    var authored: Array = []
    for group in node.get_groups():
        if not str(group).begins_with("_"):
            authored.append(str(group))
    return authored


## The class a node is drawn as: the script's own `class_name` when it has one, its engine class
## otherwise.
##
## The same second copy, under two names — `_node_icon_class` in the editor and
## `_runtime_icon_class` in the game. Neither reads an editor or a game; both read the node.
static func icon_class(node: Node) -> String:
    var script: Variant = node.get_script()
    if script is Script:
        var global_name := (script as Script).get_global_name()
        if not global_name.is_empty():
            return global_name
    return node.get_class()


## What the node commands work out about a node, none of which asks the editor.
##
## The second batch out of `plugin.gd`, and the larger one. Every function here takes a `Node`, a
## `Dictionary` or a string and answers from it: which signals a node really has, which property a
## near-miss meant, whether an instance would contain itself, what a swap has to give back to the
## nodes it displaced. Not one of them reads `EditorInterface`, and all of them used to cost a
## staged addon and an xvfb boot to exercise.
##
## What stayed behind is the three that reach `_edited_root` — a node path is relative to the scene
## the editor has open, and that is the editor answering. Threading the root through as a parameter
## would bring them here too, and is a separate decision from this move.

## The hint string of a property whose type is an enum, and "" for every other property.
##
## Read off the instance rather than off `ClassDB`, so a property a script declares carries its own
## hint the same way a built-in one does. A flags property is deliberately not matched: its hint is
## PROPERTY_HINT_FLAGS and any combination of its bits is a legal value.
static func enum_values(node: Object, property: String) -> String:
    for entry in node.get_property_list():
        if entry.get("name") == property and int(entry.get("hint", 0)) == PROPERTY_HINT_ENUM:
            return String(entry.get("hint_string", ""))
    return ""

## Why a scene may not be instantiated here, or "" when it may.
##
## A scene that reaches itself cannot be loaded again once it is saved — the editor recurses until
## it runs out of stack — and the failure lands on whoever opens the file next, not on the call that
## caused it. Dependencies are followed, because A holding B holding A is the same trap.
## `open_scene` is the scene the editor has open, passed in: which scene that is, is the editor's
## answer, and following a dependency chain is not.
static func instance_cycle(path: String, open_scene: String) -> String:
    if open_scene.is_empty():
        return ""
    if path == open_scene:
        return "A scene cannot be instantiated inside itself"
    var seen := {}
    var pending: Array[String] = [path]
    while not pending.is_empty():
        var next: String = pending.pop_back()
        if seen.has(next):
            continue
        seen[next] = true
        for dependency in ResourceLoader.get_dependencies(next):
            # A dependency may be written as "type::uid::path"; the path is the last field.
            var parts := String(dependency).split("::")
            var resolved: String = parts[parts.size() - 1]
            if resolved == open_scene:
                return "%s depends on %s, so instantiating it here would make the scene contain itself" % [next, open_scene]
            if resolved.ends_with(".tscn") or resolved.ends_with(".scn"):
                pending.append(resolved)
    return ""

## Every stored property the outgoing node holds that the incoming one also declares.
##
## Named rather than positional: Godot's property names are the contract, and a name two classes
## share is the same property in both. `name` and `owner` belong to where a node sits rather than to
## what it is, and the swap sets both; `script` is already on the replacement, and re-setting it
## from this list would put it back after its own exported values.
static func carry_the_properties_over(outgoing: Node, incoming: Node) -> void:
    var takes := {}
    for entry in incoming.get_property_list():
        if int(entry.get("usage", 0)) & PROPERTY_USAGE_STORAGE != 0:
            takes[str(entry.get("name", ""))] = true
    for entry in outgoing.get_property_list():
        var name := str(entry.get("name", ""))
        if name.is_empty() or not takes.has(name):
            continue
        if int(entry.get("usage", 0)) & PROPERTY_USAGE_STORAGE == 0:
            continue
        if name in ["name", "owner", "script"]:
            continue
        incoming.set(name, outgoing.get(name))

## Checks that a tile a paint names is one the tileset actually defines.
##
## `set_cell` takes an atlas coordinate no tile occupies without complaint and draws nothing there,
## so a whole level can be painted out of tiles that do not exist and look like an empty layer.
static func require_tile(tile_set: TileSet, source_id: int, atlas: Vector2i) -> Dictionary:
    if not tile_set.has_source(source_id):
        var available: Array = []
        for index in range(tile_set.get_source_count()):
            available.append(tile_set.get_source_id(index))
        return error(
            "source_not_found",
            "The tileset has no source %d; it has %s" % [source_id, str(available)],
            {"source": source_id, "sources": available}
        )
    var source := tile_set.get_source(source_id)
    if not source.has_tile(atlas):
        return error(
            "tile_not_defined",
            (
                "The tileset's source %d defines no tile at (%d, %d). resource.describe_tileset "
                + "lists the tiles it does define."
            ) % [source_id, atlas.x, atlas.y],
            {"source": source_id, "tile": [atlas.x, atlas.y]}
        )
    return {}

## The flags a live connection carries, so undoing a disconnection restores the same one.
static func connection_flags(node: Node, signal_name: String, callable: Callable) -> int:
    for connection in node.get_signal_connection_list(signal_name):
        if (connection.get("callable", Callable()) as Callable) == callable:
            return int(connection.get("flags", Object.CONNECT_PERSIST))
    return Object.CONNECT_PERSIST

## The signals a node can emit, named the way `node.connect_signal` takes them.
##
## A caller that cannot see this list has to guess a signal name, and `signal_not_found` is all the
## help a guess gets — so the names come back with the node rather than from the documentation.
static func node_signals(node: Node) -> Array:
    var names: Array = []
    for info in node.get_signal_list():
        names.append(String(info.get("name", "")))
    names.sort()
    return names

## A node the edited scene does not hold, and the spelling that would have found it.
##
## The signals a node really emits, said to a caller that named one it does not.
##
## The third of these — `node_not_found` and `property_not_found` were the first two — and the same
## reasoning: naming the absence repairs nothing. A live turn asked to connect `/Main/ScoreLabel` to
## `score_changed`, which is an autoload's signal rather than a Label's, and was told only that the
## Label has no such signal.
##
## The near one first when there is one, and otherwise the list, because a node's signals are a
## short closed set — a Label has about a dozen — unlike its properties.
static func the_signals_it_does_have(node: Node, wanted: String) -> String:
    var named: Array[String] = []
    for entry in node.get_signal_list():
        var name := str(entry.get("name", ""))
        if not name.is_empty():
            named.append(name)
    if named.is_empty():
        return ""
    named.sort()
    var plain := wanted.to_lower().replace("_", "")
    for name in named:
        var candidate := name.to_lower().replace("_", "")
        if candidate == plain or (mini(candidate.length(), plain.length()) >= 4 \
                and (candidate.begins_with(plain) or plain.begins_with(candidate))):
            return ". Did you mean %s?" % name
    if named.size() > 14:
        named = named.slice(0, 14)
    return ". It emits %s." % ", ".join(named)

## The properties worth values, and the names of the ones still holding what the class ships with.
##
## Only for an answer nobody narrowed. A caller that named properties has chosen, and gets every one
## it named.
##
## Measured on the pinned 4.7.2, against a Label carrying a text and a size: **4 of its 129
## properties differ from `ClassDB.class_get_property_default_value`**, and a CharacterBody2D fresh
## out of `create` has none that do. The values of the rest are the class reference restated once
## per call — 15,885 characters in one recorded live turn, 81% of everything twelve tool calls
## returned, of which the four the caller could not have known were about 400.
##
## A property the class has no default for is kept with its value, whatever it holds. That is the
## whole of what makes this safe rather than a second `stored` filter: `script`, `owner`, `name`,
## `global_position`, `theme_override_*` and every variable a script declares answer `null` here,
## because `ClassDB` describes engine classes and knows nothing of any of them — so the half of the
## inspector that laying out and styling a UI needs is exactly the half this cannot drop.
##
## `property_can_revert` is the inspector's own version of this question and is not the answer: on
## the same Label it was true for 2 names of 129, measured, so it detects a default override rather
## than a value equal to its default.
static func split_off_class_defaults(node: Node, properties: Array) -> Dictionary:
    var kept: Array = []
    var untouched: Array[String] = []
    var class_name_of := node.get_class()
    for entry: Variant in properties:
        var property: Dictionary = entry
        var property_name := str(property["name"])
        var shipped: Variant = ClassDB.class_get_property_default_value(class_name_of, property_name)
        if shipped == null or node.get(property_name) != shipped:
            kept.append(property)
            continue
        untouched.append(property_name)
    return {"properties": kept, "atClassDefault": untouched}

## Every property the editor would show for a node, tagged for the wire.
##
## Both halves of the inspector are reported, not only what the scene stores. `Control.position`,
## `Control.size` and all 431 `theme_override_*` names carry no storage flag — a scene saves anchors
## and offsets instead — so a list filtered to stored properties would hide exactly what laying out
## and styling a UI needs, while `Object.set` writes them perfectly well. `stored` says which half
## each one came from.
##
## Categories, groups and subgroups are inspector headings rather than values, and `script` is the
## node's own script rather than a property of it; none of them are reported.
##
## `wanted` narrows the answer to the names it holds, and empty means every one of them. A Label
## answers with 119 properties: one such answer was 15 885 characters, 81% of everything twelve tool
## calls of a live turn returned, and the same turn read the running game's copy of the same node
## through `runtime.inspect_node` for 300 characters, because only that one took a list of names.
static func node_properties(node: Node, wanted: Array[String] = []) -> Array:
    var properties: Array = []
    for info in node.get_property_list():
        var usage := int(info.get("usage", 0))
        if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
            continue
        var property_name := str(info.get("name", ""))
        if property_name.is_empty():
            continue
        # A name the caller asked for is answered, whatever the inspector would do with it. The
        # filters below shape a list nobody chose; a caller who named `global_position` has chosen,
        # and every one of those filters would answer them "this node has no such property" about a
        # property `set_property` writes perfectly well — with the only pointer being `node.inspect`
        # itself, which is the call that just refused it. `script` is the same case: left out of the
        # whole list because it is the node's own script rather than a property of it, and answered
        # the moment anybody names it.
        if not wanted.is_empty():
            if not wanted.has(property_name):
                continue
        else:
            # Both halves of the inspector, and nothing that carries neither flag: `global_position`
            # and friends are `PROPERTY_USAGE_NONE` and would otherwise be listed twice over, once
            # as themselves and once as the `position` they are computed from.
            if not (usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)):
                continue
            if property_name == "script":
                continue
        properties.append(
            {
                "name": property_name,
                "value": Protocol.encode(node.get(property_name)),
                "type": type_string(int(info.get("type", TYPE_NIL))),
                "className": str(info.get("class_name", "")),
                "stored": bool(usage & PROPERTY_USAGE_STORAGE),
                "writable": not bool(usage & PROPERTY_USAGE_READ_ONLY),
            }
        )
    return properties

## The property nearest a name the node does not have, by the rule the router uses for parameters:
## case and underscores ignored, and one a prefix of the other. Four characters at least, or `x`
## would answer for anything beginning with it.
static func nearest_property(node: Node, property: String) -> String:
    var wanted := property.to_lower().replace("_", "")
    if wanted.is_empty():
        return ""
    for entry in node.get_property_list():
        var name := str(entry.get("name", ""))
        if name.is_empty() or name.contains("/"):
            continue
        # The list carries the inspector's own headings — a Sprite2D's `Transform` sits in it beside
        # its `transform` — and answering `Did you mean Transform?` sends a caller to a name that is
        # not a property at all.
        var usage := int(entry.get("usage", 0))
        if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
            continue
        var plain := name.to_lower().replace("_", "")
        if plain == wanted:
            # Spelled the same way, so there is nothing to correct and `Did you mean script?` about
            # `script` is what a caller was told. A near miss of case or underscores is still worth
            # answering — `Position` for `position` is a real correction — so only an exact match
            # is dropped.
            return "" if name == property else name
        if mini(plain.length(), wanted.length()) < 4:
            continue
        if plain.begins_with(wanted) or wanted.begins_with(plain):
            return name
    return ""

## Refuses a property this node does not have, and says which one it could have meant.
##
## `Node /Arena has no property type` was the whole of what four live turns were told, in four
## separate runs, about `type`, `spacing` and `transform_2d`. `transform_2d` is one edit from a
## property the node really has; `spacing` on a VBoxContainer is a theme override, which is a name
## no near miss reaches; `type` is not a property at all. So: the near one when there is one, and
## otherwise the call that lists them all with what they hold.
static func property_not_found_error(node: Node, path: String, property: String) -> Dictionary:
    var message := "Node %s has no property %s" % [path, property]
    var near := nearest_property(node, property)
    if near.is_empty():
        message += (
            ". node.inspect with no `properties` lists every property this node has with its "
            + "current value, including the theme_override_* ones a Control keeps — naming this "
            + "one there is refused the same way"
        )
    else:
        message += ". Did you mean %s?" % near
    return {
        "_gofer_error": {
            "code": "property_not_found",
            "message": message,
            "retryable": false,
            "readiness": "ready",
            "details": {"property": property}
        }
    }

## Why the editor's answer about a script's methods is out of date, and what to do about it.
##
## The method list a node reports comes from the compiled script, and the editor cannot compile
## this one — so what it is really saying is "the last version that compiled had no such method",
## which reads as a fact about the file and is not one. Measured against the pinned editor:
## `Script.reload` answers `ERR_PARSE_ERROR` and leaves the old method list in place.
##
## The commonest cause has nothing to do with the file. An autoload registered while the editor has
## been running is not in the map its compiler resolves global names from, so every script naming
## one stops compiling *in the editor* while running perfectly in the game. One live turn met this:
## it wrote the handler, registered the `Score` autoload, and was told three times that the script
## declares only `_process`; it recovered by stopping and starting the whole session, which is the
## only thing that rebuilds that map.
## `added_here` is the autoloads this session registered, passed in: keeping that list is the
## plugin's, and turning it into a sentence is not.
static func why_the_editor_cannot_see_it(target: Node, added_here: Array[String]) -> String:
    var named := ". The editor cannot compile its script, so the methods it reports are the last "
    named += "version that compiled — read godot_script diagnostics for what is wrong with it."
    if added_here.is_empty():
        return named
    return (
        named
        + " If the only thing wrong is a name from %s: an autoload registered while the editor has "
        % ", ".join(added_here)
        + "been running is not one the editor can resolve until it restarts, though the running "
        + "game resolves it fine. Stop and start the session with godot_session, then connect."
    )

## Where a method the caller named would have to live, said to a caller that has not put one there.
##
## `\/Pickup has no method _on_body_entered to receive body_entered` is the whole of what two live
## turns were told, twice each. It is true and it repairs nothing: the method belongs to whatever
## script is on the *target*, which defaults to the scene root rather than to the node emitting the
## signal, and the commonest reason there is no method is that there is no script on that node yet.
static func where_a_method_would_be(target: Node, method: String = "") -> String:
    var script: Variant = target.get_script()
    if script == null:
        return (
            ". No script is attached to it, so it has no methods of its own — write one with "
            + "godot_script save and set the node's script property to it first. `target` is the "
            + "node carrying the method and defaults to the scene root, so name it if the method "
            + "lives elsewhere."
        )
    var named: Array[String] = []
    # `get_script_method_list` belongs to Script, not to Object: `node.get_script_method_list()`
    # is a runtime error, and a runtime error inside a message builder is a message that never
    # arrives. Measured against the pinned editor — `Node2D.has_method("get_script_method_list")`
    # is false, and the same call on the script it carries answers the methods.
    for entry in (script as Script).get_script_method_list():
        var name := str(entry.get("name", ""))
        if not name.is_empty() and not name.begins_with("@"):
            named.append(name)
    if named.is_empty():
        return (
            ". Its script declares no methods yet. `target` is the node carrying the method and "
            + "defaults to the scene root, so name it if the method lives elsewhere."
        )
    named.sort()
    # The script has it and the node does not, which is one situation rather than two facts that
    # contradict each other. See `a_method_the_script_has_and_the_node_has_not`.
    var stale := a_method_the_script_has_and_the_node_has_not(method, named)
    if not stale.is_empty():
        return stale
    if named.size() > 12:
        named = named.slice(0, 12)
    return (
        ". Its script declares %s. `target` is the node carrying the method and defaults to the "
        + "scene root, so name it if the method lives elsewhere."
    ) % ", ".join(named)

## Fits a decoded value onto the type the node declares the property with.
##
## `Object.set` takes what it is given for a property whose type the engine does not enforce: a
## `res://…` path written as a string landed in a CollisionShape2D's `shape` and was saved into the
## scene, which then opened with a String where a Shape2D belongs. What the node says the property
## is, is therefore checked before the value reaches it, so a mistyped write is an error naming the
## type it wanted rather than a level that will not run.
static func fit_to_property(node: Node, property: String, value: Variant) -> Dictionary:
    var declared: Dictionary = {}
    for info in node.get_property_list():
        if str(info.get("name", "")) == property:
            declared = info
            break
    # A property reachable through `in` but absent from the list is the script's own business.
    if declared.is_empty():
        return Protocol.decoded(value)
    var wanted := int(declared.get("type", TYPE_NIL))
    # Clearing a resource or a node reference is what null is for, and every object takes it.
    if value == null and wanted == TYPE_OBJECT:
        return Protocol.decoded(null)
    var fitted := Protocol.fit_to_declared_type(value, wanted)
    if not fitted["ok"]:
        return fitted
    var wanted_class := str(declared.get("class_name", ""))
    # Only an engine class is checked: a property typed with a script's `class_name` reports that
    # name here, and the resource carrying that script is an ordinary Resource to `is_class`.
    if wanted != TYPE_OBJECT or wanted_class.is_empty() or not ClassDB.class_exists(wanted_class):
        return fitted
    var object: Object = fitted["value"]
    if object != null and not object.is_class(wanted_class):
        return Protocol.decode_failed("expected %s, received %s" % [wanted_class, object.get_class()])
    return fitted

## Who owned each node under this one, before any of them left the tree.
##
## Not "the scene owns everything". A node placed by `node.instantiate` owns its own contents, and
## handing those to the edited scene writes an instance's insides into the file that instanced it.
## The owners are read before the move and put back after, so what was there is what comes back.
##
## Keyed by the path down from the swapped node, never by name. Godot only makes a name unique
## among its siblings, so a subtree walked whole collides the moment two branches agree: two
## instanced scenes each holding a `Sprite2D`, or a `Player/CollisionShape2D` beside an
## `Enemy/CollisionShape2D`. The second write won and both nodes were handed the same owner — and
## where that owner was the edited root, an instance's insides went into the .tscn, which is the
## exact failure the paragraph above says this exists to prevent. The children move across
## unchanged, so one path names the same node on both sides of the swap.
static func who_owned_what(node: Node, into: Dictionary, prefix: String = "") -> void:
    for child in node.get_children():
        var path := prefix + "/" + String(child.name)
        into[path] = child.owner
        who_owned_what(child, into, path)

## The other half of [`_who_owned_what`]. A node keeps its owner while it is only moved and loses it
## when it leaves the tree and comes back, and a node the edited scene does not own is a node the
## save writes nothing about.
static func give_them_back_their_owners(node: Node, owners: Dictionary, prefix: String = "") -> void:
    for child in node.get_children():
        var path := prefix + "/" + String(child.name)
        if owners.has(path):
            child.set_owner(owners[path])
        give_them_back_their_owners(child, owners, path)
