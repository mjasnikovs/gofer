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
## What a call that names no `limit` answers with.
##
## The envelope is not the binding cap. The worker bounds a tool result at 24,000 characters and
## slices it there, mid-JSON, so a tree that overruns reaches the model as a fragment it cannot
## parse and without the `truncated` flag that would have explained it. A live project's running
## tree was 235,113 characters of 2,024 nodes — 116 per node, and 120 at the widest measured — so a
## default of this many leaves the answer at roughly a fifth of that bound with the rest of the
## envelope to spare. A caller that wants more says so, and `root` and `depth` are how it reads a
## large tree a part at a time.
const DEFAULT_TREE_NODES := 150

## The longest a wait may hold its request open.
##
## One runtime request has twenty seconds before the editor answers it as a timeout, so a wait that
## could outlast that would answer as a failure having done exactly what it was asked. Half of the
## budget leaves the rest for the round trip.
const MAX_WAIT_MS := 10000
## Frames, capped so a frame count cannot outlast the same budget on a slow scene.
const MAX_WAIT_FRAMES := 600

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
## The bounds of the walk in progress, taken from the call and held at the engine's own caps.
var _tree_budget: int = MAX_TREE_NODES
var _tree_depth: int = MAX_TREE_DEPTH

func _ready() -> void:
    # The helper has to answer while the game it is inside is paused, which is the whole point of
    # `pause`: a caller freezes the game precisely so it can look at it.
    #
    # Measured: it answers without this line too. The editor's messages arrive through
    # `EngineDebugger`, which the main loop polls whether or not the tree is paused, and
    # `SceneTree.process_frame` — which `wait` and `capture` await — is emitted either way. So this
    # is a guard on the invariant rather than what makes it hold today: an op written later that
    # uses `_process` would otherwise stop answering the moment somebody paused, and the failure
    # would look like a hung game.
    process_mode = Node.PROCESS_MODE_ALWAYS
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
## coupling to where the strip happens.
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
            result = _op_tree(params)
        "inspect":
            result = _op_inspect(params)
        "input":
            result = await _op_input(params)
        "capture":
            result = await _op_capture()
        "monitors":
            result = _op_monitors(params)
        "pause":
            result = _op_pause(true)
        "resume":
            result = _op_pause(false)
        "wait":
            result = await _op_wait(params)
        _:
            result = _failure("unknown_command", "Runtime operation '%s' is not implemented" % op)
    result["id"] = id
    EngineDebugger.send_message("gofer:response", [result])

func _succeed(payload: Dictionary = {}) -> Dictionary:
    payload["ok"] = true
    return payload

func _failure(code: String, message: String) -> Dictionary:
    return {"ok": false, "code": code, "message": message}

## A node the running tree does not hold, and the spelling that would have found it.
##
## The failure this closes, counted over a week of one project: every `node_not_found` this script
## answered was a path written the way `godot_node` names the EDITED scene — `/Main/Units` — and
## all twenty calls that spelled it `/root/Main/...` were answered. Four were refused, and the
## refusal repeated the wrong spelling back without saying that another one existed. The editor's
## tool and this one name two trees in two processes, so one node has two names.
##
## Only `message` survives to the model: `plugin.gd` relays a runtime failure with its code and its
## message and drops `details`, so the corrected call is a sentence rather than a field. The
## parameter is named because the two callers spell it differently — `root` for the tree walk,
## `path` for the inspection — and a corrected call that names the wrong key is not one.
## Whether this is a name the engine made up, rather than one anybody wrote.
##
## Godot names an unnamed child `@ClassName@ID`, where the id counts instances for the whole run.
## A bullet or an enemy `add_child`ed by a spawner has one, and it belongs to that one instance:
## the next run gives it a different number, and freeing the node takes it away entirely.
func _is_an_engine_name(segment: String) -> bool:
    if not segment.begins_with("@"):
        return false
    var parts := segment.split("@", false)
    return parts.size() == 2 and parts[1].is_valid_int()

func _node_not_found(parameter: String, path: String) -> Dictionary:
    var plain := "No running node at '%s'" % path
    # A path read out of `get_tree` and used on the next call is the ordinary way to reach a node,
    # and it is exactly wrong for a node that lives for a moment. One live turn building a shooter
    # met this four times, always on a bullet or an enemy the spawner had never named.
    if _is_an_engine_name(path.get_file()):
        plain += (
            ". A name like that is the engine's own for a node nobody named: it belongs to one "
            + "instance, is numbered differently every run, and goes when that node is freed — "
            + "which is what a bullet or an enemy does between one call and the next. Watch "
            + "something that outlives it, or name the node where it is created"
        )
    if path.begins_with("/root/"):
        return _failure("node_not_found", plain)
    var spelled := "/root/" + path.trim_prefix("/")
    if get_tree().root.get_node_or_null(NodePath(spelled)) == null:
        return _failure("node_not_found", plain)
    var corrected := (
        "%s. The running tree names it '%s': every path here starts at /root, while godot_node"
        + " names the edited scene, which is a different tree in a different process."
        + " Send \"%s\": \"%s\"."
    )
    return _failure("node_not_found", corrected % [plain, spelled, parameter, spelled])

## Dumps the live scene tree from `root` down, `limit` nodes at most and `depth` levels at most.
##
## The default budget is what keeps `truncated` readable at all. The worker slices an oversized tool
## result at a fixed character count with no regard for the JSON, and the flag is inside whatever it
## cuts — so the answer is bounded here rather than explained after the fact.
func _op_tree(params: Dictionary) -> Dictionary:
    # Typed as `Node` rather than inferred: `get_tree().root` is a `Window`, and the lookup below
    # answers with a `Node`. Inferring the first makes the second a parse error, which stops this
    # whole script from loading and leaves every runtime call to time out.
    var start: Node = get_tree().root
    var from := str(params.get("root", ""))
    if not from.is_empty():
        start = get_tree().root.get_node_or_null(NodePath(from))
        if start == null:
            return _node_not_found("root", from)
    var levels := int(params.get("depth", MAX_TREE_DEPTH))
    # Cast rather than assigned: a JSON number reaches the addon as a float, and a typed
    # assignment from one is a runtime error that takes the whole response with it.
    var budget := int(params.get("limit", DEFAULT_TREE_NODES))
    _tree_nodes_seen = 0
    _tree_truncated = false
    _tree_budget = clampi(budget, 1, MAX_TREE_NODES)
    _tree_depth = clampi(levels, 0, MAX_TREE_DEPTH)
    var summary := _runtime_node_summary(start, 0)
    # `paused` rides along because nothing else carries it and the tree is what gets asked for.
    #
    # It belongs to the SceneTree, which is not a Node, so `inspect_node` cannot reach it: two live
    # turns asked for it as a property of `/root` and were told `/root has no property 'paused'`,
    # which is true and useless. The only other way to it is `godot_debug evaluate`, which means
    # attaching a debugger to read one boolean. A pause menu is the commonest reason to want it.
    return _succeed({
        "truncated": _tree_truncated,
        "root": summary,
        "paused": get_tree().paused,
    })

func _runtime_node_summary(node: Node, depth: int) -> Dictionary:
    _tree_nodes_seen += 1
    var children: Array = []
    if depth < _tree_depth and _tree_nodes_seen < _tree_budget:
        for child in node.get_children():
            if _tree_nodes_seen >= _tree_budget:
                _tree_truncated = true
                break
            children.append(_runtime_node_summary(child, depth + 1))
    elif node.get_child_count() > 0:
        _tree_truncated = true
    return {
        "name": node.name,
        "type": node.get_class(),
        # The class whose icon the editor would draw. The game has no editor theme to read, so the
        # name is all the running tree can carry: the editor side resolves it to artwork.
        "icon": _runtime_icon_class(node),
        "path": str(node.get_path()),
        "children": children,
    }

## Lets the game run on, and answers with what actually passed.
##
## Waiting used to mean `sleep` in the agent's shell — thirteen of thirty bash calls in one live
## project. That stops the agent's own process while the game keeps going, so it measures nothing,
## and it costs a whole request to do nothing. This runs inside the game: the frames really are
## rendered before the answer leaves, so a capture or an inspection after it sees the state the
## wait was for.
##
## Both bounds are held at once. A frame count on a stalled scene would never arrive, and a
## duration on a fast one would spin through thousands of frames, so whichever runs out first ends
## the wait and the answer says which.
func _op_wait(params: Dictionary) -> Dictionary:
    var wanted_ms := clampi(int(params.get("ms", 0)), 0, MAX_WAIT_MS)
    var wanted_frames := clampi(int(params.get("frames", 0)), 0, MAX_WAIT_FRAMES)
    # Neither named is one frame: the commonest ask is simply "let this take effect".
    if wanted_ms == 0 and wanted_frames == 0:
        wanted_frames = 1
    var started := Time.get_ticks_msec()
    var deadline := started + (wanted_ms if wanted_ms > 0 else MAX_WAIT_MS)
    var frames := 0
    # The deadline bounds every wait; the frame count bounds only a wait that named one. Bounding an
    # `ms` wait by frames as well ended it early on a fast display — 600 frames is 4.2 seconds at
    # 144Hz, so `{"ms": 5000}` came back having waited four.
    while Time.get_ticks_msec() < deadline:
        if wanted_frames > 0 and frames >= wanted_frames:
            break
        await get_tree().process_frame
        frames += 1
    return _succeed({"frames": frames, "ms": Time.get_ticks_msec() - started})

func _runtime_icon_class(node: Node) -> String:
    var script: Variant = node.get_script()
    if script is Script:
        var global_name := (script as Script).get_global_name()
        if not global_name.is_empty():
            return global_name
    return node.get_class()

## Freezes the running game, or lets it go again.
##
## `SceneTree.paused` is the game's own pause — the one a pause menu sets — so a node that opted out
## of pausing keeps running, exactly as it would for a player.
##
## It exists because a path into a running game goes stale. A live turn building a shooter read the
## tree, inspected what it found, and was answered `No running node at '/root/Main/@Area2D@19'` six
## times: bullets and enemies are freed between one call and the next. It reached for the debugger
## to freeze the game instead, found that a pause there is not a break and gives no stack, and in
## the end **added a debug property to its own game** so it would have something that stood still.
## That is a tool gap solved in the product being built, which is the wrong place for it.
func _op_pause(paused: bool) -> Dictionary:
    get_tree().paused = paused
    # Read back rather than asserted: `paused` is a plain setter today, and a reply that says what
    # the tree answers is the reply that stays true if it stops being one.
    return _succeed({"paused": get_tree().paused})

## Reads named properties off one live node. Property values cross the wire tagged through the
## same encoder the editor plugin uses, so the renderer sees one representation.
func _op_inspect(params: Dictionary) -> Dictionary:
    var path := str(params.get("path", ""))
    if path.is_empty():
        return _failure("invalid_params", "runtime.inspect_node requires a path")
    # Trimmed for the reason the editor side trims: outer whitespace on a node path is never
    # meaningful, and is what a model's JSON leaves behind when it slips.
    path = path.strip_edges()
    var node := get_tree().root.get_node_or_null(NodePath(path))
    if node == null:
        return _node_not_found("path", path)
    var known: Array[String] = []
    for entry in node.get_property_list():
        known.append(str(entry["name"]))
    var properties := {}
    var requested: Array = params.get("properties", [])
    for name in requested:
        var property := str(name)
        if not known.has(property):
            return _failure(
                "property_not_found",
                "Node '%s' has no property '%s'%s" % [path, property, _nearest_of(node, property)]
            )
        properties[property] = Protocol.encode(node.get(property))
    return _succeed({
        "path": str(node.get_path()),
        "name": node.name,
        "type": node.get_class(),
        "properties": properties,
        "groups": _authored_groups(node),
    })

## The groups a person put a node in, which is not everything `get_groups` answers.
##
## The same filter `node.inspect` applies on the editor side, and the same reason: the engine keeps
## its own groups on a node behind a leading underscore, named after object ids that change every
## run, and a caller reading one it never added has no way to know it is not its own.
##
## Answered without being asked for, because a group is not a property and there was no way to ask.
## A live turn wanted to know whether a coin it had put in `coin` was still in it once the game was
## up, wrote `inspect_node {properties: ["groups"]}` — the word `node.inspect` answers with — and
## was told `Node '/root/Main/Coin' has no property 'groups'`, which is true and useless. Group
## membership is the one part of a node that the running game and the edited scene disagree about
## most, since `add_to_group` in a script is how half of them are joined.
func _authored_groups(node: Node) -> Array:
    var authored: Array = []
    for group in node.get_groups():
        if not str(group).begins_with("_"):
            authored.append(str(group))
    return authored

## The property nearest a name this node does not have, as a clause, or "".
##
## The editor side says the same thing for the same reason: one live turn asked the running game for
## `transform_2d`, which is one edit from `transform`, and was told only that it is absent. Case and
## underscores are ignored and one has to be a prefix of the other, with four characters at least —
## `x` would otherwise answer for everything beginning with it.
func _nearest_of(node: Node, property: String) -> String:
    var wanted := property.to_lower().replace("_", "")
    if wanted.is_empty():
        return ""
    for entry in node.get_property_list():
        var name := str(entry.get("name", ""))
        if name.is_empty() or name.contains("/"):
            continue
        # The inspector's own headings are in this list: a Sprite2D's `Transform` sits beside its
        # `transform`, and a heading is not a property anyone can set.
        var usage := int(entry.get("usage", 0))
        if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
            continue
        var plain := name.to_lower().replace("_", "")
        if plain == wanted:
            return ". Did you mean '%s'?" % name
        if mini(plain.length(), wanted.length()) < 4:
            continue
        if plain.begins_with(wanted) or wanted.begins_with(plain):
            return ". Did you mean '%s'?" % name
    return ""

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
            # The names, because the set is closed and short. Every other closed vocabulary in this
            # file says what it holds; this one only said what it does not.
            var offered: Array = MONITORS.keys()
            offered.sort()
            return _failure(
                "unknown_monitor",
                (
                    "Performance monitor '%s' is not supported. The monitors are %s"
                    % [monitor, ", ".join(offered)]
                )
            )
        values[monitor] = Performance.get_monitor(MONITORS[monitor])
    return _succeed({"monitors": values})

## Builds typed input events from their wire summaries. Returns the same ok/events/message shape
## the editor plugin's decoder uses, so malformed events are rejected rather than injected wrong.
##
## An event may carry an optional `device`, which lands on the built event unchanged. The engine
## rewrites the default device of an event it receives, so this is the only way a game can tell
## injected input apart from whatever the desktop delivered to its window at the same moment.
## The five an event may be. Named in the refusal, because a caller that got one wrong has nowhere
## else to read them.
const EVENT_KINDS: Array[String] = [
    "key", "mouse_button", "mouse_motion", "joypad_button", "joypad_motion"
]

## Whether an event that does not spell `pressed` is a press or the release of the one before it.
##
## `pressed` used to default to `true` for every event, and the catalogue says "send the release as
## a second event, or the key stays down" — so a model that read that and wrote the same event twice
## sent two presses and no release. A Godot `Button` emits `pressed` on the button *up*, so a menu
## clicked that way never opens. Measured against 4.7.2 in a windowed game: press then release fires
## it once, two presses fire it not at all. One live turn spent **twenty calls** on a Start button
## that way — every call answered `applied: 2`, every one changing nothing, and no error anywhere.
##
## So an event with no `pressed` alternates on its own identity within one call: the first is the
## press, the second is the release, the third is a press again. An event that spells `pressed` is
## left exactly as it was written, which is every call the acceptance suite makes.
##
## The identity is the kind and the key or button, not the position: a click is a press and a
## release of the same button, wherever the pointer is.
func _pressed_or_released(entry: Dictionary, held: Dictionary, identity: String) -> bool:
    if entry.has("pressed"):
        return bool(entry["pressed"])
    var down: bool = not bool(held.get(identity, false))
    held[identity] = down
    return down


func _decode_runtime_events(raw: Variant) -> Dictionary:
    if typeof(raw) != TYPE_ARRAY:
        return _decode_failed("events must be an array of input event objects")
    var events: Array = []
    # Which buttons and keys this call has already put down, so an event that does not spell
    # `pressed` alternates rather than repeating. See `_pressed_or_released`.
    var held := {}
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
                # Both, because an event from a real keyboard carries both and the Input Map may
                # be bound on either. `project.set_input_action` writes its bindings on the
                # *physical* key, so a key injected with only `keycode` matched none of the actions
                # Gofer itself registered: the event was delivered, matched nothing, and the game
                # simply did not move — with no error anywhere to say why.
                key_event.keycode = code
                key_event.physical_keycode = code
                key_event.pressed = _pressed_or_released(entry as Dictionary, held, "key:%d" % code)
                events.append(key_event)
            "mouse_button":
                var button_name: Variant = (entry as Dictionary).get("button", "left")
                var button_index := MOUSE_BUTTON_LEFT
                if typeof(button_name) == TYPE_STRING:
                    if not MOUSE_BUTTONS.has(button_name):
                        # The names, because the set is five long and a refusal that does not carry
                        # it is a refusal a caller cannot act on. One live turn sent the string
                        # "1" — the number is accepted, the string spelling of it is not — and was
                        # told only that "1" is unknown.
                        var offered: Array = MOUSE_BUTTONS.keys()
                        offered.sort()
                        return _decode_failed(
                            (
                                "Unknown mouse button '%s'. The named buttons are %s, "
                                + "or a button index as a number"
                            ) % [button_name, ", ".join(offered)]
                        )
                    button_index = MOUSE_BUTTONS[button_name]
                else:
                    button_index = int(button_name)
                    if button_index < 1:
                        return _decode_failed("A mouse_button event requires a button index of 1 or higher")
                var mouse_event := InputEventMouseButton.new()
                mouse_event.button_index = button_index
                mouse_event.pressed = _pressed_or_released(
                    entry as Dictionary, held, "mouse:%d" % button_index
                )
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
                joypad_event.pressed = _pressed_or_released(
                    entry as Dictionary, held, "pad:%d" % pad_button
                )
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
                # Named, because the kinds are the whole vocabulary and a caller that got one wrong
                # has nowhere else to read them. A live turn sent an event with no kind at all and
                # was answered `Input event kind '' is not supported` twenty-two times running —
                # true, and naming nothing to send instead. The parameter contract refuses this
                # before it reaches the socket now; this is what answers anything that gets past it.
                if kind.is_empty():
                    return _decode_failed(
                        "An input event needs a kind: one of %s" % ", ".join(EVENT_KINDS)
                    )
                return _decode_failed(
                    "Input event kind '%s' is not one of %s" % [kind, ", ".join(EVENT_KINDS)]
                )
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
