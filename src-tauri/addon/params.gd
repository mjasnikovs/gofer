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
                    "invalid_params", "A RectangleShape2D takes size as two numbers"
                )
            var rectangle := RectangleShape2D.new()
            rectangle.size = Vector2(size[0], size[1])
            return {"value": rectangle}
        "CircleShape2D":
            var radius: Variant = params.get("radius", null)
            if not typeof(radius) in [TYPE_INT, TYPE_FLOAT]:
                return error("invalid_params", "A CircleShape2D takes radius as a number")
            var circle := CircleShape2D.new()
            circle.radius = float(radius)
            return {"value": circle}
        "CapsuleShape2D":
            var radius: Variant = params.get("radius", null)
            var height: Variant = params.get("height", null)
            if not typeof(radius) in [TYPE_INT, TYPE_FLOAT] \
                    or not typeof(height) in [TYPE_INT, TYPE_FLOAT]:
                return error(
                    "invalid_params", "A CapsuleShape2D takes radius and height as numbers"
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
                    "A SegmentShape2D takes points as four numbers: ax, ay, bx, by"
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
