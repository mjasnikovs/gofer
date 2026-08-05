extends Node

## Gofer's runtime helper, autoloaded into the running game.
##
## The editor plugin forwards `runtime.*` RPC requests over Godot's remote-debugger channel and
## this autoload answers them from inside the game process. The editor sends a "gofer:request"
## message carrying `{id, op, params}`; the helper answers "gofer:response" carrying `{id, ok, ...}`
## on success or `{id, ok: false, code, message}` on failure. Both travel on the capture prefix
## "gofer", which is registered only when the game was launched with the editor's debugger
## attached — run standalone, the helper stays inert.
##
## Every op is served from a coroutine: input and capture need to wait for rendered frames, and a
## message capture must return immediately, so the capture callback only starts the coroutine and
## the response leaves whenever it is ready. Correlation is by `id`, which the editor assigned.

const PROTOCOL_VERSION := 2
## Tagged values and PNG frames must read the same whichever process produced them, so both halves
## of the addon encode them through this one script.
const Protocol := preload("res://addons/gofer/protocol.gd")
## A tree dump larger than this risks the 1 MiB envelope cap; truncation is reported, never fatal.
const MAX_TREE_NODES := 2048
const MAX_TREE_DEPTH := 32

## The performance monitors the wire may name, mapped onto engine constants.
const MONITORS := {
    "fps": Performance.TIME_FPS,
    "process_time": Performance.TIME_PROCESS,
    "physics_time": Performance.TIME_PHYSICS_PROCESS,
    "memory_static": Performance.MEMORY_STATIC,
    "memory_message_buffer": Performance.MEMORY_MESSAGE_BUFFER_MAX,
    "object_count": Performance.OBJECT_COUNT,
    "object_resource_count": Performance.OBJECT_RESOURCE_COUNT,
    "object_node_count": Performance.OBJECT_NODE_COUNT,
    "object_orphan_node_count": Performance.OBJECT_ORPHAN_NODE_COUNT,
    "render_objects_in_frame": Performance.RENDER_TOTAL_OBJECTS_IN_FRAME,
    "render_primitives_in_frame": Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME,
    "render_draw_calls_in_frame": Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME,
    "render_video_memory": Performance.RENDER_VIDEO_MEM_USED,
    "render_texture_memory": Performance.RENDER_TEXTURE_MEM_USED,
    "render_buffer_memory": Performance.RENDER_BUFFER_MEM_USED,
}
const DEFAULT_MONITORS: Array[String] = ["fps", "memory_static", "object_node_count"]

const MOUSE_BUTTONS := {
    "left": MOUSE_BUTTON_LEFT,
    "right": MOUSE_BUTTON_RIGHT,
    "middle": MOUSE_BUTTON_MIDDLE,
    "wheel_up": MOUSE_BUTTON_WHEEL_UP,
    "wheel_down": MOUSE_BUTTON_WHEEL_DOWN,
}

var _tree_nodes_seen: int = 0
var _tree_truncated: bool = false

func _ready() -> void:
    print("GOFER_RUNTIME_READY:%d" % PROTOCOL_VERSION)
    if not EngineDebugger.is_active():
        return
    EngineDebugger.register_message_capture("gofer", _on_editor_message)
    _announce_ready()

## The editor pings when its debugger session appears, in case the first announcement raced the
## session setup; answering a ping with another announcement keeps both sides race-free.
func _announce_ready() -> void:
    EngineDebugger.send_message("gofer:ready", [{"protocolVersion": PROTOCOL_VERSION}])

## The engine strips the capture prefix before invoking the callable, so the editor's
## "gofer:request" arrives here as "request". `trim_prefix` accepts both spellings rather than
## coupling to where the strip happens — the same tolerant decode godot-ai's helper uses
## (MIT-licensed, https://github.com/hi-godot/godot-ai).
func _on_editor_message(message: String, data: Array) -> bool:
    if message.trim_prefix("gofer:") != "request" or data.is_empty():
        return true
    var request: Variant = data[0]
    if typeof(request) != TYPE_DICTIONARY:
        return true
    var op := str((request as Dictionary).get("op", ""))
    if op == "ping":
        _announce_ready()
        return true
    # `_serve` is a coroutine: calling it runs the op until its first await and the response is
    # sent whenever the awaited frames have passed. The capture callback itself returns now.
    _serve(request as Dictionary)
    return true

func _serve(request: Dictionary) -> void:
    var id := str(request.get("id", ""))
    var op := str(request.get("op", ""))
    var params: Dictionary = request.get("params", {})
    var result: Dictionary
    match op:
        "tree":
            result = _op_tree()
        "inspect":
            result = _op_inspect(params)
        "input":
            result = await _op_input(params)
        "capture":
            result = await _op_capture()
        "monitors":
            result = _op_monitors(params)
        _:
            result = _failure("unknown_command", "Runtime operation '%s' is not implemented" % op)
    result["id"] = id
    EngineDebugger.send_message("gofer:response", [result])

func _succeed(payload: Dictionary = {}) -> Dictionary:
    payload["ok"] = true
    return payload

func _failure(code: String, message: String) -> Dictionary:
    return {"ok": false, "code": code, "message": message}

## Dumps the live scene tree, root window first. Deep or wide trees are truncated rather than
## allowed to grow a response past the 1 MiB envelope cap, which would sever the connection.
func _op_tree() -> Dictionary:
    _tree_nodes_seen = 0
    _tree_truncated = false
    var root := _runtime_node_summary(get_tree().root, 0)
    return _succeed({"root": root, "truncated": _tree_truncated})

func _runtime_node_summary(node: Node, depth: int) -> Dictionary:
    _tree_nodes_seen += 1
    var children: Array = []
    if depth < MAX_TREE_DEPTH and _tree_nodes_seen < MAX_TREE_NODES:
        for child in node.get_children():
            if _tree_nodes_seen >= MAX_TREE_NODES:
                _tree_truncated = true
                break
            children.append(_runtime_node_summary(child, depth + 1))
    elif node.get_child_count() > 0:
        _tree_truncated = true
    return {
        "name": node.name,
        "type": node.get_class(),
        "path": str(node.get_path()),
        "children": children,
    }

## Reads named properties off one live node. Property values cross the wire tagged through the
## same encoder the editor plugin uses, so the renderer sees one representation.
func _op_inspect(params: Dictionary) -> Dictionary:
    var path := str(params.get("path", ""))
    if path.is_empty():
        return _failure("invalid_params", "runtime.inspect_node requires a path")
    var node := get_tree().root.get_node_or_null(NodePath(path))
    if node == null:
        return _failure("node_not_found", "No running node at '%s'" % path)
    var known: Array[String] = []
    for entry in node.get_property_list():
        known.append(str(entry["name"]))
    var properties := {}
    var requested: Array = params.get("properties", [])
    for name in requested:
        var property := str(name)
        if not known.has(property):
            return _failure("property_not_found", "Node '%s' has no property '%s'" % [path, property])
        properties[property] = Protocol.encode(node.get(property))
    return _succeed({
        "path": str(node.get_path()),
        "name": node.name,
        "type": node.get_class(),
        "properties": properties,
    })

## Injects input events into the game as if the user produced them, then waits for the input to be
## dispatched and the reaction to be rendered, so the answer carries a frame that already shows
## the effect. `applied` counts the events the decoder accepted.
func _op_input(params: Dictionary) -> Dictionary:
    var decoded := _decode_runtime_events(params.get("events", []))
    if not decoded["ok"]:
        return _failure("unsupported_value", decoded["message"])
    var events: Array = decoded["events"]
    if events.is_empty():
        return _failure("invalid_params", "runtime.input requires at least one event")
    for event in events:
        Input.parse_input_event(event)
    # One frame dispatches the buffered events, the second lets scripts react, and frame_post_draw
    # guarantees the capture reads pixels drawn after both.
    await get_tree().process_frame
    await get_tree().process_frame
    await RenderingServer.frame_post_draw
    var result := _succeed({"applied": events.size()})
    var frame := _capture_frame()
    if frame.get("ok", false):
        result["frame"] = frame["frame"]
    return result

func _op_capture() -> Dictionary:
    await RenderingServer.frame_post_draw
    return _capture_frame()

## Wraps the shared frame encoder in the game half's response convention. Both halves already agree
## on the shape; only the envelope around a failure differs.
func _capture_frame() -> Dictionary:
    var encoded := Protocol.encode_frame(get_tree().root.get_texture().get_image())
    if not encoded["ok"]:
        return _failure(str(encoded["code"]), str(encoded["message"]))
    return _succeed({"frame": encoded["frame"]})

func _op_monitors(params: Dictionary) -> Dictionary:
    var names: Array = params.get("monitors", [])
    if names.is_empty():
        names.assign(DEFAULT_MONITORS)
    var values := {}
    for entry in names:
        var monitor := str(entry)
        if not MONITORS.has(monitor):
            return _failure("unknown_monitor", "Performance monitor '%s' is not supported" % monitor)
        values[monitor] = Performance.get_monitor(MONITORS[monitor])
    return _succeed({"monitors": values})

## Builds typed input events from their wire summaries. Returns the same ok/events/message shape
## the editor plugin's decoder uses, so malformed events are rejected rather than injected wrong.
##
## An event may carry an optional `device`, which lands on the built event unchanged. The engine
## rewrites the default device of an event it receives, so this is the only way a game can tell
## injected input apart from whatever the desktop delivered to its window at the same moment.
func _decode_runtime_events(raw: Variant) -> Dictionary:
    if typeof(raw) != TYPE_ARRAY:
        return _decode_failed("events must be an array of input event objects")
    var events: Array = []
    for entry in raw:
        if typeof(entry) != TYPE_DICTIONARY:
            return _decode_failed("an input event must be an object carrying a kind")
        var kind := str((entry as Dictionary).get("kind", ""))
        match kind:
            "key":
                var key_name := str((entry as Dictionary).get("key", ""))
                var code := OS.find_keycode_from_string(key_name)
                if code == KEY_NONE:
                    return _decode_failed("Unknown key '%s'" % key_name)
                var key_event := InputEventKey.new()
                key_event.keycode = code
                key_event.pressed = bool((entry as Dictionary).get("pressed", true))
                events.append(key_event)
            "mouse_button":
                var button_name: Variant = (entry as Dictionary).get("button", "left")
                var button_index := MOUSE_BUTTON_LEFT
                if typeof(button_name) == TYPE_STRING:
                    if not MOUSE_BUTTONS.has(button_name):
                        return _decode_failed("Unknown mouse button '%s'" % button_name)
                    button_index = MOUSE_BUTTONS[button_name]
                else:
                    button_index = int(button_name)
                    if button_index < 1:
                        return _decode_failed("A mouse_button event requires a button index of 1 or higher")
                var mouse_event := InputEventMouseButton.new()
                mouse_event.button_index = button_index
                mouse_event.pressed = bool((entry as Dictionary).get("pressed", true))
                var position := _point((entry as Dictionary).get("position", [0, 0]))
                mouse_event.position = position
                mouse_event.global_position = position
                events.append(mouse_event)
            "mouse_motion":
                var motion_event := InputEventMouseMotion.new()
                motion_event.position = _point((entry as Dictionary).get("position", [0, 0]))
                motion_event.global_position = motion_event.position
                motion_event.relative = _point((entry as Dictionary).get("relative", [0, 0]))
                events.append(motion_event)
            "joypad_button":
                var pad_button := int((entry as Dictionary).get("button", -1))
                if pad_button < 0:
                    return _decode_failed("A joypad_button event requires a button index")
                var joypad_event := InputEventJoypadButton.new()
                joypad_event.button_index = pad_button
                joypad_event.pressed = bool((entry as Dictionary).get("pressed", true))
                events.append(joypad_event)
            "joypad_motion":
                var axis := int((entry as Dictionary).get("axis", -1))
                if axis < 0:
                    return _decode_failed("A joypad_motion event requires an axis index")
                var axis_event := InputEventJoypadMotion.new()
                axis_event.axis = axis
                axis_event.axis_value = clampf(
                    float((entry as Dictionary).get("value", 0.0)), -1.0, 1.0
                )
                events.append(axis_event)
            _:
                return _decode_failed("Input event kind '%s' is not supported" % kind)
        var device: Variant = (entry as Dictionary).get("device", null)
        if device != null:
            if typeof(device) != TYPE_INT and typeof(device) != TYPE_FLOAT:
                return _decode_failed("An input event device must be an integer")
            (events.back() as InputEvent).device = int(device)
    return {"ok": true, "events": events, "message": ""}

## Reads a two-number array as a Vector2, defaulting to the origin when the shape is wrong —
## pointer positions are best-effort, unlike event kinds, which are refused when unknown.
func _point(raw: Variant) -> Vector2:
    if typeof(raw) == TYPE_ARRAY and (raw as Array).size() == 2:
        return Vector2(float((raw as Array)[0]), float((raw as Array)[1]))
    return Vector2.ZERO

func _decode_failed(message: String) -> Dictionary:
    return {"ok": false, "events": [], "message": message}
