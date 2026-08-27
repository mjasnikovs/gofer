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
