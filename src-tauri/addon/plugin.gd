@tool
extends EditorPlugin

## The Gofer editor plugin.
##
## Gofer stages this addon into the active task worktree and removes it again when the session
## stops. It connects outward to Gofer's loopback RPC server using the port and token passed in the
## process environment, then answers inspection and undoable scene-authoring requests on Godot's
## main thread.
##
## Runtime requests need the game process, so they cross Godot's remote-debugger channel: the
## GoferDebuggerBridge registered below forwards them to the staged GoferRuntime autoload inside
## the running game and correlates its replies with the RPC requests that are waiting on them.

const PROTOCOL_VERSION := 2
const HANDSHAKE_ID := "handshake-1"
## The encoders the game process needs too, so they live beside both scripts instead of in either.
const Protocol := preload("res://addons/gofer/protocol.gd")
## The decisions the commands make before they touch the editor. Needs no editor, so it is loadable
## without one — which is what puts every parameter refusal in the fast headless suite.
const Params := preload("res://addons/gofer/params.gd")

var _peer: StreamPeerTCP
var _status: int = -1
var _pending_line: String = ""
var _ready_notified: bool = false
var _readiness: String = "starting"
## Frames the editor has been settled without opening the scene it opens for itself. See
## `STARTUP_OPEN_SETTLED_FRAMES`.
var _startup_open_settled_frames: int = 0
## The dialog the last `session.dialog` event described, as text. Empty means none was open.
var _reported_dialog: String = ""
# Gofer assigns the session id in its handshake response; events carry it as their envelope id.
var _session_id: String = "gofer-session"

# Edited scene state. A revision starts at 0 when a scene is opened or created and increments on
# every accepted mutation. Save keeps the revision and clears dirty; reload resets both.
var _current_scene_path: String = ""
var _scene_revision: int = 0
var _scene_dirty: bool = false
var _undo_depth: int = 0
var _redo_depth: int = 0
# Play mode is not a protocol readiness, so it is tracked apart from `_readiness`.
var _playing: bool = false

# Requests waiting on the editor to switch scenes. `EditorInterface.open_scene_from_path` and
# `reload_scene_from_path` only *ask* for the switch — the editor ignores the request outright
# while it is busy with another one (an `is_changing_scene` guard GDScript cannot read). An answer
# sent as soon as the request was made therefore claims a scene the editor may not be editing, and
# the next command resolves its nodes against whatever scene really is. `_sweep_scene_pending`
# re-asks until the editor obeys and answers only then, so the answer means what it says.
var _scene_pending: Array[Dictionary] = []

# Requests waiting on a project-wide rescan. `EditorFileSystem.scan()` only *starts* the walk — it
# returns on the frame it was called and the editor imports what it found afterwards. An answer
# sent when the call returns therefore says an asset is there while `load` still answers nothing,
# and the caller acting on that answer is told the file it just wrote does not exist.
# `_sweep_scan_pending` answers when the scan the request started has finished.
var _scan_pending: Array[Dictionary] = []
## How many project scans have completed, which is how a parked request knows its own is over.
var _scans_completed: int = 0
## True while `_sweep_scan_pending` is inside `reimport_files`, and the whole reason that sweep is
## not re-entrant.
##
## `EditorFileSystem::reimport_files` opens a progress dialog, and that dialog runs a full
## `Main::iteration()` on the main loop. The iteration reaches this addon's `_process`, which calls
## the sweep again — on a frame where the first import has not returned. `is_importing()` is not a
## defence against that: the sweep read it, found the editor settled, and started a second import
## from inside the first. A live session logged `Task 'reimport' already exists` eleven times,
## then twenty-two progress steps against a task that was never added, and answered `scan_timeout`
## thirty seconds later about an editor that was not importing anything of its own.
var _sweeping_scans: bool = false

## A cold project walk imports every asset the project holds, so it is given the same budget as a
## scene switch over the same imports.
##
## It is a backstop and no longer the thing that ends a wait. A clock cannot tell a slow project
## from a stuck one, and this one used to answer `scan_timeout: the editor is still importing` —
## retryable, and false — about an editor that was importing nothing. What ends a wait now is
## evidence: the walk landed and the files load, or the walk landed and they do not.
const RESOURCE_SCAN_TIMEOUT_MS := 30000

## How many settled frames a finished walk may go unreported before the wait is called a fault.
##
## `filesystem_changed` is what says a walk has landed, and it arrives a frame or two after the
## editor stops claiming to scan. This is the gap between those two, not a duration anyone tuned:
## past it the editor is idle, the signal is never coming, and asking again cannot help.
const RESOURCE_SCAN_SETTLED_FRAMES := 30

## How many settled frames the editor gets to open the scene it opens for itself, before a session
## stops waiting for one.
##
## The wait exists because that open replaces whatever scene is being edited. It has to end, though:
## a main scene the editor cannot build — a `.tscn` with a parse error in it — is a scene by every
## question that can be asked about the file, and the open never comes. Without this the session
## stayed `importing` for the life of the editor, so nothing could be authored on a project whose
## main scene was broken, which is the project most likely to need authoring.
const STARTUP_OPEN_SETTLED_FRAMES := 30

## How many files one `resource.rescan` may name. A batch is what this command is for now, and a
## project walk is cheaper than importing more files than this one by one.
const MAX_RESCAN_PATHS := 256

## A scene switch outlives a cold import of everything the scene depends on.
const SCENE_SWITCH_TIMEOUT_MS := 30000
## How often a scene switch the editor has not obeyed is asked for again. The editor drops the
## request while it is busy, so it has to be repeated — but a scene the editor cannot build prints
## its complaint on every attempt, and asking at frame rate turned one bad file into a thousand
## errors and a stack of modal dialogs.
const SCENE_SWITCH_RETRY_MS := 1000

# Runtime bridge state. `_runtime_session_id` names the debugger session of the running game and
# `_runtime_ready` flips when its GoferRuntime autoload announces itself. `_runtime_pending` holds
# RPC requests waiting on the game — forwarded queries, launches waiting for the helper, and the
# first-frame capture chained onto every launch — each with a deadline `_process` sweeps.
var _debugger_bridge: GoferDebuggerBridge
var _runtime_session_id: int = -1
var _runtime_ready: bool = false
## Whether the debugger has paused the game and the game has said nothing since. A game paused at an
## error is running and unreachable at once: it is neither "not running" nor able to answer.
##
## Kept as "and has said nothing since" rather than as the debugger's own `is_breaked()`, which is
## the obvious source and the wrong one. A break Gofer's debug adapter continues or terminates
## leaves that flag set on the editor's session, so it reads `true` over a game that is running
## perfectly well and answering — and every runtime call would then be refused against a healthy
## game, which is worse than the wait this is here to end. Any message from the game is proof it is
## running, and a paused game sends none.
var _runtime_broke: bool = false
var _runtime_pending: Array[Dictionary] = []

## Frames left before the editor quits, counted down by `_process`. Zero means no quit is due.
##
## `session.quit` cannot quit inside its own handler: the answer would never reach the caller,
## which would read the closed socket as a crash rather than the shutdown it asked for. The
## response is written first and the quit happens a frame later.
var _quit_countdown: int = 0

## Forwarded runtime requests outlive a few slow frames, launches outlive a cold game boot.
const RUNTIME_REQUEST_TIMEOUT_MS := 20000
const RUNTIME_LAUNCH_TIMEOUT_MS := 30000

## The pending kinds that are waiting on a game the editor has already been told to start, and so
## are ended by that game dying. `restart` is not one of them: it is waiting for the *previous*
## game to go, and a stopped editor is the thing it wants.
const LAUNCH_KINDS: Array[String] = ["run", "run_frame"]

## The commands `_handle_request` routes to the runtime bridge instead of answering synchronously.
# GENERATED-BEGIN runtime-commands sha256:283845705f503a66
const RUNTIME_COMMANDS: Array[String] = [
    "runtime.run",
    "runtime.stop",
    "runtime.restart",
    "runtime.get_state",
    "runtime.get_tree",
    "runtime.inspect_node",
    "runtime.input",
    "runtime.capture",
    "runtime.get_monitors",
]
# GENERATED-END runtime-commands

## The plugin's own directory name, protected so a configuration command cannot sever the session
## that carries it.
const GOFER_PLUGIN_NAME := "gofer"
## The autoload Gofer stages; cleanup owns it, so configuration commands refuse to touch it.
const GOFER_AUTOLOAD_NAME := "GoferRuntime"
## Search results are capped so a broad query cannot exceed the 1 MiB envelope limit.
const MAX_SEARCH_RESULTS := 50

## One icon request covers a whole scene tree's worth of classes and no more, and each icon stays
## the size the editor draws it, so the batch stays far inside the envelope limit.
const MAX_ICON_CLASSES := 200
const MAX_ICON_EDGE := 64
## A script class chain is walked this far towards an engine class before the icon lookup gives up.
const MAX_ICON_BASE_DEPTH := 32

## The atlas a tileset command will cut up, and the cells one paint may write, both capped so a
## mistyped tile size or a runaway rectangle cannot spend minutes inside the editor's main loop.
const MAX_TILESET_TILES := 4096
const MAX_PAINTED_CELLS := 20000
## How many entries one batching command takes. A batch is a single blocking pass over the editor's
## main loop, and the reply names every entry, so this is what keeps a runaway list from freezing the
## editor and from answering with a response nothing can read.
const MAX_BATCH_ENTRIES := 200
## How many tiles or cells a report lists before it says it stopped.
const MAX_REPORTED_TILES := 512
## The tile size a tileset is cut to when the caller names none: the size the 2D pixel art this is
## for is drawn at.

## Types `node.create` refuses, and why, so the refusal explains itself.
##
## `MissingNode` is the engine's own placeholder for a class a scene named and the editor could not
## find: it remembers the original type and writes it back out, so a scene opened without its plugin
## costs nothing. Created on purpose it has nothing to remember, saves with no `type=` at all, and
## the loader reads a typeless node as one inherited from a base scene — finds no base scene, and
## drops it. The caller would be handed a node that saves cleanly and is gone on the next open.
const UNCREATABLE_TYPES := {
    "MissingNode":
    (
        "MissingNode is the engine's placeholder for a type it could not find, not a node to "
        + "author. One created on purpose saves with no type and is dropped the next time the "
        + "scene is opened."
    ),
}

## The 2D shapes `resource.create_shape` can build, and the dimension each one takes.
##
## A `CollisionShape2D` with no shape is an empty node, and a shape can only be assigned from a file
## that exists — so without this the physics half of the node catalogue could be created and never
## filled in.
const SHAPE_TYPES := {
    "RectangleShape2D": "size",
    "CircleShape2D": "radius",
    "CapsuleShape2D": "radius and height",
    "SegmentShape2D": "points",
    "WorldBoundaryShape2D": "nothing",
}

# GENERATED-BEGIN mutating-commands sha256:cff35d5510fe56d3
const MUTATING_COMMANDS: Array[String] = [
    "session.undo",
    "session.redo",
    "scene.create",
    "scene.save",
    "scene.save_as",
    "scene.reload",
    "node.create",
    "node.create_nodes",
    "node.instantiate",
    "node.duplicate",
    "node.rename",
    "node.reparent",
    "node.delete",
    "node.set_property",
    "node.set_properties",
    "node.add_to_group",
    "node.remove_from_group",
    "node.connect_signal",
    "node.disconnect_signal",
    "node.set_cells",
]
# GENERATED-END mutating-commands

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
# GENERATED-BEGIN command-params sha256:35ab49c9594d4a6e
const COMMAND_PARAMS: Dictionary = {
    "session.get_state": {"required": [], "optional": []},
    "session.undo": {"required": [], "optional": []},
    "session.redo": {"required": [], "optional": []},
    "session.answer_dialog": {"required": ["button"], "optional": []},
    "scene.list": {"required": [], "optional": []},
    "scene.open": {"required": ["path"], "optional": []},
    "scene.create": {"required": ["path", "rootType"], "optional": ["rootName"]},
    "scene.get_tree": {"required": [], "optional": []},
    "scene.save": {"required": [], "optional": []},
    "scene.save_as": {"required": ["path"], "optional": []},
    "scene.reload": {"required": [], "optional": []},
    "node.inspect": {"required": ["node"], "optional": ["scene"]},
    "node.create": {"required": ["parent", "type", "name"], "optional": ["index", "scene"]},
    "node.create_nodes": {"required": ["nodes"], "optional": ["scene"]},
    "node.instantiate": {"required": ["parent", "path"], "optional": ["name", "index", "scene"]},
    "node.duplicate": {"required": ["node"], "optional": ["name", "scene"]},
    "node.rename": {"required": ["node", "name"], "optional": ["scene"]},
    "node.reparent": {"required": ["node", "newParent"], "optional": ["index", "scene"]},
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
    "project.list_input_actions": {"required": [], "optional": []},
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
    "resource.create_shape": {"required": ["path", "shapeType"], "optional": ["size", "radius", "height", "points"]},
    "resource.describe_tileset": {"required": ["path"], "optional": []},
    "runtime.run": {"required": [], "optional": []},
    "runtime.stop": {"required": [], "optional": []},
    "runtime.restart": {"required": [], "optional": []},
    "runtime.get_state": {"required": [], "optional": []},
    "runtime.get_tree": {"required": [], "optional": []},
    "runtime.inspect_node": {"required": ["path"], "optional": ["properties"]},
    "runtime.input": {"required": ["events"], "optional": []},
    "runtime.capture": {"required": [], "optional": ["source"]},
    "runtime.get_monitors": {"required": [], "optional": ["monitors"]},
}
# GENERATED-END command-params

## The editor half of the debugger channel. Godot calls `_setup_session` as debugger sessions
## come up, delivers game messages whose prefix `_has_capture` claims to `_capture`, and the
## plugin answers through `get_session(id).send_message`. The plugin itself is held by weak
## reference: the bridge must never keep the addon alive past `_exit_tree`.
##
## The bridge holds a capture prefix, a hello beacon before the editor sends anything, and a
## session-stopped connection that survives play/stop/play cycles.
class GoferDebuggerBridge extends EditorDebuggerPlugin:
    var _plugin: WeakRef

    func _init(plugin: EditorPlugin) -> void:
        _plugin = weakref(plugin)

    func _has_capture(capture: String) -> bool:
        return capture == "gofer"

    func _capture(message: String, data: Array, session_id: int) -> bool:
        var plugin = _plugin.get_ref()
        if plugin != null:
            plugin._on_runtime_debugger_message(message, data, session_id)
        return true

    func _setup_session(session_id: int) -> void:
        var session := get_session(session_id)
        if session != null:
            # The editor reuses one session across play/stop/play cycles, so the connections must
            # survive every stop; a one-shot would be consumed by the first restart.
            var stopped := _on_session_stopped.bind(session_id)
            if not session.stopped.is_connected(stopped):
                session.stopped.connect(stopped)
            # A game paused at an error is running and silent, which is indistinguishable from a
            # slow one until the debugger says otherwise.
            var breaked := _on_session_breaked.bind(session_id)
            if not session.breaked.is_connected(breaked):
                session.breaked.connect(breaked)
        var plugin = _plugin.get_ref()
        if plugin != null:
            plugin._on_runtime_debugger_session_started(session_id)

    func _on_session_stopped(session_id: int) -> void:
        var plugin = _plugin.get_ref()
        if plugin != null:
            plugin._on_runtime_debugger_session_stopped(session_id)

    func _on_session_breaked(_can_debug: bool, session_id: int) -> void:
        var plugin = _plugin.get_ref()
        if plugin != null:
            plugin._on_runtime_debugger_session_breaked(session_id)

func _enter_tree() -> void:
    print("GOFER_ADDON_READY:%d" % PROTOCOL_VERSION)
    _debugger_bridge = GoferDebuggerBridge.new(self)
    add_debugger_plugin(_debugger_bridge)
    # The one thing the editor says out loud when a project scan is over. Polling `is_scanning`
    # cannot stand in for it: `scan()` is threaded, so the frame after the call reads idle for a
    # scan that has not started yet.
    EditorInterface.get_resource_filesystem().filesystem_changed.connect(_on_filesystem_scanned)
    _peer = StreamPeerTCP.new()
    var port := _rpc_port()
    if port > 0:
        _peer.connect_to_host("127.0.0.1", port)
        _status = _peer.get_status()
    set_process(true)

func _exit_tree() -> void:
    print("GOFER_ADDON_STOPPED")
    if _debugger_bridge != null:
        remove_debugger_plugin(_debugger_bridge)
        _debugger_bridge = null
    if _peer:
        _peer.disconnect_from_host()
    set_process(false)

func _get_plugin_name() -> String:
    return "Gofer"

func _process(_delta: float) -> void:
    if _quit_countdown > 0:
        _quit_countdown -= 1
        if _quit_countdown == 0:
            # The editor's own quit, not a signal from outside. Godot writes EditorSettings on the
            # way out of this path and on no other: SIGTERM, SIGINT and SIGKILL all leave the
            # settings file untouched, so an editor Gofer killed threw away every editor setting
            # an agent had changed while `editor.set_setting` answered as though it had kept them.
            EditorInterface.get_base_control().get_tree().quit()
            return
    _sweep_runtime_pending()
    _sweep_scene_pending()
    _sweep_scan_pending()
    if _peer == null:
        return
    _peer.poll()
    var status := _peer.get_status()
    if status != _status:
        _status = status
        if status == StreamPeerTCP.STATUS_CONNECTED:
            _send_handshake()
        else:
            # The connection is what carried the announcement, so the announcement goes with it.
            # Leaving `_ready_notified` set meant a reconnected addon never said it was ready
            # again: `_readiness` stayed on the "unavailable" the drop wrote, every mutation was
            # refused `not_ready` against a perfectly healthy editor, and nothing said why.
            _ready_notified = false
            _playing = false
            _set_readiness("unavailable")
        return
    if status != StreamPeerTCP.STATUS_CONNECTED:
        return

    if not _ready_notified:
        if _editor_finished_starting():
            _ready_notified = true
            _set_readiness("ready")
        elif _readiness != "importing":
            _set_readiness("importing")

    _track_play_state()
    _track_edited_scene()
    _track_dialog()

    var available := _peer.get_available_bytes()
    while available > 0:
        var byte := _peer.get_8()
        if byte == 10:
            var line := _pending_line
            _pending_line = ""
            _handle_line(line)
            available = _peer.get_available_bytes()
        else:
            _pending_line += String.chr(byte)
            available -= 1

func _rpc_port() -> int:
    var value := OS.get_environment("GOFER_RPC_PORT")
    if value.is_empty():
        return 0
    return value.to_int()

func _rpc_token() -> String:
    return OS.get_environment("GOFER_RPC_TOKEN")

func _project_path() -> String:
    return ProjectSettings.globalize_path("res://")

## Reports the engine as `major.minor.patch.channel`, which is the shape the protocol validates.
##
## The `string` field of `Engine.get_version_info()` reads "4.7.1-stable (official)" — a display
## string, not a version the handshake can carry.
func _engine_version() -> String:
    var info := Engine.get_version_info()
    return "%d.%d.%d.%s" % [info["major"], info["minor"], info["patch"], info["status"]]

func _addon_version() -> String:
    var config := ConfigFile.new()
    var path: String = get_script().get_path().get_base_dir().path_join("plugin.cfg")
    if config.load(path) == OK:
        return config.get_value("plugin", "version", "2.0.0")
    return "2.0.0"

func _send_handshake() -> void:
    var handshake := {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "handshake",
        "id": HANDSHAKE_ID,
        "token": _rpc_token(),
        "acceptedVersions": [PROTOCOL_VERSION],
        "client": {
            "name": "gofer-godot-addon",
            "addonVersion": _addon_version(),
            "engineVersion": _engine_version(),
            "projectPath": _project_path(),
            "capabilities": ["session", "scene", "node", "project", "editor", "runtime"]
        }
    }
    _put_json(handshake)

func _handle_line(line: String) -> void:
    if line.is_empty():
        return
    var json := JSON.new()
    var error := json.parse(line)
    if error != OK:
        push_warning("Gofer addon ignored invalid JSON: %s" % line)
        return
    var envelope := json.data as Dictionary
    var kind: String = envelope.get("kind", "")
    if kind == "request":
        _handle_request(envelope)
    elif kind == "response" and envelope.get("id", "") == HANDSHAKE_ID:
        var result := envelope.get("result", {}) as Dictionary
        var session_id: String = result.get("sessionId", "")
        if not session_id.is_empty():
            _session_id = session_id

func _handle_request(envelope: Dictionary) -> void:
    var id: String = envelope.get("id", "")
    var command: String = envelope.get("command", "")
    var params := envelope.get("params", {}) as Dictionary
    var expected_revision = envelope.get("expectedRevision", null)

    if RUNTIME_COMMANDS.has(command):
        _handle_runtime_request(id, command, params)
        return

    var result: Variant = _dispatch_command(command, params, expected_revision)
    if result is Dictionary and result.has("_gofer_error"):
        _respond_error_dict(id, result["_gofer_error"])
    elif result is Dictionary and result.has("_gofer_pending_scene"):
        _defer_scene_switch(id, command, result["_gofer_pending_scene"])
    elif result is Dictionary and result.has("_gofer_pending_scan"):
        var scan: Dictionary = result["_gofer_pending_scan"]
        scan["id"] = id
        _scan_pending.append(scan)
    elif MUTATING_COMMANDS.has(command):
        _respond_result(id, result, _scene_revision)
    else:
        _respond_result(id, result)

## Answers an RPC request. Deferred runtime requests use these helpers when the game eventually
## answers; synchronous handlers go through the `_gofer_error` convention in `_dispatch_command`.
func _respond_result(id: String, result: Variant, revision: Variant = null) -> void:
    var response := {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "id": id,
        "result": result,
    }
    if revision != null:
        response["revision"] = revision
    _put_json(response)

## Writes a refusal, and tells it what the editor is waiting on.
##
## Every failure carries the open dialog, because a caller that just failed is the one about to
## try again. A model reads results and nothing else: an event it never sees and a state it did
## not think to ask for both leave it looping against an editor that is waiting for a person. The
## sentence it does read is the one attached to the thing that just went wrong.
func _respond_error_dict(id: String, error: Dictionary) -> void:
    var asking: Variant = _editor_dialog()
    if asking != null:
        var details: Dictionary = error.get("details", {})
        if not details.has("dialog"):
            details["dialog"] = asking
            error["details"] = details
    _put_json({"protocolVersion": PROTOCOL_VERSION, "kind": "error", "id": id, "error": error})

func _respond_error(id: String, code: String, message: String, retryable: bool, details: Dictionary = {}) -> void:
    _respond_error_dict(id, {
        "code": code,
        "message": message,
        "retryable": retryable,
        "readiness": _readiness,
        "details": details,
    })

func _dispatch_command(command: String, params: Dictionary, expected_revision: Variant) -> Dictionary:
    if MUTATING_COMMANDS.has(command):
        var check := _check_mutation_prerequisites(expected_revision)
        if check.has("_gofer_error"):
            return check
    var declared := _check_declared_params(command, params)
    if declared.has("_gofer_error"):
        return declared

# GENERATED-BEGIN dispatch-table sha256:3a410dce9fbcd6f9
    match command:
        "session.get_state":
            return _session_state()
        "session.cancel":
            return _session_cancel(params)
        "session.quit":
            return _session_quit()
        "session.undo":
            return _undo()
        "session.redo":
            return _redo()
        "session.answer_dialog":
            return _session_answer_dialog(params)
        "session.get_unsaved_scenes":
            return _session_unsaved_scenes()
        "session.save_all_scenes":
            return _session_save_all_scenes()
        "project.get_settings":
            return _project_settings()
        "project.search_settings":
            return _project_search_settings(params)
        "project.get_setting":
            return _project_get_setting(params)
        "project.set_setting":
            return _project_set_setting(params)
        "project.reset_setting":
            return _project_reset_setting(params)
        "project.list_autoloads":
            return _project_list_autoloads()
        "project.set_autoload":
            return _project_set_autoload(params)
        "project.remove_autoload":
            return _project_remove_autoload(params)
        "project.list_input_actions":
            return _project_list_input_actions()
        "project.set_input_action":
            return _project_set_input_action(params)
        "project.remove_input_action":
            return _project_remove_input_action(params)
        "project.reset_input_action":
            return _project_reset_input_action(params)
        "project.list_plugins":
            return _project_list_plugins()
        "project.set_plugin_enabled":
            return _project_set_plugin_enabled(params)
        "editor.search_settings":
            return _editor_search_settings(params)
        "editor.get_setting":
            return _editor_get_setting(params)
        "editor.set_setting":
            return _editor_set_setting(params)
        "editor.get_class_icons":
            return _editor_class_icons(params)
        "scene.list":
            return _scene_list()
        "scene.open":
            return _scene_open(params)
        "scene.create":
            return _scene_create(params)
        "scene.save":
            return _scene_save(params)
        "scene.save_as":
            return _scene_save_as(params)
        "scene.reload":
            return _scene_reload(params)
        "scene.get_tree":
            return _scene_tree()
        "node.create":
            return _node_create(params)
        "node.create_nodes":
            return _node_create_nodes(params)
        "node.instantiate":
            return _node_instantiate(params)
        "node.duplicate":
            return _node_duplicate(params)
        "node.rename":
            return _node_rename(params)
        "node.reparent":
            return _node_reparent(params)
        "node.delete":
            return _node_delete(params)
        "node.set_property":
            return _node_set_property(params)
        "node.set_properties":
            return _node_set_properties(params)
        "node.add_to_group":
            return _node_add_to_group(params)
        "node.remove_from_group":
            return _node_remove_from_group(params)
        "node.connect_signal":
            return _node_connect_signal(params)
        "node.disconnect_signal":
            return _node_disconnect_signal(params)
        "node.set_cells":
            return _node_set_cells(params)
        "node.get_cells":
            return _node_get_cells(params)
        "node.inspect":
            return _node_inspect(params)
        "resource.rescan":
            return _resource_rescan(params)
        "resource.create_tileset":
            return _resource_create_tileset(params)
        "resource.create_shape":
            return _resource_create_shape(params)
        "resource.describe_tileset":
            return _resource_describe_tileset(params)
        "session.heartbeat":
            return _session_heartbeat()
    return _unknown_command_error(command)
# GENERATED-END dispatch-table

## Answers nothing, on purpose: a heartbeat is a request that proves the pipe is open both ways.
func _session_heartbeat() -> Dictionary:
    return {}

func _check_mutation_prerequisites(expected_revision: Variant) -> Dictionary:
    if _readiness != "ready":
        return {
            "_gofer_error": {
                "code": "not_ready",
                "message": "The session is %s and cannot mutate the scene" % _readiness,
                "retryable": true,
                "readiness": _readiness,
                "details": {}
            }
        }
    if _playing:
        return {
            "_gofer_error": {
                "code": "session_playing",
                "message": "The project is running and the scene cannot be mutated",
                "retryable": true,
                "readiness": "ready",
                "details": {}
            }
        }
    if expected_revision == null:
        return {
            "_gofer_error": {
                "code": "revision_conflict",
                "message": "This command changes the edited scene, so it needs expectedRevision. The scene is at revision %d now, and every read of it reports the revision it answered from." % _scene_revision,
                "retryable": true,
                "readiness": "ready",
                "details": {"currentRevision": _scene_revision}
            }
        }
    if int(expected_revision) != _scene_revision:
        return {
            "_gofer_error": {
                "code": "revision_conflict",
                "message": "The edited scene is at revision %d, not the %d this command expected: it changed after the read that answer came from — your own last mutation counts. Read the scene again and pass the revision that read reports; nothing was changed by this call." % [_scene_revision, int(expected_revision)],
                "retryable": true,
                "readiness": "ready",
                "details": {"expectedRevision": int(expected_revision), "currentRevision": _scene_revision}
            }
        }
    return {}

## Advances the edited-scene revision and reports the change. Undo and redo depths belong to the
## caller, because a mutation, an undo, and a redo each move them differently.
func _advance_revision() -> void:
    _scene_revision += 1
    _scene_dirty = true
    _send_event("scene.changed", {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_dirty})

func _bump_revision() -> void:
    _undo_depth += 1
    _redo_depth = 0
    _advance_revision()

## Godot keeps starting up for a while after a plugin's first frame: it imports the project on a
## background thread and, once that first scan lands, opens a scene for itself — the project's main
## scene, or the one a previous editor session left open. That open replaces whatever scene is
## being edited, without asking and without an event.
##
## A session told it was ready before that lands has its own scene swapped out from under it
## between two commands: `scene.create` opens the new scene, the editor's startup open takes the
## edited scene back, and the `node.create` that follows cannot resolve a root that is no longer
## the edited scene's. So readiness waits for the import to finish and for the scene the editor
## opens for itself to arrive.
func _editor_finished_starting() -> bool:
    var filesystem := EditorInterface.get_resource_filesystem()
    if filesystem.is_scanning():
        return false
    # A project whose main scene is unset, missing, or not a scene at all has no startup open to
    # wait for; the editor settles on an empty tab.
    #
    # The type is asked of the editor's own filesystem rather than of `ResourceLoader`. This used
    # to be `ResourceLoader.exists(main_scene)`, which is true for a `.gd` file — and a project
    # naming a script as its main scene is an everyday defect, the one the editor itself refuses
    # to play with "Selected scene ... is not a scene file". The session then waited for an open
    # that was never coming: `session.get_state` answered `importing` for as long as the editor
    # lived and every mutation was refused `not_ready`. `ResourceLoader.exists(path, "PackedScene")`
    # is no defence — verified on the pinned 4.7.1, it answers true for a script. `get_file_type`
    # is the one that answers "GDScript".
    var main_scene := str(ProjectSettings.get_setting("application/run/main_scene", ""))
    if main_scene.is_empty() or filesystem.get_file_type(main_scene) != "PackedScene":
        return true
    if _edited_root() != null:
        _startup_open_settled_frames = 0
        return true
    # A scene the editor cannot build never arrives either, and it is a scene by every question
    # that can be asked of it before it is loaded. Measured on the pinned 4.7.1, the editor opens
    # its startup scene on the very frame the first scan lands — even on a project padded with
    # four thousand resources — so a scene that is still missing frames later is not late.
    _startup_open_settled_frames += 1
    return _startup_open_settled_frames > STARTUP_OPEN_SETTLED_FRAMES

func _set_readiness(readiness: String) -> void:
    _readiness = readiness
    _send_event("session.%s" % readiness, {"readiness": readiness})

## Follows the scene the editor opens for itself.
##
## `_sweep_scene_pending` adopts the switches Gofer asked for. The editor performs others on its
## own: the scene it opens after its first import scan, and every scene a person opens in the
## editor window. Without this the session reports no open scene while one is being edited — the
## toolbar says so, `session.get_state` says so, and the debugger's launch, which plays the *edited*
## scene, starts a game with nothing in it. Every panel that refetches on `scene.changed` would
## likewise keep showing whatever it read before the editor had opened anything.
func _track_edited_scene() -> void:
    # A switch Gofer asked for is still in flight; the sweep owns the adoption and the answer.
    if not _scene_pending.is_empty():
        return
    var root := _edited_root()
    var path := "" if root == null else root.scene_file_path
    if path == _current_scene_path:
        return
    # A different scene is a different revision baseline, exactly as a Gofer-driven switch is.
    _current_scene_path = path
    _scene_revision = 0
    _scene_dirty = false
    _undo_depth = 0
    _redo_depth = 0
    _send_event("scene.changed", {
        "scene": _current_scene_path,
        "revision": _scene_revision,
        "dirty": _scene_dirty
    })

## Godot raises no signal when the project starts or stops running, so the plugin polls the editor
## and reports the transition. Gofer maps these events onto its own session lifecycle.
func _track_play_state() -> void:
    var playing := EditorInterface.is_playing_scene()
    # The session's stopped signal is the primary teardown path; this play-state poll is the
    # fallback for a game that died without one (a crash or a kill), which would otherwise leave
    # readiness stuck on a helper that no longer exists.
    if _runtime_ready and not playing:
        _on_runtime_debugger_session_stopped(_runtime_session_id)
    if playing == _playing:
        return
    _playing = playing
    if playing:
        _send_event("session.playing", {"readiness": _readiness})
    else:
        _send_event("session.ready", {"readiness": _readiness})

## Announces a dialog opening, changing, or being answered.
##
## Godot raises no signal for this either, so it is polled like the play state. Without the event
## the only way to learn that the editor is waiting on a person is to ask — and a dialog a person
## opened by hand would then sit unnoticed until something else happened to fail.
## Compared as text rather than as dictionaries: `==` on a Dictionary holding an Array is not a
## comparison of what they contain, so two identical reports of the same dialog would count as a
## change and announce one event per frame.
func _track_dialog() -> void:
    var asking: Variant = _editor_dialog()
    var reported := "" if asking == null else JSON.stringify(asking)
    if reported == _reported_dialog:
        return
    _reported_dialog = reported
    _send_event("session.dialog", {"dialog": asking})

## Routes one `runtime.*` request. Some commands the editor answers immediately; the rest are
## deferred — the response leaves when the game answers, the launch completes, or the deadline
## `_sweep_runtime_pending` enforces expires.
func _handle_runtime_request(id: String, command: String, params: Dictionary) -> void:
    match command:
        "runtime.get_state":
            _respond_result(id, {
                "running": EditorInterface.is_playing_scene(),
                "runtimeReady": _runtime_ready,
                # A running game that answers nothing is worth saying out loud, because every
                # other field here describes it as healthy.
                "broke": _runtime_broke,
            })
        "runtime.run":
            _runtime_launch(id, false)
        "runtime.restart":
            _runtime_launch(id, true)
        "runtime.stop":
            _runtime_stop()
            # Answered from what the editor holds, not from a `false` this used to assert. The
            # literal was right every time it was hunted — `stop_playing_scene` kills the game on
            # the calling frame, even one spinning its main thread with the debugger unable to
            # reach it — but it was the one answer here nothing checked, and every bug found at
            # this boundary has been an answer describing work the editor had not done yet. A
            # game that does outlive the request parks like every other deferred answer.
            if EditorInterface.is_playing_scene():
                _runtime_pending.append({"id": id, "kind": "stop", "deadline": _runtime_deadline(RUNTIME_LAUNCH_TIMEOUT_MS)})
            else:
                _respond_result(id, {"running": false})
        "runtime.capture":
            var source := str(params.get("source", "game"))
            if source == "editor":
                var frame := _editor_frame()
                if frame.has("_gofer_error"):
                    _respond_error_dict(id, frame["_gofer_error"])
                else:
                    _respond_result(id, frame)
            elif source == "game":
                _runtime_forward(id, "capture", params)
            else:
                _respond_error(id, "unsupported_value", "A capture source must be 'game' or 'editor'", false)
        "runtime.get_tree":
            _runtime_forward(id, "tree", params)
        "runtime.inspect_node":
            _runtime_forward(id, "inspect", params)
        "runtime.input":
            _runtime_forward(id, "input", params)
        "runtime.get_monitors":
            _runtime_forward(id, "monitors", params)
        _:
            # `RUNTIME_COMMANDS` and this match are two lists of the same commands. A command in
            # one and not the other would leave its caller waiting out the whole timeout for a
            # response that is never coming, so the mismatch answers instead of hanging.
            _respond_error_dict(id, _unknown_command_error(command)["_gofer_error"])

## Stops the game. The helper it carried is gone from this moment on, so readiness drops here
## rather than when the debugger session finally tears down: the next game's announcement has to
## read as a first one. Launches waiting on the stopped game are answered rather than left to
## expire.
func _runtime_stop() -> void:
    if EditorInterface.is_playing_scene():
        EditorInterface.stop_playing_scene()
    _runtime_ready = false
    _runtime_broke = false
    _fail_pending(["run", "restart", "run_frame"], "runtime_not_running", "The game was stopped before it finished launching")

## Starts (or restarts) the game. The response waits for the GoferRuntime autoload to announce
## itself, then rides back with the first rendered frame attached — the launch is only proven once
## the game has produced pixels.
func _runtime_launch(id: String, restart: bool) -> void:
    var playing := EditorInterface.is_playing_scene()
    if playing and not restart:
        _respond_error(id, "already_running", "The project is already running; stop it or use runtime.restart", true)
        return
    if playing:
        # Stopping is asynchronous; the sweep starts the new instance once the old one is gone.
        _runtime_stop()
        _runtime_pending.append({"id": id, "kind": "restart", "deadline": _runtime_deadline(RUNTIME_LAUNCH_TIMEOUT_MS)})
        return
    # An editor already asking a question will not start a game, and pressing Play again only adds
    # a second dialog on top of the first.
    var asking: Variant = _editor_dialog()
    if asking != null:
        _respond_dialog_open(id, asking)
        return
    EditorInterface.play_main_scene()
    _runtime_pending.append(_launch_pending(id, "run"))

## Answers a request the editor turned into a question for a person.
##
## Not retryable: the same request asks the same question again, and the dialog it opens has to be
## answered in the editor before anything else can happen. The text is in the message because that
## is what tells the caller what to fix — every code on its own reads as "try later".
func _respond_dialog_open(id: String, dialog: Dictionary) -> void:
    _respond_error(
        id,
        "editor_dialog_open",
        "The editor is waiting for an answer to '%s': %s (choices: %s)" % [
            dialog["title"], dialog["text"], ", ".join(dialog["buttons"])
        ],
        false,
        {"dialog": dialog}
    )

## A launch entry. `seen_playing` is what lets the sweep tell a game still booting from a game that
## booted and died: both read `is_playing_scene() == false`, and only the second one is over.
func _launch_pending(id: String, kind: String) -> Dictionary:
    return {
        "id": id,
        "kind": kind,
        "deadline": _runtime_deadline(RUNTIME_LAUNCH_TIMEOUT_MS),
        "seen_playing": false,
    }

## Forwards a request to the running game. Without a live helper the request fails immediately —
## the caller can start the game and retry, so the error is retryable.
func _runtime_forward(id: String, op: String, params: Dictionary) -> void:
    if not _runtime_ready or _runtime_session_id < 0:
        _respond_error(id, "runtime_not_running", "No game with the Gofer runtime helper is running", true)
        return
    # A paused game reads the message and never runs the frame that would answer it.
    if _runtime_broke:
        _respond_error(id, "runtime_broke", "The game is paused at an error in the debugger and cannot answer; read the error in the session output, then fix it and run again", true)
        return
    _runtime_pending.append({"id": id, "kind": "game", "deadline": _runtime_deadline(RUNTIME_REQUEST_TIMEOUT_MS)})
    _send_runtime_message({"id": id, "op": op, "params": params})

func _runtime_deadline(budget_ms: int) -> int:
    return Time.get_ticks_msec() + budget_ms

func _send_runtime_message(payload: Dictionary) -> void:
    if _debugger_bridge == null or _runtime_session_id < 0:
        return
    var session := _debugger_bridge.get_session(_runtime_session_id)
    if session == null:
        return
    session.send_message("gofer:request", [payload])

## A new debugger session means a new game process: any readiness the previous helper reported
## belonged to it, so it is dropped, and the new helper is pinged in case its announcement raced
## the session setup.
func _on_runtime_debugger_session_started(session_id: int) -> void:
    if _runtime_session_id != session_id:
        _runtime_ready = false
    _runtime_session_id = session_id
    _runtime_broke = false
    _send_runtime_message({"id": "", "op": "ping", "params": {}})

## The debugger has paused the game. It is still running and it answers nothing, which is the one
## failure that looks exactly like a slow game: the process is alive, the editor still reports a
## playing scene, and nothing arrives.
##
## Only a launch still waiting for the helper is ended here. A break that arrives after the helper
## has announced belongs to a game that is up — a breakpoint Gofer's own debug adapter set, most of
## the time — and that game continues and goes on answering, so failing its requests would break
## debugging to fix launching. A break *before* the announcement is the boot that will never
## finish: the scene stopped at its error, and the helper it would have loaded never runs.
func _on_runtime_debugger_session_breaked(session_id: int) -> void:
    if session_id != _runtime_session_id:
        return
    _runtime_broke = true
    _fail_pending(
        ["run"],
        "runtime_broke",
        "The game stopped at an error while starting and is paused in the debugger; read the error in the session output, fix it, and run again",
    )

func _on_runtime_debugger_session_stopped(session_id: int) -> void:
    if session_id != _runtime_session_id:
        return
    _runtime_session_id = -1
    _runtime_ready = false
    _runtime_broke = false
    # Forwarded queries died with the game, and so did the first-frame capture chained onto a
    # launch: `run_frame` only exists because *this* session's helper announced itself. A `run` is
    # kept, because it may already belong to the instance replacing this one — the sweep ends that
    # one by watching the editor's play state instead. A `restart` is waiting for exactly this
    # teardown.
    _fail_pending(["game", "run_frame"], "runtime_not_running", "The game stopped before it could answer")
    _send_event("runtime.stopped", {})

## Answers and drops every pending entry of the named kinds; the rest stay waiting. Every caller
## here is retryable: the game is gone or paused, and the caller can start one and ask again.
func _fail_pending(kinds: Array, code: String, message: String) -> void:
    var kept: Array[Dictionary] = []
    for pending in _runtime_pending:
        if kinds.has(pending["kind"]):
            _respond_error(pending["id"], code, message, true)
        else:
            kept.append(pending)
    _runtime_pending = kept

func _on_runtime_debugger_message(message: String, data: Array, session_id: int) -> void:
    if data.is_empty() or typeof(data[0]) != TYPE_DICTIONARY:
        return
    # The game spoke, so it is not sitting at a break: this is the only clearing of that state the
    # game itself pays for, and the only one no signal can be missing.
    _runtime_broke = false
    var payload: Dictionary = data[0]
    if message == "gofer:ready":
        var first := not _runtime_ready
        _runtime_session_id = session_id
        _runtime_ready = true
        if first:
            _send_event("runtime.ready", {"protocolVersion": payload.get("protocolVersion", 0)})
        _complete_pending_run()
    elif message == "gofer:response":
        _complete_runtime_response(payload)

## A launch is answered once the helper is up, with the game's first rendered frame chained on.
## The frame is best-effort: a game that cannot produce one still counts as launched.
func _complete_pending_run() -> void:
    for index in range(_runtime_pending.size()):
        var pending := _runtime_pending[index]
        if pending["kind"] != "run":
            continue
        _runtime_pending.remove_at(index)
        _runtime_pending.append({
            "id": pending["id"],
            "kind": "run_frame",
            "deadline": _runtime_deadline(RUNTIME_REQUEST_TIMEOUT_MS),
            # The helper just spoke from inside the game, so this one has certainly played.
            "seen_playing": true,
        })
        _send_runtime_message({"id": pending["id"], "op": "capture", "params": {}})
        return

func _complete_runtime_response(payload: Dictionary) -> void:
    var id := str(payload.get("id", ""))
    for index in range(_runtime_pending.size()):
        var pending := _runtime_pending[index]
        if str(pending["id"]) != id:
            continue
        _runtime_pending.remove_at(index)
        if pending["kind"] == "run_frame":
            var launch := {"running": true}
            if payload.get("ok", false) and payload.has("frame"):
                launch["frame"] = payload["frame"]
            _respond_result(id, launch)
            return
        if payload.get("ok", false):
            var result := payload.duplicate()
            result.erase("id")
            result.erase("ok")
            _respond_result(id, result)
        else:
            _respond_error(
                id,
                str(payload.get("code", "runtime_failed")),
                str(payload.get("message", "The runtime helper refused the request")),
                false
            )
        return

## Moves the launch state machine and fails whatever outlived its deadline. This runs even while
## the RPC link is down: a restart must still start the new game once the old one has stopped.
##
## A launch also ends when the game it started dies. A game that cannot boot — a main scene whose
## script does not parse is the everyday one — runs for a moment and exits, and the helper that
## would have answered never loads. Nothing used to notice: the launch sat here on its deadline
## alone and then answered `runtime_timeout`, "The game did not answer in time", about a game that
## had been gone for half a minute. That reads as a slow machine, so the agent waits, and the
## parse error that caused it is never mentioned.
func _sweep_runtime_pending() -> void:
    if _runtime_pending.is_empty():
        return
    var now := Time.get_ticks_msec()
    var playing := EditorInterface.is_playing_scene()
    var kept: Array[Dictionary] = []
    # Asked once for the whole sweep: walking the editor's windows is not free, and every pending
    # launch is waiting on the same editor.
    var asking: Variant = null if playing else _editor_dialog()
    for pending in _runtime_pending:
        var launching: bool = LAUNCH_KINDS.has(pending["kind"])
        if launching and playing:
            pending["seen_playing"] = true
        if launching and asking != null and not pending.get("seen_playing", false):
            # `play_main_scene()` does not always start a game. A main scene that is not a scene,
            # or one the editor cannot build, turns the launch into a dialog and the editor then
            # waits for a person — while this list waited for a game, and answered `runtime_timeout`
            # about one that was never started.
            _respond_dialog_open(pending["id"], asking)
        elif int(pending["deadline"]) < now:
            _respond_error(pending["id"], "runtime_timeout", "The game did not answer in time", true)
        elif launching and not playing and pending.get("seen_playing", false):
            _respond_error(pending["id"], "runtime_not_running", "The game started and then stopped before it was ready; check the editor output for the error that ended it", true)
        elif pending["kind"] == "stop" and not playing:
            _respond_result(pending["id"], {"running": false})
        elif pending["kind"] == "restart" and not playing:
            EditorInterface.play_main_scene()
            pending["kind"] = "run"
            pending["seen_playing"] = false
            kept.append(pending)
        else:
            kept.append(pending)
    _runtime_pending = kept

## Captures the editor's own viewport, with the windows standing over it drawn back on. A headless
## editor has no pixels to read, which is an environment fact rather than a transient failure, so
## the error is not retryable.
func _editor_frame() -> Dictionary:
    if DisplayServer.get_name() == "headless":
        return Params.error("capture_unavailable", "The editor is headless and has no viewport to capture")
    var base := EditorInterface.get_base_control()
    if base == null or base.get_viewport() == null:
        return Params.error("capture_unavailable", "The editor viewport is not available")
    var image := base.get_viewport().get_texture().get_image()
    if image == null:
        return Params.error("capture_unavailable", "The editor viewport produced no image")
    return _png_frame(Protocol.compose_frame(image, _window_overlays()))

## The windows drawn over the editor, as images and where they sit in the editor's own pixels.
##
## Only the ones the editor did not draw itself. An embedded subwindow is painted into the main
## viewport, so it is already in the image; a native one — which is what the editor opens on a
## desktop that has real windows, verified on the pinned 4.7.1 — is a viewport of its own that the
## main texture knows nothing about.
##
## A window the editor put somewhere else entirely is dropped by the composite, and that is not a
## defect this can fix: measured on a three-monitor desktop, the engine centred the "not a scene
## file" confirmation on a screen the editor window was not on. Pixels cannot show what is not
## there — which is why `session.get_state` reports the dialog in words as well.
func _window_overlays() -> Array:
    var base := EditorInterface.get_base_control()
    var main := base.get_window()
    var overlays: Array = []
    for window in _visible_windows():
        if window.is_embedded() or window.get_texture() == null:
            continue
        var image := window.get_texture().get_image()
        if image == null:
            continue
        # Both positions are the desktop's, so the difference is where the window lands on the
        # editor. A window off the edge of the editor is clipped by the composite.
        overlays.append({"image": image, "offset": window.position - main.position})
    return overlays

## Every window standing over the editor, innermost last, so a dialog opened by a dialog is
## reported and drawn after the one that opened it.
##
## Asked of the two things that already know, rather than of the tree. A window is either embedded
## in a viewport, which the viewport lists, or it is a native window, which the display server
## lists and can name the node of. Walking the editor's own tree for them finds exactly the same
## windows and costs 13 milliseconds a call across its 21,000 nodes — measured on the pinned 4.7.1
## against 6 microseconds for this — and both a launch sweep and every `session.get_state` ask.
func _visible_windows() -> Array[Window]:
    var base := EditorInterface.get_base_control()
    if base == null or base.get_tree() == null:
        return []
    var found: Array[Window] = []
    _embedded_windows(base.get_tree().get_root(), found)
    for id in DisplayServer.get_window_list():
        if id == DisplayServer.MAIN_WINDOW_ID:
            continue
        var instance: Object = instance_from_id(DisplayServer.window_get_attached_instance_id(id))
        if instance is Window and (instance as Window).visible:
            found.append(instance as Window)
            _embedded_windows(instance as Window, found)
    return found

## The windows a viewport draws inside itself, and the ones they draw inside themselves.
func _embedded_windows(viewport: Viewport, found: Array[Window]) -> void:
    for window in viewport.get_embedded_subwindows():
        if window.visible:
            found.append(window)
            _embedded_windows(window, found)

## The question the editor is waiting on, or null when it is waiting on nothing.
##
## Only an `AcceptDialog` counts. It is the engine's class for "a person has to answer this", and
## it is the one that carries the text and the buttons — a progress popup, a tooltip and a floating
## dock are all windows too, and none of them is anybody's turn to act. The last one wins: a dialog
## opened over a dialog is the one being asked.
func _editor_dialog() -> Variant:
    var asking := _topmost_dialog()
    if asking == null:
        return null
    var labels: Array[String] = []
    for button in _dialog_button_nodes(asking):
        labels.append(button.text)
    return {
        "title": asking.title,
        "text": asking.dialog_text,
        # Read off the dialog rather than from `get_ok_button()` and `get_cancel_button()`: the
        # choices that matter are usually neither. The editor's "not a scene file" confirmation
        # offers Cancel, Select and Select Current, and only the first two have an accessor.
        "buttons": labels,
    }

## The dialog being asked, or null. The last visible one wins: a dialog opened over a dialog is the
## one waiting on an answer.
func _topmost_dialog() -> AcceptDialog:
    var asking: AcceptDialog = null
    for window in _visible_windows():
        if window is AcceptDialog:
            asking = window as AcceptDialog
    return asking

## A dialog's own buttons, in the order they are drawn.
func _dialog_button_nodes(node: Node) -> Array[Button]:
    var buttons: Array[Button] = []
    for child in node.get_children(true):
        # A dialog can own another window; its buttons belong to it, not to this one.
        if child is Window:
            continue
        if child is Button and (child as Button).visible:
            buttons.append(child as Button)
        buttons.append_array(_dialog_button_nodes(child))
    return buttons

## Wraps the shared frame encoder in the editor half's error convention.
func _png_frame(image: Image) -> Dictionary:
    var encoded := Protocol.encode_frame(image)
    if not encoded["ok"]:
        return Params.error(str(encoded["code"]), str(encoded["message"]))
    return {"frame": encoded["frame"]}

func _unknown_command_error(command: String) -> Dictionary:
    return {
        "_gofer_error": {
            "code": "unknown_command",
            "message": "Command '%s' is not implemented" % command,
            "retryable": false,
            "readiness": "ready",
            "details": {}
        }
    }

func _session_state() -> Dictionary:
    return {
        "state": _readiness,
        "scene": _current_scene_path,
        "revision": _scene_revision,
        "dirty": _scene_dirty,
        "canUndo": _undo_depth > 0,
        "canRedo": _redo_depth > 0,
        # An editor waiting on a person is not something any other field can say. It is not a
        # readiness — commands are answered normally while a dialog is up — and on a real desktop
        # it is not in a screenshot either, because the dialog is a native window of its own.
        # Without this the whole session looked healthy while nothing a person did not click could
        # move: the launch that opened the dialog answered `runtime_timeout` half a minute later,
        # and asking again stacked one more modal on the editor.
        "dialog": _editor_dialog(),
    }

## Asks the editor to close itself, which is the only way its machine-wide settings reach disk.
##
## Answers before it acts: the quit takes the socket with it, and a caller that lost its answer
## cannot tell an orderly shutdown from a crashed editor.
func _session_quit() -> Dictionary:
    _quit_countdown = 2
    return {"quitting": true}

## The scenes the editor is holding changes to that are not on disk.
##
## The editor's own answer, not Gofer's. `_scene_dirty` counts the mutations Gofer made, so a scene
## a person painted a tilemap onto is clean by it, and every path that stops the editor — a task
## switch, a merge — threw that work away without a word.
func _session_unsaved_scenes() -> Dictionary:
    return {"scenes": Array(EditorInterface.get_unsaved_scenes())}

## Writes every open scene the editor is holding changes to, and answers with what it wrote.
##
## `save_all_scenes` returns nothing, so what actually landed is read back out of the editor rather
## than assumed: a scene still unsaved afterwards is the one case a caller about to move the
## checkout must not be told went fine.
func _session_save_all_scenes() -> Dictionary:
    var before := Array(EditorInterface.get_unsaved_scenes())
    EditorInterface.save_all_scenes()
    var left := Array(EditorInterface.get_unsaved_scenes())
    if not left.is_empty():
        return Params.error(
            "scene_save_failed",
            "The editor still holds unsaved changes to %s after saving every open scene."
            % ", ".join(PackedStringArray(left)),
            {"scenes": left}
        )
    _scene_dirty = false
    return {"saved": before}

## Presses a button on the dialog the editor is waiting on, exactly as a person would.
##
## Reporting a dialog without this leaves the session watching a door it cannot open: the editor
## will not run the game, the agent knows why, and the only cure is a person at that keyboard. The
## button is named rather than indexed because the names are what the report carries and what the
## user reads, and pressing the wrong one is not undoable — "Select Current" makes the open scene
## the project's main scene.
func _session_answer_dialog(params: Dictionary) -> Dictionary:
    var wanted := str(params.get("button", ""))
    if wanted.is_empty():
        return Params.error("invalid_params", "session.answer_dialog requires button")
    var asking: Variant = _editor_dialog()
    if asking == null:
        return Params.error("no_dialog_open", "The editor is not waiting on any dialog")
    var dialog := _topmost_dialog()
    for button in _dialog_button_nodes(dialog):
        if button.text != wanted:
            continue
        # The dialog connects its own handlers to each button's `pressed` signal, so emitting it is
        # the same answer a click gives — verified against the pinned 4.7.1's "not a scene file"
        # confirmation, which closes on it.
        button.emit_signal("pressed")
        return {"answered": wanted, "dialog": asking}
    return Params.error(
        "unknown_button",
        "The dialog has no button named '%s'; it offers %s" % [wanted, ", ".join(asking["buttons"])],
        {"dialog": asking}
    )

## Gives up on a request that is still parked, and answers it.
##
## Two kinds of request outlive the frame they arrived on: a scene switch waiting for the editor to
## obey, and a runtime call waiting for the game to reply. Both are answered by a deadline sweep, so
## a caller that has already walked away — the user pressed Stop — leaves the addon holding them for
## up to half a minute. A parked scene switch is the one that hurts: it holds readiness at
## `importing`, and every mutation is refused `not_ready` while it does, so stopping a turn stalled
## the whole session including whatever the user did next by hand.
func _session_cancel(params: Dictionary) -> Dictionary:
    var request_id: String = params.get("requestId", "")
    if request_id.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "session.cancel requires requestId",
                "retryable": false,
                "readiness": _readiness,
                "details": {}
            }
        }

    var cancelled := false
    var kept_scenes: Array[Dictionary] = []
    for pending in _scene_pending:
        if String(pending["id"]) == request_id:
            cancelled = true
            _respond_error(request_id, "cancelled", "The request was cancelled by its caller", false)
        else:
            kept_scenes.append(pending)
    _scene_pending = kept_scenes
    # Readiness belonged to the switch, so it is given back with it — but only once none is left.
    if cancelled and _scene_pending.is_empty():
        _set_readiness("ready")

    var kept_runtime: Array[Dictionary] = []
    for pending in _runtime_pending:
        if String(pending["id"]) == request_id:
            cancelled = true
            _respond_error(request_id, "cancelled", "The request was cancelled by its caller", false)
        else:
            kept_runtime.append(pending)
    _runtime_pending = kept_runtime

    # A request that already answered is not an error: the caller gave up and the reply crossed it.
    return {"requestId": request_id, "cancelled": cancelled}

func _undo() -> Dictionary:
    if _undo_depth <= 0:
        return _history_error("undo_unavailable", "Nothing to undo")
    var history := _scene_history()
    if history == null:
        return _history_error("undo_unavailable", "The editor refused to undo the last action")
    var before := history.get_version()
    if not history.undo():
        return _history_error("undo_unavailable", "The editor refused to undo the last action")
    # Read-back: the history's own version, which only moves when a step was really taken.
    if history.get_version() == before:
        return _readback_error(
            "session.undo", "a step back through the history", "version %d, unmoved" % before
        )
    _undo_depth -= 1
    _redo_depth += 1
    _after_history_step()
    return {"undoDepth": _undo_depth, "redoDepth": _redo_depth}

func _redo() -> Dictionary:
    if _redo_depth <= 0:
        return _history_error("redo_unavailable", "Nothing to redo")
    var history := _scene_history()
    if history == null:
        return _history_error("redo_unavailable", "The editor refused to redo the next action")
    var before := history.get_version()
    if not history.redo():
        return _history_error("redo_unavailable", "The editor refused to redo the next action")
    # Read-back: the same version, forward. `redo()` answers true for a list it walked without doing.
    if history.get_version() == before:
        return _readback_error(
            "session.redo", "a step forward through the history", "version %d, unmoved" % before
        )
    _undo_depth += 1
    _redo_depth -= 1
    _after_history_step()
    return {"undoDepth": _undo_depth, "redoDepth": _redo_depth}

## Settles the editor after the scene history moved under it.
##
## `EditorUndoRedoManager` tracks a saved version per history and derives the scene's unsaved marker
## by counting actions from it. Stepping the underlying `UndoRedo` directly leaves that count
## pointing past the end of the manager's own action list, so the marker is set explicitly instead:
## a scene that just moved through its history is unsaved either way.
func _after_history_step() -> void:
    EditorInterface.mark_scene_as_unsaved()
    _advance_revision()

func _history_error(code: String, message: String) -> Dictionary:
    return {
        "_gofer_error": {
            "code": code,
            "message": message,
            "retryable": false,
            "readiness": "ready",
            "details": {"undoDepth": _undo_depth, "redoDepth": _redo_depth}
        }
    }

## Returns the undo history the edited scene records into.
##
## `EditorUndoRedoManager` routes each action to a per-scene history and keeps its own `undo` and
## `redo` unbound from scripting, so stepping happens on the underlying `UndoRedo`. Actions are
## pinned to the edited scene through `create_action`'s custom context (see `_begin_action`), so the
## same context resolves the history to step through here.
func _scene_history() -> UndoRedo:
    var root := _edited_root()
    if root == null:
        return null
    var manager := get_undo_redo()
    var history_id := manager.get_object_history_id(root)
    if history_id == EditorUndoRedoManager.INVALID_HISTORY:
        return null
    return manager.get_history_undo_redo(history_id)

## Opens an undoable action pinned to the edited scene's history.
##
## The do/undo callables live on this plugin rather than on scene nodes, which would otherwise route
## the action into the global history and leave `_scene_history` stepping through an empty one.
func _begin_action(name: String) -> EditorUndoRedoManager:
    var manager := get_undo_redo()
    manager.create_action(name, UndoRedo.MERGE_DISABLE, _edited_root(), false)
    manager.force_fixed_history()
    return manager

func _project_settings() -> Dictionary:
    return {
        "projectName": ProjectSettings.get_setting_with_override("application/config/name"),
        "mainScene": ProjectSettings.get_setting_with_override("application/run/main_scene"),
        "renderingMethod": ProjectSettings.get_setting_with_override("rendering/renderer/rendering_method")
    }

## Builds a structured configuration error. Configuration commands never touch the scene, so their
## readiness is always ready and their failures are never retryable.
## Holds one request to the parameters its command declares, for the commands that declare any.
##
## A command with no entry in `COMMAND_PARAMS` is not checked here — absence is "not declared yet",
## never "takes nothing" — so adding a command cannot silently start refusing its own parameters.
##
## Names only. What a value has to *be* stays with the handler and with `Protocol.decode`, which is
## where the engine's own answer lives; this catches the request that named something no handler
## reads, which used to reach a handler and be quietly ignored.
func _check_declared_params(command: String, params: Dictionary) -> Dictionary:
    if not COMMAND_PARAMS.has(command):
        return {}
    var declared: Dictionary = COMMAND_PARAMS[command]
    var required: Array = declared["required"]
    var accepted: Array = required + (declared["optional"] as Array)
    for key in params:
        if not accepted.has(key):
            return Params.error(
                "unknown_param",
                "%s has no `%s` parameter. It takes %s." % [command, key, ", ".join(accepted)],
                {"param": key, "takes": accepted}
            )
    for name in required:
        if not params.has(name):
            return Params.error(
                "missing_param",
                "%s requires `%s`. It takes %s." % [command, name, ", ".join(accepted)],
                {"param": name, "takes": accepted}
            )
    return {}


## Persists project.godot after a configuration change. Returns an error dictionary on failure and
## an empty one on success, matching the `_gofer_error` convention.
func _save_project_or_error() -> Dictionary:
    var error := ProjectSettings.save()
    if error != OK:
        return Params.error("project_save_failed", "Could not save project.godot (error %d)" % error)
    return {}

## The error a mutating command answers when Godot does not hold what the command just wrote.
##
## Every mutating command ends by asking Godot for the thing it named — the setting, the node, the
## file — and reports that answer rather than the value it still holds in a local variable. A write
## the engine took and dropped is otherwise indistinguishable from one that worked: `saved: true`
## came back for a setting Godot never had, and a node reported created was one the scene did not
## keep. Both values are named here, because knowing only that they differ is not actionable.
func _readback_error(
    what: String, wanted: Variant, found: Variant, details: Dictionary = {}
) -> Dictionary:
    var described := details.duplicate()
    described["wanted"] = str(wanted)
    described["found"] = str(found)
    return Params.error(
        "readback_mismatch",
        "%s: the write asked for %s and Godot holds %s" % [what, str(wanted), str(found)],
        described
    )

## Whether a value read back out of Godot is the value that was written into it.
##
## Three things make an exact comparison wrong here, and none of them is a failed write. A property
## the engine declares as a float stores 32 bits, so a double that goes in comes back a few bits
## away from itself, and the types built out of floats carry the same drift. A number written as 5
## and stored as a float reads back as 5.0. And a property that holds no object is not `TYPE_NIL` —
## it is a `TYPE_OBJECT` variant with a null pointer, so clearing one reads back as a different type
## than the null that cleared it.
func _same_value(wanted: Variant, found: Variant) -> bool:
    var left: Variant = null if _is_null_object(wanted) else wanted
    var right: Variant = null if _is_null_object(found) else found
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
func _is_null_object(value: Variant) -> bool:
    return typeof(value) == TYPE_OBJECT and not is_instance_valid(value)

## The nodes a save writes: the scene root and every node it owns, by the path the file records.
##
## A node the root does not own is not saved at all, so this is also the list a caller's work has to
## appear in for it to have happened.
func _owned_paths(root: Node) -> Array[String]:
    var paths: Array[String] = ["."]
    for node in root.find_children("*", "", true, false):
        if node.owner == root:
            paths.append(String(root.get_path_to(node)))
    paths.sort()
    return paths

## Checks that the file at `path` really holds the tree the editor is editing.
##
## `EditorInterface.save_scene` answers OK for a save that wrote nothing, and the reply that follows
## says `dirty: false` about a file on disk that is minutes old. The saved scene is therefore loaded
## back from disk — cache ignored, or the load answers with the PackedScene the editor already holds
## — and compared node for node against the nodes a save is supposed to write.
func _saved_scene_holds(path: String, root: Node) -> Dictionary:
    var written := ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
    if written == null or not (written is PackedScene):
        return Params.error(
            "scene_save_failed",
            "%s was reported saved but does not load back as a scene" % path,
            {"path": path}
        )
    var state := (written as PackedScene).get_state()
    var stored: Array[String] = []
    for index in range(state.get_node_count()):
        # A SceneState writes a child as `./Body` where `get_path_to` answers `Body`; the root is
        # `.` on both sides.
        stored.append(String(state.get_node_path(index)).trim_prefix("./"))
    stored.sort()
    var editing := _owned_paths(root)
    if stored != editing:
        return _readback_error(
            "the scene saved to %s" % path,
            ", ".join(editing),
            ", ".join(stored),
            {"path": path}
        )
    return {}

## A setting under autoload/, input/, or editor_plugins/ has its own typed command that enforces
## the structure of its value; routing the write through it keeps malformed entries out of
## project.godot. Returns the command to use, or an empty string for ordinary settings.
func _reserved_setting_command(name: String) -> String:
    if name.begins_with("autoload/"):
        return "project.set_autoload"
    if name.begins_with("input/"):
        return "project.set_input_action"
    if name.begins_with("editor_plugins/"):
        return "project.set_plugin_enabled"
    return ""

## Whether the editor asks for a restart after this setting changes. Custom settings carry no
## property info and are therefore never restart-required.
func _restart_required(name: String) -> bool:
    for info in ProjectSettings.get_property_list():
        if str(info.get("name", "")) == name:
            return (int(info.get("usage", 0)) & PROPERTY_USAGE_RESTART_IF_CHANGED) != 0
    return false

## The Variant type the engine declared a setting with, or `TYPE_NIL` when nothing declared it.
##
## Only a declared setting has a default to revert to; a setting the project or Gofer invented
## reverts to null, which is how the two are told apart. Writing a value of the wrong type into a
## declared setting is what puts `config/name=5` in project.godot, so the write path refuses it.
func _declared_setting_type(name: String) -> int:
    if not ProjectSettings.property_can_revert(name):
        return TYPE_NIL
    return typeof(ProjectSettings.property_get_revert(name))

func _project_search_settings(params: Dictionary) -> Dictionary:
    var query := str(params.get("query", "")).to_lower()
    var matches: Array = []
    var total := 0
    for info in ProjectSettings.get_property_list():
        var name := str(info.get("name", ""))
        # The property list opens with a category header that is not a setting at all.
        if name.is_empty() or not ProjectSettings.has_setting(name):
            continue
        if not query.is_empty() and not name.to_lower().contains(query):
            continue
        total += 1
        if matches.size() < MAX_SEARCH_RESULTS:
            matches.append(
                {
                    "name": name,
                    "value": Protocol.encode(ProjectSettings.get_setting(name)),
                    "restartRequired": (int(info.get("usage", 0)) & PROPERTY_USAGE_RESTART_IF_CHANGED) != 0
                }
            )
    return {"settings": matches, "totalMatches": total, "truncated": total > matches.size()}

func _project_get_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.get_setting requires name")
    if not ProjectSettings.has_setting(name):
        return Params.error(
            "setting_not_found", "Project setting '%s' does not exist" % name, {"name": name}
        )
    return {
        "name": name,
        "value": Protocol.encode(ProjectSettings.get_setting(name)),
        "restartRequired": _restart_required(name)
    }

func _project_set_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or not params.has("value"):
        return Params.error("invalid_params", "project.set_setting requires name and value")
    var typed := _reserved_setting_command(name)
    if not typed.is_empty():
        return Params.error(
            "reserved_setting",
            "'%s' has a typed command; use %s instead" % [name, typed],
            {"name": name, "command": typed}
        )
    var decoded := Protocol.decode(params["value"])
    if not decoded["ok"]:
        return Params.error("unsupported_value", decoded["message"], {"name": name})
    var declared := _declared_setting_type(name)
    var fitted := Protocol.fit_to_declared_type(decoded["value"], declared)
    if not fitted["ok"]:
        return Params.error(
            "type_mismatch",
            "Project setting '%s': %s" % [name, fitted["message"]],
            {"name": name, "expected": type_string(declared)}
        )
    var existed := ProjectSettings.has_setting(name)
    if not existed:
        var meant := _setting_meant(name)
        if not meant.is_empty():
            return Params.error(
                "setting_not_found",
                "There is no project setting '%s'. Did you mean '%s'?" % [name, meant],
                {"name": name, "didYouMean": meant}
            )
    ProjectSettings.set_setting(name, fitted["value"])
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: the setting as ProjectSettings answers it now. A write the engine declined leaves
    # `get_setting` on the value it always had, or on null for a name it never took.
    var stored: Variant = ProjectSettings.get_setting(name)
    if not _same_value(fitted["value"], stored):
        return _readback_error("project.set_setting %s" % name, fitted["value"], stored, {"name": name})
    # `created` is the difference between changing the project and inventing a corner of it. A
    # caller that misspells a built-in setting otherwise gets `saved: true` for a setting nothing
    # reads, and can even read its own value back — which is what a mistyped
    # `application.run.main_scene` did: the project kept running the scene it always had.
    return {
        "name": name,
        "saved": true,
        "created": not existed,
        "restartRequired": _restart_required(name)
    }

## The setting a name was probably meant to be, or "" when there is nothing close.
##
## Godot names its settings `section/key`, and a caller that writes them with dots gets a brand-new
## custom setting instead of the built-in one — accepted, saved, and read back, while the setting
## that governs anything stays untouched. Custom settings are legitimate, so an unknown name is not
## refused on its own; it is refused only when swapping the separator finds a real one.
func _setting_meant(name: String) -> String:
    if not name.contains("."):
        return ""
    var candidate := name.replace(".", "/")
    return candidate if ProjectSettings.has_setting(candidate) else ""

## Restores a setting's default when it has one and removes it otherwise. An autoload, input
## action, or plugin entry must go through its own removal command.
func _project_reset_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.reset_setting requires name")
    if not ProjectSettings.has_setting(name):
        return Params.error(
            "setting_not_found", "Project setting '%s' does not exist" % name, {"name": name}
        )
    var typed := _reserved_setting_command(name)
    if not typed.is_empty():
        return Params.error(
            "reserved_setting",
            "'%s' has a typed command; use %s instead" % [name, typed],
            {"name": name, "command": typed}
        )
    var wanted: Variant = null
    if ProjectSettings.property_can_revert(name):
        wanted = ProjectSettings.property_get_revert(name)
    ProjectSettings.set_setting(name, wanted)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: what the setting reads as now, which for a removal is nothing at all.
    var stored: Variant = ProjectSettings.get_setting(name)
    if not _same_value(wanted, stored):
        return _readback_error("project.reset_setting %s" % name, wanted, stored, {"name": name})
    return {"name": name, "exists": ProjectSettings.has_setting(name)}

func _project_list_autoloads() -> Dictionary:
    var autoloads: Array = []
    for info in ProjectSettings.get_property_list():
        var setting := str(info.get("name", ""))
        if not setting.begins_with("autoload/"):
            continue
        var raw := str(ProjectSettings.get_setting(setting))
        var enabled := raw.begins_with("*")
        autoloads.append(
            {
                "name": setting.trim_prefix("autoload/"),
                "path": raw.substr(1) if enabled else raw,
                "enabled": enabled,
                "goferManaged": setting == "autoload/" + GOFER_AUTOLOAD_NAME
            }
        )
    return {"autoloads": autoloads}

func _project_set_autoload(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    var path := str(params.get("path", ""))
    var enabled := bool(params.get("enabled", true))
    if name.is_empty() or path.is_empty():
        return Params.error("invalid_params", "project.set_autoload requires name and path")
    if not name.is_valid_identifier():
        return Params.error(
            "invalid_params", "Autoload name '%s' is not a valid identifier" % name, {"name": name}
        )
    if name == GOFER_AUTOLOAD_NAME:
        return Params.error(
            "gofer_managed",
            "The GoferRuntime autoload is managed by Gofer and cleaned up when the session stops"
        )
    if not path.begins_with("res://"):
        return Params.error(
            "invalid_params", "Autoload path '%s' must start with res://" % path, {"path": path}
        )
    # An autoload that points nowhere is only discovered on the next editor start, which then
    # fails to load the project the session depends on.
    if not FileAccess.file_exists(path):
        return Params.error(
            "autoload_path_not_found", "No file at '%s'" % path, {"name": name, "path": path}
        )
    var entry := ("*" if enabled else "") + path
    ProjectSettings.set_setting("autoload/" + name, entry)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: the autoload entry as project.godot now holds it, leading star and all.
    var stored := str(ProjectSettings.get_setting("autoload/" + name, ""))
    if stored != entry:
        return _readback_error("project.set_autoload %s" % name, entry, stored, {"name": name})
    return {"name": name, "path": path, "enabled": enabled}

func _project_remove_autoload(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.remove_autoload requires name")
    if name == GOFER_AUTOLOAD_NAME:
        return Params.error(
            "gofer_managed",
            "The GoferRuntime autoload is managed by Gofer and cleaned up when the session stops"
        )
    var setting := "autoload/" + name
    if not ProjectSettings.has_setting(setting):
        return Params.error("autoload_not_found", "No autoload named '%s'" % name, {"name": name})
    ProjectSettings.set_setting(setting, null)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: the entry has to be gone from ProjectSettings, not only from this call's intent.
    if ProjectSettings.has_setting(setting):
        return _readback_error(
            "project.remove_autoload %s" % name,
            "no autoload",
            ProjectSettings.get_setting(setting),
            {"name": name}
        )
    return {"name": name, "removed": true}

func _project_list_input_actions() -> Dictionary:
    var actions: Array = []
    for info in ProjectSettings.get_property_list():
        var setting := str(info.get("name", ""))
        if not setting.begins_with("input/"):
            continue
        # Entries like input/ui_close_dialog.macos are per-platform overrides of another action.
        if setting.contains("."):
            continue
        var data: Variant = ProjectSettings.get_setting(setting)
        if typeof(data) != TYPE_DICTIONARY:
            continue
        var name := setting.trim_prefix("input/")
        actions.append(
            {
                "name": name,
                "deadzone": data.get("deadzone", 0.5),
                "events": Params.encode_input_events(data.get("events", [])),
                # Godot's built-in actions all carry the ui_ prefix; custom ones never should.
                "builtIn": name.begins_with("ui_")
            }
        )
    return {"actions": actions}

func _project_set_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or name.contains("/"):
        return Params.error("invalid_params", "project.set_input_action requires a plain action name")
    var setting := "input/" + name
    var existing: Variant = ProjectSettings.get_setting(setting)
    var current: Dictionary = existing if typeof(existing) == TYPE_DICTIONARY else {}
    var deadzone := float(params.get("deadzone", current.get("deadzone", 0.5)))
    var events: Array[InputEvent] = []
    if params.has("events"):
        var decoded := Params.decode_input_events(params["events"])
        if not decoded["ok"]:
            return Params.error("unsupported_value", decoded["message"], {"name": name})
        events = decoded["events"]
    else:
        events.assign(current.get("events", []))
    ProjectSettings.set_setting(setting, {"deadzone": deadzone, "events": events})
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: the action as project.godot now holds it, and the reply is built from that rather
    # than from the events this call assembled.
    var stored: Variant = ProjectSettings.get_setting(setting)
    if typeof(stored) != TYPE_DICTIONARY:
        return _readback_error(
            "project.set_input_action %s" % name, "an action", stored, {"name": name}
        )
    var held: Dictionary = stored
    var held_events: Array = held.get("events", [])
    if not _same_value(deadzone, float(held.get("deadzone", -1.0))):
        return _readback_error(
            "project.set_input_action %s deadzone" % name,
            deadzone,
            held.get("deadzone", null),
            {"name": name}
        )
    if held_events.size() != events.size():
        return _readback_error(
            "project.set_input_action %s events" % name,
            "%d events" % events.size(),
            "%d events" % held_events.size(),
            {"name": name}
        )
    return {
        "name": name,
        "deadzone": float(held.get("deadzone", deadzone)),
        "events": Params.encode_input_events(held_events)
    }

## Removes an input action from project.godot. A built-in ui_ action cannot be deleted; its
## binding is changed with `project.set_input_action` and given back with
## `project.reset_input_action`.
func _project_remove_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.remove_input_action requires name")
    var setting := "input/" + name
    if not ProjectSettings.has_setting(setting):
        return Params.error(
            "input_action_not_found", "No input action named '%s'" % name, {"name": name}
        )
    if name.begins_with("ui_"):
        return Params.error(
            "builtin_input_action",
            "'%s' is a built-in action; change its binding, or reset it with %s"
            % [name, "project.reset_input_action"],
            {"name": name, "command": "project.reset_input_action"}
        )
    ProjectSettings.set_setting(setting, null)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: the action has to be gone from ProjectSettings.
    if ProjectSettings.has_setting(setting):
        return _readback_error(
            "project.remove_input_action %s" % name,
            "no action",
            ProjectSettings.get_setting(setting),
            {"name": name}
        )
    return {"name": name, "removed": true}

## Drops an action's entry from project.godot. A built-in action keeps working on the bindings
## `InputMap` ships, which is what makes this a revert; a custom action simply disappears, so
## `remove` is the honest name for it and this command refuses it.
func _project_reset_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.reset_input_action requires name")
    if not name.begins_with("ui_"):
        return Params.error(
            "custom_input_action",
            "'%s' has no built-in binding to return to; remove it with %s"
            % [name, "project.remove_input_action"],
            {"name": name, "command": "project.remove_input_action"}
        )
    var setting := "input/" + name
    if not ProjectSettings.has_setting(setting):
        return Params.error(
            "input_action_not_found", "No input action named '%s'" % name, {"name": name}
        )
    ProjectSettings.set_setting(setting, null)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: an override project.godot still carries is an action that was not handed back.
    if ProjectSettings.has_setting(setting):
        return _readback_error(
            "project.reset_input_action %s" % name,
            "no override",
            ProjectSettings.get_setting(setting),
            {"name": name}
        )
    # The editor's own InputMap keeps the overridden binding until it reloads the project.
    return {"name": name, "reset": true, "restartRequired": true}

func _project_list_plugins() -> Dictionary:
    var plugins: Array = []
    var addons := DirAccess.open("res://addons")
    if addons != null:
        for directory in addons.get_directories():
            if not FileAccess.file_exists("res://addons/%s/plugin.cfg" % directory):
                continue
            plugins.append(
                {
                    "name": directory,
                    "enabled": EditorInterface.is_plugin_enabled(directory),
                    "goferManaged": directory == GOFER_PLUGIN_NAME
                }
            )
    return {"plugins": plugins}

func _project_set_plugin_enabled(params: Dictionary) -> Dictionary:
    var plugin := str(params.get("plugin", ""))
    if plugin.is_empty() or not params.has("enabled"):
        return Params.error("invalid_params", "project.set_plugin_enabled requires plugin and enabled")
    var enabled := bool(params["enabled"])
    if plugin == GOFER_PLUGIN_NAME and not enabled:
        return Params.error(
            "gofer_managed", "Disabling the Gofer plugin would sever the session carrying this call"
        )
    if not FileAccess.file_exists("res://addons/%s/plugin.cfg" % plugin):
        return Params.error("plugin_not_found", "No plugin named '%s'" % plugin, {"plugin": plugin})
    if EditorInterface.is_plugin_enabled(plugin) == enabled:
        return {"plugin": plugin, "enabled": enabled, "changed": false}
    EditorInterface.set_plugin_enabled(plugin, enabled)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    # Read-back: what the editor says about the plugin now. A plugin whose `_enter_tree` fails is
    # asked to enable, reports nothing, and stays off.
    var actual := EditorInterface.is_plugin_enabled(plugin)
    if actual != enabled:
        return _readback_error(
            "project.set_plugin_enabled %s" % plugin, enabled, actual, {"plugin": plugin}
        )
    return {"plugin": plugin, "enabled": actual, "changed": true}

## EditorSettings are machine-wide and shared by every project this editor opens. They persist
## when the editor exits normally, so these commands never write them to disk themselves.
func _editor_search_settings(params: Dictionary) -> Dictionary:
    var query := str(params.get("query", "")).to_lower()
    var settings := EditorInterface.get_editor_settings()
    var matches: Array = []
    var total := 0
    for info in settings.get_property_list():
        var name := str(info.get("name", ""))
        if name.is_empty() or not settings.has_setting(name):
            continue
        if not query.is_empty() and not name.to_lower().contains(query):
            continue
        total += 1
        if matches.size() < MAX_SEARCH_RESULTS:
            matches.append({"name": name, "value": Protocol.encode(settings.get_setting(name))})
    return {"settings": matches, "totalMatches": total, "truncated": total > matches.size()}

func _editor_get_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "editor.get_setting requires name")
    var settings := EditorInterface.get_editor_settings()
    if not settings.has_setting(name):
        return Params.error(
            "setting_not_found", "Editor setting '%s' does not exist" % name, {"name": name}
        )
    return {"name": name, "value": Protocol.encode(settings.get_setting(name))}

func _editor_set_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or not params.has("value"):
        return Params.error("invalid_params", "editor.set_setting requires name and value")
    var settings := EditorInterface.get_editor_settings()
    if not settings.has_setting(name):
        return Params.error(
            "setting_not_found", "Editor setting '%s' does not exist" % name, {"name": name}
        )
    var decoded := Protocol.decode(params["value"])
    if not decoded["ok"]:
        return Params.error("unsupported_value", decoded["message"], {"name": name})
    settings.set_setting(name, decoded["value"])
    # Read-back: EditorSettings keeps its own declared types and quietly ignores a value of the
    # wrong one, so the reply reports what the editor holds rather than what it was handed.
    var stored: Variant = settings.get_setting(name)
    if not _same_value(decoded["value"], stored):
        return _readback_error("editor.set_setting %s" % name, decoded["value"], stored, {"name": name})
    return {"name": name, "machineWide": true, "value": Protocol.encode(stored)}

## The icons the editor draws beside nodes.
##
## They are read out of the editor's own theme rather than bundled with Gofer: the artwork then
## matches whatever editor theme the user runs, and it arrives already tinted the way Godot tints
## it — blue for 2D, red for 3D, green for Control — so a tree drawn from these reads like the
## editor's. A class the project declares in a script resolves to its `@icon`, or to the icon of
## whatever it extends.
func _editor_class_icons(params: Dictionary) -> Dictionary:
    var requested: Variant = params.get("classes", [])
    if typeof(requested) != TYPE_ARRAY:
        return Params.error("invalid_params", "editor.get_class_icons requires classes")
    var names: Array = requested
    if names.size() > MAX_ICON_CLASSES:
        return Params.error(
            "invalid_params",
            "editor.get_class_icons accepts at most %d classes" % MAX_ICON_CLASSES,
            {"requested": names.size(), "limit": MAX_ICON_CLASSES}
        )
    var theme := EditorInterface.get_editor_theme()
    var scripted := _scripted_classes()
    var icons: Dictionary = {}
    for entry in names:
        var name := str(entry)
        if name.is_empty() or icons.has(name):
            continue
        var png := _class_icon_png(name, theme, scripted)
        if not png.is_empty():
            icons[name] = Marshalls.raw_to_base64(png)
    # A class with no icon is simply absent: the renderer falls back on its own, and a missing
    # icon is never worth failing a scene tree over.
    return {"encoding": "png-base64", "icons": icons}

## Every class the project declares in a script, by name, with the icon and base class it names.
func _scripted_classes() -> Dictionary:
    var classes: Dictionary = {}
    for entry in ProjectSettings.get_global_class_list():
        var name := str(entry.get("class", ""))
        if name.is_empty():
            continue
        classes[name] = {"icon": str(entry.get("icon", "")), "base": str(entry.get("base", ""))}
    return classes

func _class_icon_png(name: String, theme: Theme, scripted: Dictionary) -> PackedByteArray:
    var texture := _class_icon(name, theme, scripted)
    if texture == null:
        return PackedByteArray()
    var image := texture.get_image()
    if image == null or image.is_empty():
        return PackedByteArray()
    if image.is_compressed() and image.decompress() != OK:
        return PackedByteArray()
    if maxi(image.get_width(), image.get_height()) > MAX_ICON_EDGE:
        var scale := float(MAX_ICON_EDGE) / float(maxi(image.get_width(), image.get_height()))
        image.resize(
            maxi(1, int(image.get_width() * scale)),
            maxi(1, int(image.get_height() * scale)),
            Image.INTERPOLATE_LANCZOS
        )
    return image.save_png_to_buffer()

func _class_icon(name: String, theme: Theme, scripted: Dictionary) -> Texture2D:
    var current := name
    # Walk the script classes first: only they can carry an `@icon`, and one that does not ends up
    # drawn as the engine class it ultimately extends.
    for _step in range(MAX_ICON_BASE_DEPTH):
        if not scripted.has(current):
            break
        var entry: Dictionary = scripted[current]
        var path := str(entry.get("icon", ""))
        if not path.is_empty() and ResourceLoader.exists(path):
            var loaded: Variant = load(path)
            if loaded is Texture2D:
                return loaded
        current = str(entry.get("base", ""))
        if current.is_empty():
            break
    if not current.is_empty() and theme.has_icon(current, "EditorIcons"):
        return theme.get_icon(current, "EditorIcons")
    if theme.has_icon("Node", "EditorIcons"):
        return theme.get_icon("Node", "EditorIcons")
    return null

## Tells the editor filesystem that files changed underneath it, and answers once they can actually
## be loaded. Gofer writes project files through Rust, so the editor learns about a saved resource
## here. Scripts are excluded by the caller: Godot's own `didSave` handler already reloads a script
## and refreshes its exports.
##
## `update_file` alone is not enough for an asset. It registers the file and stops there: an image
## dropped into the worktree after the editor started gets no `.import`, no imported texture, and
## `load` answers nothing for a file that is plainly on disk — forever, not for a moment. Every
## caller that wrote a sprite and then asked for it back was refused `does not exist`, rescanned,
## was told `scanned: true`, and asked again, which is a loop with no way out of it. `reimport_files`
## is the step that was missing.
##
## It takes a list because it must. `EditorFileSystem::reimport_files` refuses outright while an
## import is already running — `ERR_FAIL_COND_MSG(importing, ...)` — and the editor runs a full
## `Main::iteration()` from inside that import, because its progress dialog opens on the main loop.
## That iteration reaches this addon's `_process`, which reads the next request off the socket and
## handles it *while the first import holds the flag*. A live run wrote eight PNGs, rescanned all
## eight in one batch, and was told `scanned: true` for all of them: one was imported and seven were
## refused by an engine error nobody was reading. So the whole batch is imported in one call, and no
## call is ever made while the editor is busy — see `_sweep_scan_pending`, which is where the work
## now happens.
##
## Some files are past what `update_file` can do anything with at all — see `_needs_project_walk` —
## and those fall back to the project walk this same command runs for an empty path. It costs a full
## import scan, which is why it is not simply what every rescan does.
func _resource_rescan(params: Dictionary) -> Dictionary:
    var requested := _rescan_paths_param(params)
    if requested.has("_gofer_error"):
        return requested
    var paths: Array = requested["value"]
    # Nothing happens on this frame. The editor may be scanning or importing right now, and both
    # of those make every route through here lie: `get_filesystem_path` answers null for a
    # directory that is plainly there while a scan runs, and `reimport_files` refuses outright
    # while an import does.
    return {"_gofer_pending_scan": {
        "paths": paths,
        "walked": false,
        "scans": _scans_completed,
        "settled": 0,
        "deadline": Time.get_ticks_msec() + RESOURCE_SCAN_TIMEOUT_MS,
        "path": "" if paths.is_empty() else str(paths[0]),
    }}

## Reads `path` as one file or as a list of them, which is what lets a caller rescan everything it
## just wrote in a single command.
##
## One call per file is what produced the batch that broke: the tool takes one path, so eight new
## sprites are eight requests, and the editor answers them inside one another. A list is both the
## shape `reimport_files` already wanted and the shape that stops an agent from having to send a
## storm of them.
func _rescan_paths_param(params: Dictionary) -> Dictionary:
    var raw: Variant = params.get("path", null)
    var listed: Array = []
    if raw == null:
        return {"value": listed}
    if typeof(raw) == TYPE_STRING or typeof(raw) == TYPE_STRING_NAME:
        var single := str(raw)
        if not single.is_empty():
            listed.append(_as_resource_path(single))
        return {"value": listed}
    if typeof(raw) != TYPE_ARRAY and typeof(raw) != TYPE_PACKED_STRING_ARRAY:
        return Params.error(
            "invalid_params",
            "resource.rescan takes a path or a list of paths",
            {"path": raw}
        )
    for entry: Variant in raw:
        if typeof(entry) != TYPE_STRING and typeof(entry) != TYPE_STRING_NAME:
            return Params.error(
                "invalid_params",
                "resource.rescan takes a path or a list of paths",
                {"path": entry}
            )
        var named := str(entry)
        if named.is_empty():
            continue
        var resource_path := _as_resource_path(named)
        if not listed.has(resource_path):
            listed.append(resource_path)
    if listed.size() > MAX_RESCAN_PATHS:
        return Params.error(
            "too_many_paths",
            "resource.rescan takes at most %d paths at a time, and this one names %d"
            % [MAX_RESCAN_PATHS, listed.size()],
            {"limit": MAX_RESCAN_PATHS}
        )
    return {"value": listed}

## Whether this file is beyond what `update_file` can reach, so only a project walk will register it.
##
## `update_file` puts a file into the directory the editor already holds, and does nothing at all
## for one whose directory is not in that tree — no error, no import, no sidecar. A directory made
## after the editor started is not in the tree, and only a scan puts it there. A live run did
## `mkdir -p assets`, wrote seven PNGs into it and rescanned each: every call answered
## `scanned: true`, no `.import` was ever written, and `create_tileset` went on saying the texture
## does not exist — advising the rescan that had just been run seven times.
##
## A hand-written `.import` is the other way past `update_file`. It makes the image answer yes to
## `ResourceLoader.exists` while `load` still returns nothing, and it survives `reimport_files`
## because the file no longer looks new. That is what the same run resorted to, and it only moved
## the refusal to `unsupported_texture`, which blames the picture for a missing import. A sidecar
## whose imported file is not on disk is not an import, and it takes a walk to redo one.
func _needs_project_walk(path: String) -> bool:
    var filesystem := EditorInterface.get_resource_filesystem()
    if filesystem.get_filesystem_path(path.get_base_dir()) == null:
        return true
    return _has_stale_import(path)

## Whether an `.import` beside this file names an imported file that was never produced.
##
## Godot writes the imported resource's path into the sidecar's `path=` — or into `dest_files` when
## an importer makes several. Every one of them exists after a real import. None of them does after
## a hand-written one, which is the difference between a sidecar that means something and a sidecar
## somebody typed.
func _has_stale_import(path: String) -> bool:
    var sidecar := path + ".import"
    if not FileAccess.file_exists(sidecar):
        return false
    var config := ConfigFile.new()
    if config.load(sidecar) != OK:
        return true
    var produced: Array = []
    var single: Variant = config.get_value("remap", "path", null)
    if single is String:
        produced.append(single)
    var many: Variant = config.get_value("deps", "dest_files", null)
    if many is Array:
        for entry: Variant in many:
            if entry is String:
                produced.append(entry)
    if produced.is_empty():
        return true
    for imported: String in produced:
        if not FileAccess.file_exists(imported):
            return true
    return false

## Whether this file is one the editor has to run an importer over before anything can load it.
##
## Both halves matter and both were broken. A `.png` that has never been seen has no `.import`
## beside it, and `update_file` does not give it one — it stays unloadable for good. A `.png` that
## is overwritten has one already and looks settled, but the imported texture still holds the old
## pixels: `update_file` does not re-run the importer, and a project scan only notices when the
## file's timestamp moved, which a rewrite within the same second does not do. So an asset is
## reimported whenever it has an importer's sidecar, and whenever it cannot be loaded at all.
##
## A `.tres`, `.tscn` or `.gd` is read straight off disk with no importer in the way, and re-saving
## one takes over its own cache entry, so none of this applies to them.
func _needs_import(path: String) -> bool:
    if FileAccess.file_exists(path + ".import"):
        return true
    return not ResourceLoader.exists(path)

## Counts the project scans the editor has finished, which is what a parked `resource.rescan` waits
## on.
func _on_filesystem_scanned() -> void:
    _scans_completed += 1

## Runs every parked rescan on a frame where the editor is doing nothing else, and answers it once
## the files it named are really there.
##
## Nothing here may run while the editor is scanning or importing. Both states make the engine lie
## to this addon rather than fail: while a scan runs `get_filesystem_path` answers null for every
## directory, so a settled project looks like one the editor has never walked; while an import runs
## `reimport_files` refuses the call outright. A rescan handled in either state answered
## `scanned: true` for a file the editor had not touched.
##
## The editor reaches this addon in both states of its own accord — its progress dialog runs
## `Main::iteration()` from inside an import — so waiting for a quiet frame is the only way to be
## sure, and it is why the work is here rather than in `_resource_rescan`.
func _sweep_scan_pending() -> void:
    if _scan_pending.is_empty() or _sweeping_scans:
        return
    _sweeping_scans = true
    _run_scan_sweep()
    _sweeping_scans = false

## The body of one sweep. Split out so the latch above has exactly one place to clear itself:
## GDScript has no `finally`, and an early `return` from inside this would strand the flag and stop
## every later rescan in the session.
func _run_scan_sweep() -> void:
    var filesystem := EditorInterface.get_resource_filesystem()
    var settled := not filesystem.is_scanning() and not filesystem.is_importing()
    var now := Time.get_ticks_msec()
    var kept: Array[Dictionary] = []
    for pending in _scan_pending:
        if int(pending["deadline"]) < now:
            # The message has to match the editor in front of it. Still importing after half a
            # minute is a slow project and asking again is the right advice; idle after half a
            # minute is a fault, and the old sentence sent a model round that loop for as long as
            # it was willing to keep asking.
            if settled:
                _respond_error(
                    pending["id"],
                    "scan_stalled",
                    "The editor is idle and this rescan never finished, so asking again "
                    + "will not change anything",
                    false,
                    {"paths": pending["paths"]}
                )
            else:
                _respond_error(
                    pending["id"],
                    "scan_timeout",
                    "The editor is still importing the project",
                    true,
                    {}
                )
            continue
        if not settled:
            kept.append(pending)
            continue
        if bool(pending["walked"]):
            # A walk this rescan started. `filesystem_changed` is what says one has landed, and the
            # editor emits it at the end of every import too, so the counter is only trusted on a
            # frame where nothing is running.
            if _scans_completed > int(pending["scans"]):
                # The walk is the last resort, so what it left behind is the answer. Reporting
                # `scanned: true` without looking is what sent a caller to `create_tileset` with a
                # texture the editor had never imported.
                var missing := _paths_not_loadable(pending["paths"])
                if missing.is_empty():
                    _respond_result(pending["id"], _rescan_result(pending))
                else:
                    _respond_error(
                        pending["id"],
                        "import_failed",
                        "The project was walked and %s still cannot be loaded, so the editor "
                        % ", ".join(missing)
                        + "cannot import it as it stands",
                        false,
                        {"paths": missing}
                    )
                continue
            pending["settled"] = int(pending["settled"]) + 1
            if int(pending["settled"]) > RESOURCE_SCAN_SETTLED_FRAMES:
                _respond_error(
                    pending["id"],
                    "scan_stalled",
                    "The editor finished scanning without reporting it, so this rescan cannot "
                    + "be answered",
                    false,
                    {"paths": pending["paths"]}
                )
                continue
            kept.append(pending)
            continue
        var paths: Array = pending["paths"]
        if not paths.is_empty() and _import_batch(paths):
            _respond_result(pending["id"], _rescan_result(pending))
            continue
        # Either the caller asked for the whole project, or a named file is past what `update_file`
        # can reach, or the import did not leave it loadable. A walk is the last resort and the
        # only one left: it is the one thing that registers a directory the editor has never seen.
        filesystem.scan()
        pending["walked"] = true
        pending["scans"] = _scans_completed
        pending["settled"] = 0
        kept.append(pending)
    _scan_pending = kept

## The named paths that ought to load and do not, in the order they were named.
##
## Three conditions, and all three were measured against a real editor rather than reasoned about.
##
## The file has to be on disk: a rescan of a path an asset has left is how the editor is told to let
## go of it, and that is a success, not a missing import.
##
## An `.import` sidecar has to sit beside it. That file is the editor's own record that an importer
## claimed this one — a project walk writes `broken.png.import` for a PNG it cannot read and writes
## nothing at all for `assets/gen.py`. Without this the check called every script and text file in
## the worktree a failed import.
##
## And then it has to load. A failed import leaves the sidecar and the `.md5` and no imported
## resource behind it, so the sidecar says "an importer tried" and the load says whether anything
## came of it. `ResourceLoader.exists` cannot answer this: it reports on the path rather than on the
## bytes, which is how a PNG header over sixty-four zeroes was answered `scanned: true`.
##
## An empty list of paths is a whole-project walk, which claims nothing about any one file and so
## can never be missing one.
func _paths_not_loadable(paths: Array) -> Array[String]:
    var missing: Array[String] = []
    for path: String in paths:
        if not FileAccess.file_exists(path):
            continue
        if not FileAccess.file_exists(path + ".import"):
            continue
        if ResourceLoader.load(path) == null:
            missing.append(path)
    return missing

## What a finished rescan answers with. `path` stays for the callers that named one file, so the
## single-path answer is the one it always was.
func _rescan_result(pending: Dictionary) -> Dictionary:
    return {
        "scanned": true,
        "path": pending.get("path", ""),
        "paths": pending.get("paths", []),
    }

## Registers a batch of files and imports the ones that need it, in one call, and reports whether
## every one of them can be loaded afterwards.
##
## One `reimport_files` for the whole batch is the point. The engine refuses a second call while the
## first is running, and it re-enters this addon from inside the first, so a batch imported one file
## per call imports the first file and silently drops the rest.
##
## `false` means the batch is not this command's to finish: a directory the editor has never walked
## takes `update_file` nowhere, and an asset that still will not load after its import needs the
## walk that redoes one properly.
func _import_batch(paths: Array) -> bool:
    var filesystem := EditorInterface.get_resource_filesystem()
    for path: String in paths:
        if _needs_project_walk(path):
            return false
    var importable: Array[String] = []
    for path: String in paths:
        filesystem.update_file(path)
        if _needs_import(path):
            importable.append(path)
    if importable.is_empty():
        return true
    filesystem.reimport_files(importable)
    return _paths_not_loadable(importable).is_empty()

## Cuts a texture into a TileSet and saves it, which is the one resource a 2D game cannot be built
## without and the one a caller cannot write as text.
##
## A TileSet is not a small `.tres` a model can type: an atlas source carries a per-tile record for
## every tile it defines, and the collision a tile contributes is a polygon on a physics layer that
## has to exist first. Every level built before this command was ColorRects and hand-written shapes,
## one node per block, because this was the missing step — and a tileset written by hand is exactly
## the file the editor opens as an empty resource with no tiles in it.
func _resource_create_tileset(params: Dictionary) -> Dictionary:
    var path := _as_resource_path(params.get("path", ""))
    var texture_path := _as_resource_path(params.get("texture", ""))
    if path.is_empty() or texture_path.is_empty():
        return Params.error(
            "invalid_params",
            "resource.create_tileset requires path and texture",
        )
    if not path.ends_with(".tres"):
        return Params.error(
            "invalid_params",
            "A TileSet is saved as a .tres resource, and %s is not one" % path,
            {"path": path}
        )
    if not ResourceLoader.exists(texture_path):
        return Params.error(
            "texture_not_found",
            (
                "Texture %s does not exist. A tileset is cut from an image the project already "
                + "holds — and an image written into the worktree from outside the editor is not "
                + "one until `resource.rescan` names it."
            ) % texture_path,
            {"texture": texture_path}
        )
    var texture := load(texture_path)
    if texture == null or not (texture is Texture2D):
        return Params.error(
            "unsupported_texture",
            "%s is not a Texture2D, so it cannot be cut into tiles" % texture_path,
            {"texture": texture_path}
        )

    var size_result := Params.tile_size(params)
    if size_result.has("_gofer_error"):
        return size_result
    var tile_size: Vector2i = size_result["value"]
    var image_size: Vector2i = (texture as Texture2D).get_size()
    var grid := Vector2i(image_size.x / tile_size.x, image_size.y / tile_size.y)
    if grid.x < 1 or grid.y < 1:
        return Params.error(
            "tile_size_too_large",
            (
                "%s is %dx%d, which does not hold one %dx%d tile"
                % [texture_path, image_size.x, image_size.y, tile_size.x, tile_size.y]
            ),
            {"texture": [image_size.x, image_size.y], "tileSize": [tile_size.x, tile_size.y]}
        )

    var wanted := Params.atlas_coords(params, "tiles", grid)
    if wanted.has("_gofer_error"):
        return wanted
    var tiles: Array = wanted["value"]
    if tiles.is_empty():
        for row in range(grid.y):
            for column in range(grid.x):
                tiles.append(Vector2i(column, row))
    if tiles.size() > MAX_TILESET_TILES:
        return Params.error(
            "too_many_tiles",
            "A tileset takes at most %d tiles, and this one asks for %d"
            % [MAX_TILESET_TILES, tiles.size()],
            {"limit": MAX_TILESET_TILES}
        )
    var solid_param: Variant = params.get("solid", null)
    var solid: Array = []
    if typeof(solid_param) == TYPE_STRING and str(solid_param) == "all":
        solid = tiles.duplicate()
    elif solid_param != null:
        var chosen := Params.atlas_coords(params, "solid", grid)
        if chosen.has("_gofer_error"):
            return chosen
        solid = chosen["value"]
    for coords in solid:
        if not tiles.has(coords):
            return Params.error(
                "tile_not_defined",
                (
                    "Tile (%d, %d) is listed as solid but is not one of the tiles being created"
                    % [coords.x, coords.y]
                ),
                {"tile": [coords.x, coords.y]}
            )

    var tile_set := TileSet.new()
    tile_set.tile_size = tile_size
    if not solid.is_empty():
        # `add_physics_layer` answers nothing in 4.7, so the layer it appended is the last one.
        tile_set.add_physics_layer()
    var source := TileSetAtlasSource.new()
    source.texture = texture
    source.texture_region_size = tile_size
    var source_id := tile_set.add_source(source)
    for coords in tiles:
        source.create_tile(coords)
    var half := Vector2(tile_size) / 2.0
    for coords in solid:
        var data := source.get_tile_data(coords, 0)
        data.add_collision_polygon(0)
        data.set_collision_polygon_points(
            0,
            0,
            PackedVector2Array(
                [
                    Vector2(-half.x, -half.y),
                    Vector2(half.x, -half.y),
                    Vector2(half.x, half.y),
                    Vector2(-half.x, half.y)
                ]
            )
        )

    var replaced := ResourceLoader.exists(path)
    # A directory that does not exist yet is not a mistake worth an error: `res://tiles/world.tres`
    # is where a caller would put one, and `ResourceSaver` would only answer that it could not open
    # the file.
    var folder := path.get_base_dir()
    if not DirAccess.dir_exists_absolute(folder):
        var made := DirAccess.make_dir_recursive_absolute(folder)
        if made != OK:
            return Params.error(
                "save_failed",
                "Directory %s could not be created: %s" % [folder, error_string(made)],
                {"path": path}
            )
    var error := ResourceSaver.save(tile_set, path)
    if error != OK:
        return Params.error(
            "save_failed",
            "TileSet %s could not be saved: %s" % [path, error_string(error)],
            {"path": path, "error": error}
        )
    EditorInterface.get_resource_filesystem().update_file(path)

    # Read-back: the tileset is loaded again from the file it was written to, cache ignored, so the
    # reply describes what a caller opening that path finds rather than the resource still in
    # memory. A tile's collision polygon is the part that goes missing quietly — the file opens as a
    # tileset either way, and the level built on it simply has no floor.
    var written := ResourceLoader.load(path, "TileSet", ResourceLoader.CACHE_MODE_IGNORE)
    if written == null or not (written is TileSet):
        return Params.error(
            "save_failed",
            "%s was reported saved but does not load back as a TileSet" % path,
            {"path": path}
        )
    var saved_set: TileSet = written
    if saved_set.tile_size != tile_size:
        return _readback_error(
            "resource.create_tileset tileSize", tile_size, saved_set.tile_size, {"path": path}
        )
    if not saved_set.has_source(source_id):
        return _readback_error(
            "resource.create_tileset source", source_id, "no source", {"path": path}
        )
    var saved_source := saved_set.get_source(source_id)
    if not (saved_source is TileSetAtlasSource):
        return _readback_error(
            "resource.create_tileset source",
            "an atlas source",
            saved_source.get_class(),
            {"path": path}
        )
    var saved_atlas: TileSetAtlasSource = saved_source
    for coords in tiles:
        if not saved_atlas.has_tile(coords):
            return _readback_error(
                "resource.create_tileset tile",
                "a tile at (%d, %d)" % [coords.x, coords.y],
                "nothing",
                {"path": path}
            )
    for coords in solid:
        if saved_atlas.get_tile_data(coords, 0).get_collision_polygons_count(0) == 0:
            return _readback_error(
                "resource.create_tileset collision",
                "a collision polygon on (%d, %d)" % [coords.x, coords.y],
                "none",
                {"path": path}
            )

    return {
        "path": path,
        "texture": texture_path,
        "tileSize": [saved_set.tile_size.x, saved_set.tile_size.y],
        "grid": [grid.x, grid.y],
        "source": source_id,
        "tiles": Params.coords_list(tiles),
        "solid": Params.coords_list(solid),
        "physicsLayers": saved_set.get_physics_layers_count(),
        "replaced": replaced,
    }

## Saves a 2D collision shape as a resource a node can be given.
##
## A resource property is filled by naming a file that already exists — `node.set_property` resolves
## it with `load` — so a shape that was never saved cannot be assigned at all. Every collision node
## in the catalogue was therefore creatable and unusable: `CollisionShape2D` had no way to reach a
## `RectangleShape2D`. This is the shape half of what `resource.create_tileset` does for tiles.
func _resource_create_shape(params: Dictionary) -> Dictionary:
    var path := _as_resource_path(params.get("path", ""))
    var shape_type := str(params.get("shapeType", ""))
    if path.is_empty() or shape_type.is_empty():
        return Params.error(
            "invalid_params", "resource.create_shape requires path and shapeType"
        )
    if not path.ends_with(".tres"):
        return Params.error(
            "invalid_params",
            "A shape is saved as a .tres resource, and %s is not one" % path,
            {"path": path}
        )
    if not SHAPE_TYPES.has(shape_type):
        var offered: Array = SHAPE_TYPES.keys()
        offered.sort()
        return Params.error(
            "unsupported_shape",
            "%s is not a 2D collision shape. Available: %s" % [shape_type, ", ".join(offered)],
            {"shapeType": shape_type, "available": offered}
        )

    var built := Params.build_shape(shape_type, params)
    if built.has("_gofer_error"):
        return built
    var shape: Shape2D = built["value"]

    # A directory that does not exist yet is not a mistake worth an error, for the same reason a
    # tileset's is not: `res://shapes/hitbox.tres` is where a caller would put one.
    var folder := path.get_base_dir()
    if not DirAccess.dir_exists_absolute(folder):
        var made := DirAccess.make_dir_recursive_absolute(folder)
        if made != OK:
            return Params.error(
                "save_failed",
                "Directory %s could not be created: %s" % [folder, error_string(made)],
                {"path": path}
            )
    var replaced := ResourceLoader.exists(path)
    var error := ResourceSaver.save(shape, path)
    if error != OK:
        return Params.error(
            "save_failed",
            "Shape %s could not be saved: %s" % [path, error_string(error)],
            {"path": path, "error": error}
        )
    EditorInterface.get_resource_filesystem().update_file(path)

    # Read-back: the shape as the file holds it. A property filled from this path loads the same
    # bytes, so the class on disk is the only one that matters.
    var written := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
    if written == null:
        return Params.error(
            "save_failed",
            "%s was reported saved but does not load back at all" % path,
            {"path": path}
        )
    var saved_type := (written as Resource).get_class()
    if saved_type != shape_type:
        return _readback_error("resource.create_shape", shape_type, saved_type, {"path": path})

    return {
        "path": path,
        "shapeType": saved_type,
        "replaced": replaced,
    }


## Reports what a saved TileSet holds, so a caller painting with it can name tiles that exist.
func _resource_describe_tileset(params: Dictionary) -> Dictionary:
    var path := _as_resource_path(params.get("path", ""))
    if path.is_empty():
        return Params.error("invalid_params", "resource.describe_tileset requires path")
    if not ResourceLoader.exists(path):
        return Params.error(
            "resource_not_found", "TileSet %s does not exist" % path, {"path": path}
        )
    var resource := load(path)
    if resource == null or not (resource is TileSet):
        return Params.error(
            "unsupported_resource", "%s is not a TileSet" % path, {"path": path}
        )
    var tile_set: TileSet = resource
    var sources: Array = []
    for index in range(tile_set.get_source_count()):
        var source_id := tile_set.get_source_id(index)
        var source := tile_set.get_source(source_id)
        var report := {"id": source_id, "type": source.get_class(), "tiles": [], "truncated": false}
        if source is TileSetAtlasSource:
            var atlas: TileSetAtlasSource = source
            report["texture"] = atlas.texture.resource_path if atlas.texture != null else ""
            report["regionSize"] = [atlas.texture_region_size.x, atlas.texture_region_size.y]
            for tile_index in range(atlas.get_tiles_count()):
                if tile_index >= MAX_REPORTED_TILES:
                    report["truncated"] = true
                    break
                var coords := atlas.get_tile_id(tile_index)
                var data := atlas.get_tile_data(coords, 0)
                var solid := false
                for layer in range(tile_set.get_physics_layers_count()):
                    if data.get_collision_polygons_count(layer) > 0:
                        solid = true
                        break
                report["tiles"].append({"atlas": [coords.x, coords.y], "solid": solid})
            report["count"] = atlas.get_tiles_count()
        sources.append(report)
    return {
        "path": path,
        "tileSize": [tile_set.tile_size.x, tile_set.tile_size.y],
        "physicsLayers": tile_set.get_physics_layers_count(),
        "sources": sources,
    }




## A path named either way, as Godot names it.
func _as_resource_path(value: Variant) -> String:
    var path := str(value).strip_edges()
    if path.is_empty() or path.begins_with("res://"):
        return path
    return "res://" + path.trim_prefix("./").trim_prefix("/")

func _scene_list() -> Dictionary:
    return {"scenes": Array(EditorInterface.get_open_scenes())}

func _scene_open(params: Dictionary) -> Dictionary:
    # The editor names every scene it edits `res://…`, and the switch is only ever confirmed by
    # comparing against that name. A caller's `scenes/hud.tscn` opens the scene and then matches
    # nothing, so the request expired against a switch that had already happened.
    var path := _as_resource_path(params.get("path", ""))
    if path.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "scene.open requires path",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    # A scene the editor cannot load would never satisfy the switch, so it is refused here rather
    # than left to expire against `SCENE_SWITCH_TIMEOUT_MS`.
    if not ResourceLoader.exists(path):
        return Params.error("scene_not_found", "Scene %s does not exist" % path, {"path": path})
    return _switch_edited_scene(path)

func _scene_create(params: Dictionary) -> Dictionary:
    var path := _as_resource_path(params.get("path", ""))
    var root_type: String = params.get("rootType", "Node")
    if path.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "scene.create requires path",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    _set_readiness("importing")
    var root: Node = ClassDB.instantiate(root_type) as Node
    if root == null:
        _set_readiness("ready")
        return {
            "_gofer_error": {
                "code": "invalid_node_type",
                "message": "Could not instantiate %s" % root_type,
                "retryable": false,
                "readiness": "ready",
                "details": {"rootType": root_type}
            }
        }
    # `rootName` is what the caller asked the root to be called; the file's own name is only the
    # fallback. Ignoring it left every agent-created scene rooted at `level_1` however clearly the
    # request named `Level1`.
    var root_name: String = params.get("rootName", "")
    root.name = root_name if not root_name.is_empty() else path.get_file().get_basename()
    # Godot rewrites a name it will not accept, so what the root is really called is read off the
    # node rather than taken from the request.
    var named := String(root.name)
    var scene := PackedScene.new()
    var pack_error := scene.pack(root)
    if pack_error != OK:
        _set_readiness("ready")
        root.queue_free()
        return {
            "_gofer_error": {
                "code": "scene_pack_failed",
                "message": "Could not pack new scene (error %d)" % pack_error,
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var save_error := ResourceSaver.save(scene, path)
    if save_error != OK:
        _set_readiness("ready")
        root.queue_free()
        return {
            "_gofer_error": {
                "code": "scene_save_failed",
                "message": "Could not save new scene (error %d)" % save_error,
                "retryable": false,
                "readiness": "ready",
                "details": {"path": path}
            }
        }
    root.queue_free()

    # Read-back: the file that was just written, loaded again from disk rather than reported from
    # the PackedScene still in memory. `ResourceSaver.save` answers OK for a write the filesystem
    # refused, and the scene switch that follows would then wait thirty seconds on a file that is
    # not there.
    var written := ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
    if written == null or not (written is PackedScene):
        _set_readiness("ready")
        return Params.error(
            "scene_save_failed",
            "%s was reported saved but does not load back as a scene" % path,
            {"path": path}
        )
    var state := (written as PackedScene).get_state()
    var saved_name := "" if state.get_node_count() == 0 else String(state.get_node_name(0))
    if saved_name != named:
        _set_readiness("ready")
        return _readback_error("scene.create root", named, saved_name, {"path": path})
    var saved_type := "" if state.get_node_count() == 0 else String(state.get_node_type(0))
    if saved_type != root_type:
        _set_readiness("ready")
        return _readback_error("scene.create rootType", root_type, saved_type, {"path": path})

    # The scene was written behind the editor's back, so its filesystem is told about the file
    # before it is asked to open it — an unknown resource is one the editor refuses to load.
    EditorInterface.get_resource_filesystem().update_file(path)
    return _switch_edited_scene(path)

func _scene_save(_params: Dictionary) -> Dictionary:
    if _current_scene_path.is_empty():
        return {
            "_gofer_error": {
                "code": "no_open_scene",
                "message": "No scene is open to save",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var root := _edited_root()
    if root == null:
        return {
            "_gofer_error": {
                "code": "no_open_scene",
                "message": "No scene is open to save",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var error := EditorInterface.save_scene()
    if error != OK:
        return {
            "_gofer_error": {
                "code": "scene_save_failed",
                "message": "Could not save scene (error %d)" % error,
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var verified := _saved_scene_holds(_current_scene_path, root)
    if not verified.is_empty():
        return verified
    _scene_dirty = false
    return {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_dirty}

func _scene_save_as(params: Dictionary) -> Dictionary:
    # `root.scene_file_path` below is the editor's own `res://…` name for the file, so the request's
    # path has to be the same shape or the save is reported as having landed somewhere else.
    var path := _as_resource_path(params.get("path", ""))
    if path.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "scene.save_as requires path",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var root := _edited_root()
    if root == null:
        return {
            "_gofer_error": {
                "code": "no_open_scene",
                "message": "No scene is open to save",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    EditorInterface.save_scene_as(path)
    var verified := _saved_scene_holds(path, root)
    if not verified.is_empty():
        return verified
    # Which file the edited scene belongs to now is the editor's own answer. A save-as that wrote
    # the file and left the tab on the old one would otherwise make every later save go elsewhere.
    var owned := String(root.scene_file_path)
    if owned != path:
        return _readback_error(
            "scene.save_as", path, owned if not owned.is_empty() else "no file", {"path": path}
        )
    _current_scene_path = owned
    _scene_dirty = false
    return {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_dirty}

func _scene_reload(_params: Dictionary) -> Dictionary:
    if _current_scene_path.is_empty():
        return {
            "_gofer_error": {
                "code": "no_open_scene",
                "message": "No scene is open to reload",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    return _reload_edited_scene(_current_scene_path)

## Asks the editor to edit `path` and parks the answer until it does. Re-opening the scene the
## editor already edits is a no-op in Godot — the tab is only selected — so the wait is satisfied
## by the root the editor already holds.
func _switch_edited_scene(path: String) -> Dictionary:
    return _pending_scene_switch("open", path, 0)

## Asks the editor to reload `path` from disk and parks the answer until it does. A reload keeps
## the path and replaces the root, so the wait is for a root that is not the one being discarded.
func _reload_edited_scene(path: String) -> Dictionary:
    var root := _edited_root()
    var replaced := root.get_instance_id() if root != null else 0
    return _pending_scene_switch("reload", path, replaced)

func _pending_scene_switch(mode: String, path: String, replaced: int) -> Dictionary:
    _set_readiness("importing")
    var pending := {
        "mode": mode,
        "path": path,
        "replaced": replaced,
        "deadline": Time.get_ticks_msec() + SCENE_SWITCH_TIMEOUT_MS,
        "next_ask": Time.get_ticks_msec() + SCENE_SWITCH_RETRY_MS,
    }
    _ask_editor_to_switch(pending)
    return {"_gofer_pending_scene": pending}

## Parks a scene-switch response until `_sweep_scene_pending` sees the editor obey it.
func _defer_scene_switch(id: String, command: String, pending: Dictionary) -> void:
    pending["id"] = id
    pending["mutating"] = MUTATING_COMMANDS.has(command)
    _scene_pending.append(pending)

func _ask_editor_to_switch(pending: Dictionary) -> void:
    if pending["mode"] == "reload":
        EditorInterface.reload_scene_from_path(pending["path"])
    else:
        EditorInterface.open_scene_from_path(pending["path"])

## Why the editor never opened a scene, in the words the user needs to act on it.
##
## A scene file the editor cannot build from is by far the likeliest reason — a `.tscn` written by
## hand, or by an agent, with a node that names no parent. The editor says so in its own log and
## then does nothing, so the refusal has to carry the same fact.
func _scene_switch_failure(path: String) -> String:
    var resource := ResourceLoader.load(path, "PackedScene")
    if resource == null or not (resource is PackedScene):
        return "%s is not a scene the editor can read" % path
    # `can_instantiate` answers for the scene's *types*, not for its contents: a node that names no
    # parent passes it and then fails to build. Building it is the only question worth asking, and
    # by this point the editor has already refused to for thirty seconds.
    var probe: Node = (resource as PackedScene).instantiate()
    if probe == null:
        var reason := "%s could not be built into a scene: the editor rejected its contents."
        return reason % path + " Godot's own reason is in the session output."
    probe.free()
    return "The editor did not open %s" % path

## True once the editor really edits the scene the request named, rather than having merely been
## asked to.
func _edited_scene_switched(pending: Dictionary) -> bool:
    var root := _edited_root()
    if root == null or root.scene_file_path != String(pending["path"]):
        return false
    return root.get_instance_id() != int(pending["replaced"])

## Answers the scene switches the editor has performed and re-asks for the ones it dropped. The
## session state a switch resets is adopted here, not when the request arrived: until the editor
## obeys, the old scene is still the edited one and its revision still describes it.
func _sweep_scene_pending() -> void:
    if _scene_pending.is_empty():
        return
    var now := Time.get_ticks_msec()
    var kept: Array[Dictionary] = []
    for pending in _scene_pending:
        if _edited_scene_switched(pending):
            _current_scene_path = pending["path"]
            _scene_revision = 0
            _scene_dirty = false
            _undo_depth = 0
            _redo_depth = 0
            _set_readiness("ready")
            var result := {
                "scene": _current_scene_path,
                "revision": _scene_revision,
                "dirty": _scene_dirty,
            }
            if pending["mutating"]:
                _respond_result(pending["id"], result, _scene_revision)
            else:
                _respond_result(pending["id"], result)
        elif int(pending["deadline"]) < now:
            _set_readiness("ready")
            _respond_error(
                pending["id"],
                "scene_switch_timeout",
                _scene_switch_failure(String(pending["path"])),
                true,
                {"path": pending["path"]}
            )
        else:
            if int(pending["next_ask"]) <= now:
                pending["next_ask"] = now + SCENE_SWITCH_RETRY_MS
                _ask_editor_to_switch(pending)
            kept.append(pending)
    _scene_pending = kept

## The edited hierarchy and the revision it is at.
##
## The revision travels in the envelope for a mutating command, and `scene.get_tree` is not one —
## so without it here the one command documented as the source of `expectedRevision` answered
## without it, and an agent that read the tree before every mutation had no number to send.
func _scene_tree() -> Dictionary:
    var root := _edited_root()
    if root == null:
        return {"root": null, "revision": _scene_revision}
    return {"root": _node_summary(root), "revision": _scene_revision}

func _node_create(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var parent_path: String = params.get("parent", "")
    var node_name: String = params.get("name", "")
    var node_type: String = params.get("type", "")
    var index: int = params.get("index", -1)

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if parent_path.is_empty() or node_name.is_empty() or node_type.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.create requires parent, name, and type",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    if UNCREATABLE_TYPES.has(node_type):
        return {
            "_gofer_error": {
                "code": "invalid_node_type",
                "message": UNCREATABLE_TYPES[node_type],
                "retryable": false,
                "readiness": "ready",
                "details": {"type": node_type}
            }
        }

    var parent := _find_node(parent_path)
    if parent == null:
        return _node_not_found_error(parent_path)

    var node: Node = ClassDB.instantiate(node_type) as Node
    if node == null:
        return {
            "_gofer_error": {
                "code": "invalid_node_type",
                "message": "Could not instantiate %s" % node_type,
                "retryable": false,
                "readiness": "ready",
                "details": {"type": node_type}
            }
        }
    node.name = node_name

    var root := _edited_root()
    var undo := _begin_action("Create %s" % node_name)
    undo.add_do_method(self, "_do_attach", parent, node, root, index)
    undo.add_undo_method(self, "_do_detach", parent, node)
    undo.add_do_reference(node)
    undo.commit_action()

    var attached := _attached_node(parent, node, root, "node.create", {"type": node_type})
    if attached.has("_gofer_error"):
        return attached

    _bump_revision()
    return {"node": _node_path(node)}

## Creates several nodes at once: one revision in, one revision out, one undo step.
##
## `node.create` answers with the next revision and the next create needs that number, so a scene of
## forty nodes was forty round trips through the model. A measured turn spent 44 creates and 65
## property writes as 109 separate asks, waiting on the model for about two seconds before each one,
## and 6% of the wall clock was the editor doing work. The concurrency check does not need that: one
## revision covers forty nodes as safely as it covers one, because the whole batch is still a single
## point at which a human edit in the editor would be noticed.
##
## Failure is all-or-nothing, the way `node.set_cells` is: every entry is checked and every node is
## instantiated before anything is attached, so an entry the editor refuses leaves the scene exactly
## as it was. Entries are attached in the order given, and a later entry may name a node an earlier
## entry creates as its parent.
func _node_create_nodes(params: Dictionary) -> Dictionary:
    var scene_check := _require_current_scene(String(params.get("scene", "")))
    if not scene_check.is_empty():
        return scene_check

    var raw: Variant = params.get("nodes", null)
    if typeof(raw) != TYPE_ARRAY or (raw as Array).is_empty():
        return Params.error(
            "invalid_params",
            (
                "node.create_nodes requires nodes: a list of {parent, type, name, index?} entries, "
                + "the same four node.create takes."
            )
        )
    var entries: Array = raw
    if entries.size() > MAX_BATCH_ENTRIES:
        return Params.error(
            "too_many_entries",
            (
                "One command creates at most %d nodes, and this asks for %d"
                % [MAX_BATCH_ENTRIES, entries.size()]
            ),
            {"limit": MAX_BATCH_ENTRIES}
        )

    var root := _edited_root()
    # The nodes this batch is about to add, under the path the caller will know them by. A parent is
    # looked for here before the tree, so an entry can hang off one the same batch has not attached
    # yet — which is what building a subtree in one call means.
    var pending: Dictionary = {}
    var plan: Array = []
    for entry in entries:
        if typeof(entry) != TYPE_DICTIONARY:
            return Params.error(
                "invalid_params", "Each nodes entry is an object, and %s is not one" % str(entry)
            )
        var spec: Dictionary = entry
        var parent_path := _batch_parent_key(String(spec.get("parent", "")))
        var node_name := String(spec.get("name", ""))
        var node_type := String(spec.get("type", ""))
        if parent_path.is_empty() or node_name.is_empty() or node_type.is_empty():
            return Params.error(
                "invalid_params", "Each nodes entry requires parent, name, and type"
            )
        if UNCREATABLE_TYPES.has(node_type):
            return Params.error(
                "invalid_node_type", UNCREATABLE_TYPES[node_type], {"type": node_type}
            )
        var parent: Node = pending.get(parent_path, null)
        if parent == null:
            parent = _find_node(parent_path)
        if parent == null:
            return _node_not_found_error(parent_path)
        var node: Node = ClassDB.instantiate(node_type) as Node
        if node == null:
            return Params.error(
                "invalid_node_type", "Could not instantiate %s" % node_type, {"type": node_type}
            )
        node.name = node_name
        plan.append([parent, node, int(spec.get("index", -1)), node_type])
        pending[parent_path + "/" + node_name] = node

    var undo := _begin_action("Create %d nodes" % plan.size())
    for step in plan:
        undo.add_do_method(self, "_do_attach", step[0], step[1], root, step[2])
        undo.add_undo_method(self, "_do_detach", step[0], step[1])
        undo.add_do_reference(step[1])
    undo.commit_action()

    # Read-back, per node, for the same reason `node.create` does it one at a time: a node that was
    # never taken by the editor still answers for its own name and type, so a reply built from the
    # objects in hand would describe a scene that does not have them.
    var created: Array = []
    for step in plan:
        var attached := _attached_node(
            step[0], step[1], root, "node.create_nodes", {"type": step[3]}
        )
        if attached.has("_gofer_error"):
            return attached
        created.append(_node_path(step[1]))

    _bump_revision()
    return {"nodes": created, "created": created.size()}

## The path an entry's children will name it by, with a trailing slash and a doubled slash taken off.
##
## Only the caller's own spelling is matched. A batch names a parent the way it named the entry that
## created it, and anything else falls through to the tree, where a path that is really wrong is
## answered by `node_not_found` naming it.
func _batch_parent_key(path: String) -> String:
    var trimmed := path.strip_edges()
    while trimmed.length() > 1 and trimmed.ends_with("/"):
        trimmed = trimmed.substr(0, trimmed.length() - 1)
    return trimmed

## Checks that a node a command committed is really in the edited tree, owned by its root.
##
## The node the command holds answers for itself whether or not the editor took it: it keeps its
## name, its type and its properties as a free-floating object, so a reply built from it describes a
## node the scene does not have. It is therefore asked of its parent again — and of the owner, since
## a node the root does not own is one the next save leaves out of the file entirely.
func _attached_node(
    parent: Node, node: Node, root: Node, command: String, details: Dictionary = {}
) -> Dictionary:
    var found := parent.get_node_or_null(NodePath(String(node.name)))
    if found != node:
        return _readback_error(
            command, "%s under %s" % [node.name, _node_path(parent)], "nothing", details
        )
    if node.owner != root:
        return _readback_error(
            "%s owner" % command,
            root.name,
            "nothing" if node.owner == null else node.owner.name,
            details
        )
    return {}

## Places an instance of a saved scene under a node, the way the editor's "Instantiate Child Scene"
## does.
##
## This is how a Godot project is actually built: one coin scene placed thirty times, not thirty
## hand-made coins. `node.create` can only reach `ClassDB`, so without this every repeated thing in
## a level had to be rebuilt node by node — and a change to one of them reached none of the others.
func _node_instantiate(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var parent_path: String = params.get("parent", "")
    var path: String = params.get("path", "")
    var node_name: String = params.get("name", "")
    var index: int = params.get("index", -1)

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if parent_path.is_empty() or path.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.instantiate requires parent and path",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var parent := _find_node(parent_path)
    if parent == null:
        return _node_not_found_error(parent_path)

    var cycle := _instance_cycle(path)
    if not cycle.is_empty():
        return {
            "_gofer_error": {
                "code": "recursive_instance",
                "message": cycle,
                "retryable": false,
                "readiness": "ready",
                "details": {"path": path, "scene": _current_scene_path}
            }
        }

    var resource := ResourceLoader.load(path, "PackedScene")
    if resource == null or not (resource is PackedScene):
        return {
            "_gofer_error": {
                "code": "invalid_scene",
                "message": "%s is not a scene that can be loaded" % path,
                "retryable": false,
                "readiness": "ready",
                "details": {"path": path}
            }
        }
    var packed := resource as PackedScene
    if not packed.can_instantiate():
        return {
            "_gofer_error": {
                "code": "invalid_scene",
                "message": "%s cannot be instantiated; one of its nodes names a type this editor does not have" % path,
                "retryable": false,
                "readiness": "ready",
                "details": {"path": path}
            }
        }

    # `GEN_EDIT_STATE_INSTANCE` is what makes this an instance rather than a copy: the scene keeps a
    # reference to the file, so the children collapse into one `instance=ExtResource(…)` line and an
    # edit to the source reaches every placement of it.
    var node: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
    if node == null:
        return {
            "_gofer_error": {
                "code": "invalid_scene",
                "message": "%s produced no node" % path,
                "retryable": false,
                "readiness": "ready",
                "details": {"path": path}
            }
        }
    if not node_name.is_empty():
        node.name = node_name

    var root := _edited_root()
    var undo := _begin_action("Instantiate %s" % path.get_file())
    undo.add_do_method(self, "_do_attach", parent, node, root, index)
    undo.add_undo_method(self, "_do_detach", parent, node)
    undo.add_do_reference(node)
    undo.commit_action()

    var attached := _attached_node(parent, node, root, "node.instantiate", {"path": path})
    if attached.has("_gofer_error"):
        return attached
    # Read-back: the placed node has to still name the file it was instanced from, or it is a copy
    # of that scene rather than an instance of it, and an edit to the source reaches none of them.
    var instanced := String(node.scene_file_path)
    if instanced != path:
        return _readback_error(
            "node.instantiate",
            path,
            instanced if not instanced.is_empty() else "a plain copy",
            {"path": path}
        )

    _bump_revision()
    return {"node": _node_path(node), "path": path}

## Why a scene may not be instantiated here, or "" when it may.
##
## A scene that reaches itself cannot be loaded again once it is saved — the editor recurses until
## it runs out of stack — and the failure lands on whoever opens the file next, not on the call that
## caused it. Dependencies are followed, because A holding B holding A is the same trap.
func _instance_cycle(path: String) -> String:
    if _current_scene_path.is_empty():
        return ""
    if path == _current_scene_path:
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
            if resolved == _current_scene_path:
                return "%s depends on %s, so instantiating it here would make the scene contain itself" % [next, _current_scene_path]
            if resolved.ends_with(".tscn") or resolved.ends_with(".scn"):
                pending.append(resolved)
    return ""

func _node_duplicate(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")
    var new_name: String = params.get("name", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.duplicate requires node",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    var parent := node.get_parent()
    var index := node.get_index()
    var copy := node.duplicate()
    if not new_name.is_empty():
        copy.name = new_name

    var root := _edited_root()
    var undo := _begin_action("Duplicate %s" % node.name)
    undo.add_do_method(self, "_do_attach", parent, copy, root, index + 1)
    undo.add_undo_method(self, "_do_detach", parent, copy)
    undo.add_do_reference(copy)
    undo.commit_action()

    var attached := _attached_node(parent, copy, root, "node.duplicate", {"node": node_path_str})
    if attached.has("_gofer_error"):
        return attached

    _bump_revision()
    return {"node": _node_path(copy)}

func _node_rename(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")
    var new_name: String = params.get("name", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty() or new_name.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.rename requires node and name",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    var old_name := String(node.name)

    var undo := _begin_action("Rename %s" % old_name)
    undo.add_do_method(node, "set_name", new_name)
    undo.add_undo_method(node, "set_name", old_name)
    undo.commit_action()

    # Read-back: what the node is called now. Godot rewrites a name with a character it will not
    # take and appends a suffix to one a sibling already has, so the name asked for is not always
    # the name the caller has to address the node by afterwards.
    var named := String(node.name)
    if named != new_name:
        return _readback_error("node.rename", new_name, named, {"node": node_path_str})

    _bump_revision()
    return {"node": _node_path(node)}

func _node_reparent(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")
    var new_parent_path: String = params.get("newParent", "")
    var index: int = params.get("index", -1)

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty() or new_parent_path.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.reparent requires node and newParent",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    var new_parent := _find_node(new_parent_path)
    if new_parent == null:
        return _node_not_found_error(new_parent_path)

    var old_parent := node.get_parent()
    var old_index := node.get_index()
    var root := _edited_root()

    var undo := _begin_action("Reparent %s" % node.name)
    undo.add_do_method(self, "_do_reparent", node, new_parent, root, index)
    undo.add_undo_method(self, "_undo_reparent", node, old_parent, root, old_index)
    undo.add_undo_reference(node)
    undo.commit_action()

    var attached := _attached_node(
        new_parent, node, root, "node.reparent", {"node": node_path_str}
    )
    if attached.has("_gofer_error"):
        return attached

    _bump_revision()
    return {"node": _node_path(node)}

func _node_delete(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.delete requires node",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    var parent := node.get_parent()
    var index := node.get_index()
    var root := _edited_root()

    var undo := _begin_action("Delete %s" % node.name)
    undo.add_do_method(self, "_do_detach", parent, node)
    undo.add_undo_method(self, "_do_attach", parent, node, root, index)
    undo.add_undo_reference(node)
    undo.commit_action()

    # Read-back: the path has to resolve to nothing in the edited tree. `deleted: true` about a node
    # the scene still holds is the whole shape this refactor removes.
    var lingering := _find_node(node_path_str)
    if lingering != null:
        return _readback_error(
            "node.delete", "nothing at %s" % node_path_str, lingering.name, {"node": node_path_str}
        )

    _bump_revision()
    return {"deleted": true}

func _node_set_property(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")
    var property: String = params.get("property", "")
    var value: Variant = params.get("value", null)

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty() or property.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.set_property requires node, property, and value",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    if not (property in node):
        return {
            "_gofer_error": {
                "code": "property_not_found",
                "message": "Node %s has no property %s" % [node_path_str, property],
                "retryable": false,
                "readiness": "ready",
                "details": {"property": property}
            }
        }

    var decoded := Protocol.decode(value)
    if not decoded["ok"]:
        return {
            "_gofer_error": {
                "code": "unsupported_value",
                "message": decoded["message"],
                "retryable": false,
                "readiness": "ready",
                "details": {"property": property}
            }
        }
    var fitted := _fit_to_property(node, property, decoded["value"])
    if not fitted["ok"]:
        return {
            "_gofer_error": {
                "code": "type_mismatch",
                "message": "%s.%s: %s" % [node_path_str, property, fitted["message"]],
                "retryable": false,
                "readiness": "ready",
                "details": {"property": property}
            }
        }
    var new_value: Variant = fitted["value"]

    var old_value: Variant = node.get(property)
    var undo := _begin_action("Set %s.%s" % [node.name, property])
    undo.add_do_method(node, "set", property, new_value)
    undo.add_undo_method(node, "set", property, old_value)
    undo.commit_action()

    # Read-back: the property as the node answers it now. `Object.set` takes a value a setter then
    # ignores, clamps or replaces, and there is no error when it does.
    var stored: Variant = node.get(property)
    if not _same_value(new_value, stored):
        return _readback_error(
            "node.set_property %s.%s" % [node_path_str, property],
            new_value,
            stored,
            {"node": node_path_str, "property": property}
        )

    _bump_revision()
    return {"node": _node_path(node), "property": property, "value": Protocol.encode(stored)}

## Sets several properties at once, across as many nodes as the caller names.
##
## The batching twin of `node.set_property`, and the same bargain `_node_create_nodes` makes: one
## revision in, one out, one undo step. A measured turn spent 65 property writes as 65 asks, each one
## waiting on the model for the revision the last one answered with.
##
## Failure is all-or-nothing. Every entry is resolved, decoded and fitted to its property before a
## single value is written, so an entry naming a property a node does not have stops the command with
## the scene untouched — rather than leaving the caller to work out which half of its list landed.
func _node_set_properties(params: Dictionary) -> Dictionary:
    var scene_check := _require_current_scene(String(params.get("scene", "")))
    if not scene_check.is_empty():
        return scene_check

    var raw: Variant = params.get("properties", null)
    if typeof(raw) != TYPE_ARRAY or (raw as Array).is_empty():
        return Params.error(
            "invalid_params",
            (
                "node.set_properties requires properties: a list of {node, property, value} "
                + "entries, the same three node.set_property takes."
            )
        )
    var entries: Array = raw
    if entries.size() > MAX_BATCH_ENTRIES:
        return Params.error(
            "too_many_entries",
            (
                "One command writes at most %d properties, and this asks for %d"
                % [MAX_BATCH_ENTRIES, entries.size()]
            ),
            {"limit": MAX_BATCH_ENTRIES}
        )

    var plan: Array = []
    # What each property should read as afterwards, keyed by the node and the property. Two entries
    # may name the same one, and the last write is what decided it, so the read-back is checked
    # against this rather than against every entry that passed over it.
    var expected: Dictionary = {}
    for entry in entries:
        if typeof(entry) != TYPE_DICTIONARY:
            return Params.error(
                "invalid_params",
                "Each properties entry is an object, and %s is not one" % str(entry)
            )
        var spec: Dictionary = entry
        var node_path_str := String(spec.get("node", ""))
        var property := String(spec.get("property", ""))
        if node_path_str.is_empty() or property.is_empty():
            return Params.error(
                "invalid_params", "Each properties entry requires node, property, and value"
            )
        var node := _find_node(node_path_str)
        if node == null:
            return _node_not_found_error(node_path_str)
        if not (property in node):
            return Params.error(
                "property_not_found",
                "Node %s has no property %s" % [node_path_str, property],
                {"property": property}
            )
        var decoded := Protocol.decode(spec.get("value", null))
        if not decoded["ok"]:
            return Params.error("unsupported_value", decoded["message"], {"property": property})
        var fitted := _fit_to_property(node, property, decoded["value"])
        if not fitted["ok"]:
            return Params.error(
                "type_mismatch",
                "%s.%s: %s" % [node_path_str, property, fitted["message"]],
                {"property": property}
            )
        plan.append([node, property, fitted["value"], node.get(property)])
        expected["%d\n%s" % [node.get_instance_id(), property]] = [
            node, node_path_str, property, fitted["value"]
        ]

    var undo := _begin_action("Set %d properties" % plan.size())
    for step in plan:
        undo.add_do_method(step[0], "set", step[1], step[2])
        undo.add_undo_method(step[0], "set", step[1], step[3])
    undo.commit_action()

    # Read-back: the property as the node answers it now, for the same reason the single write does
    # it. `Object.set` takes a value a setter then ignores, clamps or replaces, with no error.
    var written: Array = []
    for key in expected:
        var wanted: Array = expected[key]
        var node: Node = wanted[0]
        var property: String = wanted[2]
        var stored: Variant = node.get(property)
        if not _same_value(wanted[3], stored):
            return _readback_error(
                "node.set_properties %s.%s" % [wanted[1], property],
                wanted[3],
                stored,
                {"node": wanted[1], "property": property}
            )
        written.append(
            {
                "node": _node_path(node),
                "property": property,
                "value": Protocol.encode(stored)
            }
        )

    _bump_revision()
    return {"properties": written}

## Puts a node in a group, the way the editor's Node dock does.
##
## The group is always persistent: a group added without that flag is dropped when the scene is
## packed, so a caller that asked for one and saved would get a scene that no longer has it.
func _node_add_to_group(params: Dictionary) -> Dictionary:
    var found := _group_target(params, "node.add_to_group")
    if found.has("_gofer_error"):
        return found
    var node: Node = found["node"]
    var group: String = found["group"]
    if node.is_in_group(group):
        return {"node": _node_path(node), "groups": _authored_groups(node)}

    var undo := _begin_action("Add %s to %s" % [node.name, group])
    undo.add_do_method(node, "add_to_group", group, true)
    undo.add_undo_method(node, "remove_from_group", group)
    undo.commit_action()

    # Read-back: the node's own membership, which is also what the reply lists.
    if not node.is_in_group(group):
        return _readback_error(
            "node.add_to_group", group, ", ".join(_authored_groups(node)), {"group": group}
        )

    _bump_revision()
    return {"node": _node_path(node), "groups": _authored_groups(node)}

func _node_remove_from_group(params: Dictionary) -> Dictionary:
    var found := _group_target(params, "node.remove_from_group")
    if found.has("_gofer_error"):
        return found
    var node: Node = found["node"]
    var group: String = found["group"]
    if not node.is_in_group(group):
        return {
            "_gofer_error": {
                "code": "group_not_found",
                "message": "Node %s is not in the group %s" % [_node_path(node), group],
                "retryable": false,
                "readiness": "ready",
                "details": {"group": group}
            }
        }

    var undo := _begin_action("Remove %s from %s" % [node.name, group])
    undo.add_do_method(node, "remove_from_group", group)
    undo.add_undo_method(node, "add_to_group", group, true)
    undo.commit_action()

    # Read-back: the group has to be gone from the node, not only from this call's intent.
    if node.is_in_group(group):
        return _readback_error(
            "node.remove_from_group",
            "no %s" % group,
            ", ".join(_authored_groups(node)),
            {"group": group}
        )

    _bump_revision()
    return {"node": _node_path(node), "groups": _authored_groups(node)}

## Paints tiles onto a TileMapLayer in the edited scene.
##
## A layer's cells are not a property: they live in `tile_map_data`, a packed blob the scene writes
## as base64, so there is no way to place a tile with `node.set_property` and no way to write one by
## hand. Rectangles are taken as rectangles — a ground row is one entry rather than two hundred —
## because a level's worth of single cells is what makes a model give up and lay ColorRects instead.
func _node_set_cells(params: Dictionary) -> Dictionary:
    var resolved := _cell_target(params, "node.set_cells")
    if resolved.has("_gofer_error"):
        return resolved
    var layer: TileMapLayer = resolved["layer"]
    var tile_set: TileSet = layer.tile_set
    if tile_set == null:
        return Params.error(
            "tileset_missing",
            (
                "TileMapLayer %s has no tile_set. Create one with resource.create_tileset, then set "
                + "this node's tile_set property to it, and the cells will have tiles to name."
            ) % _node_path(layer),
            {"node": _node_path(layer)}
        )

    var raw: Variant = params.get("cells", null)
    if typeof(raw) != TYPE_ARRAY or (raw as Array).is_empty():
        return Params.error(
            "invalid_params",
            (
                "node.set_cells requires cells: a list of {x, y, width?, height?, atlas?, source?} "
                + "entries. width and height default to 1, and an entry with no atlas erases the "
                + "cells it covers."
            )
        )

    var default_source := tile_set.get_source_id(0) if tile_set.get_source_count() > 0 else -1
    var plan: Array = []
    for entry in raw as Array:
        if typeof(entry) != TYPE_DICTIONARY:
            return Params.error(
                "invalid_params",
                "Each cells entry is an object, and %s is not one" % str(entry)
            )
        var cell: Dictionary = entry
        if not (cell.has("x") and cell.has("y")):
            return Params.error("invalid_params", "Each cells entry requires x and y")
        var origin := Vector2i(int(cell.get("x", 0)), int(cell.get("y", 0)))
        var width := int(cell.get("width", 1))
        var height := int(cell.get("height", 1))
        if width < 1 or height < 1:
            return Params.error(
                "invalid_params",
                "A cells entry covers at least one cell, and %dx%d covers none" % [width, height]
            )
        var source_id := -1
        var atlas := Vector2i(-1, -1)
        var alternative := -1
        if cell.has("atlas") and cell["atlas"] != null:
            var named: Variant = cell["atlas"]
            if typeof(named) != TYPE_ARRAY or (named as Array).size() != 2:
                return Params.error(
                    "invalid_params",
                    "A cells entry's atlas is a [column, row] pair, and %s is not one" % str(named)
                )
            atlas = Vector2i(int((named as Array)[0]), int((named as Array)[1]))
            source_id = int(cell.get("source", default_source))
            alternative = int(cell.get("alternative", 0))
            var check := _require_tile(tile_set, source_id, atlas)
            if check.has("_gofer_error"):
                return check
        plan.append([origin, width, height, source_id, atlas, alternative])

    var cells: Array = []
    # What each covered cell should read as afterwards. Entries may overlap, and the last write to a
    # cell is the one that decided it, so the read-back is checked against this rather than against
    # every entry that passed over it.
    var expected: Dictionary = {}
    var painted := 0
    var erased := 0
    for step in plan:
        var origin: Vector2i = step[0]
        for offset_y in range(step[2]):
            for offset_x in range(step[1]):
                var at := Vector2i(origin.x + offset_x, origin.y + offset_y)
                cells.append([at, step[3], step[4], step[5]])
                expected[at] = [step[3], step[4]]
                if step[3] < 0:
                    erased += 1
                else:
                    painted += 1
                if cells.size() > MAX_PAINTED_CELLS:
                    return Params.error(
                        "too_many_cells",
                        (
                            "One paint writes at most %d cells, and these entries cover more"
                            % MAX_PAINTED_CELLS
                        ),
                        {"limit": MAX_PAINTED_CELLS}
                    )

    var previous: Array = []
    for cell in cells:
        var coords: Vector2i = cell[0]
        previous.append(
            [
                coords,
                layer.get_cell_source_id(coords),
                layer.get_cell_atlas_coords(coords),
                layer.get_cell_alternative_tile(coords)
            ]
        )

    var undo := _begin_action("Paint %d cells on %s" % [cells.size(), layer.name])
    undo.add_do_method(self, "_do_paint_cells", layer, cells)
    undo.add_undo_method(self, "_do_paint_cells", layer, previous)
    undo.commit_action()

    # Read-back: every covered cell, asked of the layer again. `set_cell` takes a coordinate the
    # tileset does not define and leaves the cell empty, so a paint that wrote nowhere reports the
    # same tally as one that worked.
    for at in expected:
        var coords: Vector2i = at
        var wanted: Array = expected[at]
        var source := layer.get_cell_source_id(coords)
        if source != int(wanted[0]):
            return _readback_error(
                "node.set_cells source at (%d, %d)" % [coords.x, coords.y],
                wanted[0],
                source,
                {"node": _node_path(layer)}
            )
        if source < 0:
            continue
        var drawn := layer.get_cell_atlas_coords(coords)
        if drawn != wanted[1]:
            return _readback_error(
                "node.set_cells atlas at (%d, %d)" % [coords.x, coords.y],
                wanted[1],
                drawn,
                {"node": _node_path(layer)}
            )

    _bump_revision()
    return _cells_summary(layer).merged({"painted": painted, "erased": erased})

## Reports the cells a TileMapLayer holds, which is the only way to read back what a paint wrote.
func _node_get_cells(params: Dictionary) -> Dictionary:
    var resolved := _cell_target(params, "node.get_cells")
    if resolved.has("_gofer_error"):
        return resolved
    var layer: TileMapLayer = resolved["layer"]
    var limit := int(params.get("limit", MAX_REPORTED_TILES))
    limit = clampi(limit, 1, MAX_REPORTED_TILES)
    var listed: Array = []
    var used := layer.get_used_cells()
    # Which tiles were painted, counted. A level is longer than any list a response can carry, and
    # the tally is what says a layer holds pipes and a flag rather than only the ground row that
    # happens to come first.
    var tally: Dictionary = {}
    for coords in used:
        var atlas := layer.get_cell_atlas_coords(coords)
        var key := "%d,%d" % [atlas.x, atlas.y]
        tally[key] = int(tally.get(key, 0)) + 1
        if listed.size() >= limit:
            continue
        listed.append(
            {
                "x": coords.x,
                "y": coords.y,
                "source": layer.get_cell_source_id(coords),
                "atlas": [atlas.x, atlas.y],
                "alternative": layer.get_cell_alternative_tile(coords),
            }
        )
    var tiles: Array = []
    for key in tally:
        var pair: PackedStringArray = str(key).split(",")
        tiles.append({"atlas": [int(pair[0]), int(pair[1])], "count": tally[key]})
    return _cells_summary(layer).merged(
        {"cellsListed": listed, "tiles": tiles, "truncated": used.size() > listed.size()}
    )

## What both cell commands answer with: where the layer's tiles are and what draws them.
func _cells_summary(layer: TileMapLayer) -> Dictionary:
    var rect := layer.get_used_rect()
    var tile_set: TileSet = layer.tile_set
    return {
        "node": _node_path(layer),
        "cells": layer.get_used_cells().size(),
        "usedRect": [rect.position.x, rect.position.y, rect.size.x, rect.size.y],
        "tileSet": tile_set.resource_path if tile_set != null else "",
    }

## The TileMapLayer a cell command names, or the error that says why it is not one.
func _cell_target(params: Dictionary, command: String) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty():
        return Params.error("invalid_params", "%s requires node" % command)
    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    if not (node is TileMapLayer):
        return Params.error(
            "wrong_node_type",
            (
                "%s is a %s, and cells belong to a TileMapLayer. Create one with node.create and "
                + "give it a tile_set."
            ) % [_node_path(node), node.get_class()],
            {"node": _node_path(node), "type": node.get_class()}
        )
    return {"layer": node}

## Checks that a tile a paint names is one the tileset actually defines.
##
## `set_cell` takes an atlas coordinate no tile occupies without complaint and draws nothing there,
## so a whole level can be painted out of tiles that do not exist and look like an empty layer.
func _require_tile(tile_set: TileSet, source_id: int, atlas: Vector2i) -> Dictionary:
    if not tile_set.has_source(source_id):
        var available: Array = []
        for index in range(tile_set.get_source_count()):
            available.append(tile_set.get_source_id(index))
        return Params.error(
            "source_not_found",
            "The tileset has no source %d; it has %s" % [source_id, str(available)],
            {"source": source_id, "sources": available}
        )
    var source := tile_set.get_source(source_id)
    if not source.has_tile(atlas):
        return Params.error(
            "tile_not_defined",
            (
                "The tileset's source %d defines no tile at (%d, %d). resource.describe_tileset "
                + "lists the tiles it does define."
            ) % [source_id, atlas.x, atlas.y],
            {"source": source_id, "tile": [atlas.x, atlas.y]}
        )
    return {}

## Writes a list of [coords, source, atlas, alternative] cells, which is both halves of the undo.
func _do_paint_cells(layer: TileMapLayer, cells: Array) -> void:
    for cell in cells:
        layer.set_cell(cell[0], cell[1], cell[2], cell[3])

## The groups a person put a node in, which is not everything `get_groups` answers.
##
## The engine keeps its own groups on a node and marks them with a leading underscore: a CanvasItem
## in the editor's viewport is in `_root_canvas…`, named after an object id that changes every
## session. Reporting those alongside "coins" makes a caller's own wiring hard to find, and a model
## reading a group it never added has no way to know it is not one of its own.
func _authored_groups(node: Node) -> Array:
    var authored: Array = []
    for group in node.get_groups():
        if not str(group).begins_with("_"):
            authored.append(str(group))
    return authored

## The node and group both group commands take, or the error that says which one was wrong.
func _group_target(params: Dictionary, command: String) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")
    var group: String = params.get("group", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty() or group.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "%s requires node and group" % command,
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    return {"node": node, "group": group}

## Connects one node's signal to a method on another, as an editor connection the scene keeps.
##
## `Object.connect` accepts a method the target does not have and reports the mistake only when the
## signal first fires — in a running game, as a crash with no author. The method is therefore
## checked here, which is also what the editor's own connect dialog does before it offers to write
## the handler for you.
func _node_connect_signal(params: Dictionary) -> Dictionary:
    var resolved := _connection_target(params, "node.connect_signal")
    if resolved.has("_gofer_error"):
        return resolved
    var node: Node = resolved["node"]
    var target: Node = resolved["target"]
    var signal_name: String = resolved["signal"]
    var method: String = resolved["method"]
    if not target.has_method(method):
        return {
            "_gofer_error": {
                "code": "method_not_found",
                "message": "%s has no method %s to receive %s" % [_node_path(target), method, signal_name],
                "retryable": false,
                "readiness": "ready",
                "details": {"target": _node_path(target), "method": method}
            }
        }

    var bound := Protocol.decode_items(params.get("binds", []))
    if not bound["ok"]:
        return {
            "_gofer_error": {
                "code": "unsupported_value",
                "message": bound["message"],
                "retryable": false,
                "readiness": "ready",
                "details": {"signal": signal_name}
            }
        }
    var callable := Callable(target, method).bindv(bound["value"])
    if node.is_connected(signal_name, callable):
        return {
            "_gofer_error": {
                "code": "already_connected",
                "message": "%s.%s is already connected to %s.%s" % [_node_path(node), signal_name, _node_path(target), method],
                "retryable": false,
                "readiness": "ready",
                "details": {"signal": signal_name, "target": _node_path(target), "method": method}
            }
        }

    # `Object.CONNECT_PERSIST` is what makes a connection part of the scene rather than a passing
    # thought: without it the connection works in the editor and is dropped when the scene is
    # packed, which is the same failure as a collision shape with no shape in it — the editor looks
    # right and the game does nothing. Every connection made here therefore carries it.
    var flags := Object.CONNECT_PERSIST
    if bool(params.get("deferred", false)):
        flags |= Object.CONNECT_DEFERRED
    if bool(params.get("oneShot", false)):
        flags |= Object.CONNECT_ONE_SHOT

    var undo := _begin_action("Connect %s.%s" % [node.name, signal_name])
    undo.add_do_method(node, "connect", signal_name, callable, flags)
    undo.add_undo_method(node, "disconnect", signal_name, callable)
    undo.commit_action()

    # Read-back: the live connection, and the flags Godot recorded for it rather than the ones this
    # call asked for. A connection made without CONNECT_PERSIST works in the editor and is dropped
    # when the scene is packed, which is the same lie as a save that wrote nothing.
    if not node.is_connected(signal_name, callable):
        return _readback_error(
            "node.connect_signal",
            "%s.%s connected to %s" % [_node_path(node), signal_name, method],
            "not connected",
            {"signal": signal_name, "target": _node_path(target), "method": method}
        )
    var recorded := _connection_flags(node, signal_name, callable)
    if recorded != flags:
        return _readback_error(
            "node.connect_signal flags", flags, recorded, {"signal": signal_name}
        )

    _bump_revision()
    return _connection_summary(node, signal_name, callable, recorded)

func _node_disconnect_signal(params: Dictionary) -> Dictionary:
    var resolved := _connection_target(params, "node.disconnect_signal")
    if resolved.has("_gofer_error"):
        return resolved
    var node: Node = resolved["node"]
    var target: Node = resolved["target"]
    var signal_name: String = resolved["signal"]
    var method: String = resolved["method"]

    # The bound arguments are part of a callable's identity, so a connection made with them can only
    # be found by naming them again — which is why they are read back by `node.inspect`.
    var bound := Protocol.decode_items(params.get("binds", []))
    if not bound["ok"]:
        return {
            "_gofer_error": {
                "code": "unsupported_value",
                "message": bound["message"],
                "retryable": false,
                "readiness": "ready",
                "details": {"signal": signal_name}
            }
        }
    var callable := Callable(target, method).bindv(bound["value"])
    if not node.is_connected(signal_name, callable):
        return {
            "_gofer_error": {
                "code": "not_connected",
                "message": "%s.%s is not connected to %s.%s" % [_node_path(node), signal_name, _node_path(target), method],
                "retryable": false,
                "readiness": "ready",
                "details": {"signal": signal_name, "target": _node_path(target), "method": method}
            }
        }
    var flags := _connection_flags(node, signal_name, callable)

    var undo := _begin_action("Disconnect %s.%s" % [node.name, signal_name])
    undo.add_do_method(node, "disconnect", signal_name, callable)
    undo.add_undo_method(node, "connect", signal_name, callable, flags)
    undo.commit_action()

    # Read-back: the connection has to be gone before the reply says it is.
    var connected := node.is_connected(signal_name, callable)
    if connected:
        return _readback_error(
            "node.disconnect_signal",
            "%s.%s disconnected from %s" % [_node_path(node), signal_name, method],
            "still connected",
            {"signal": signal_name, "target": _node_path(target), "method": method}
        )

    _bump_revision()
    return {"node": _node_path(node), "signal": signal_name, "connected": connected}

## The node, target, signal and method both connection commands take.
##
## `target` may be omitted, and then means the scene root — the node that carries the scene's script
## and receives its connections in every ordinary Godot scene.
func _connection_target(params: Dictionary, command: String) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")
    var signal_name: String = params.get("signal", "")
    var method: String = params.get("method", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty() or signal_name.is_empty() or method.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "%s requires node, signal, and method" % command,
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    if not node.has_signal(signal_name):
        return {
            "_gofer_error": {
                "code": "signal_not_found",
                "message": "Node %s has no signal %s" % [node_path_str, signal_name],
                "retryable": false,
                "readiness": "ready",
                "details": {"signal": signal_name}
            }
        }
    var target_path: String = params.get("target", "")
    var target := _edited_root() if target_path.is_empty() else _find_node(target_path)
    if target == null:
        return _node_not_found_error(target_path)
    return {"node": node, "target": target, "signal": signal_name, "method": method}

## The flags a live connection carries, so undoing a disconnection restores the same one.
func _connection_flags(node: Node, signal_name: String, callable: Callable) -> int:
    for connection in node.get_signal_connection_list(signal_name):
        if (connection.get("callable", Callable()) as Callable) == callable:
            return int(connection.get("flags", Object.CONNECT_PERSIST))
    return Object.CONNECT_PERSIST

func _connection_summary(node: Node, signal_name: String, callable: Callable, flags: int) -> Dictionary:
    var target := callable.get_object() as Node
    return {
        "node": _node_path(node),
        "signal": signal_name,
        "target": _scene_relative_path(target),
        "method": String(callable.get_method()),
        "binds": Protocol.encode_items(callable.get_bound_arguments()),
        "deferred": (flags & Object.CONNECT_DEFERRED) != 0,
        "oneShot": (flags & Object.CONNECT_ONE_SHOT) != 0,
        "persistent": (flags & Object.CONNECT_PERSIST) != 0
    }

## A connection's target as the scene names it, or as the tree does when it is not in the scene.
##
## `_node_path` answers by trimming the edited root's path off the front, which says nothing useful
## about a node that is not under it — and a live connection can point anywhere.
func _scene_relative_path(node: Node) -> String:
    if node == null:
        return ""
    var root := _edited_root()
    if root == null or not (node == root or root.is_ancestor_of(node)):
        return String(node.get_path())
    return _node_path(node)

## The signals a node can emit, named the way `node.connect_signal` takes them.
##
## A caller that cannot see this list has to guess a signal name, and `signal_not_found` is all the
## help a guess gets — so the names come back with the node rather than from the documentation.
func _node_signals(node: Node) -> Array:
    var names: Array = []
    for info in node.get_signal_list():
        names.append(String(info.get("name", "")))
    names.sort()
    return names

## The scene's own connections out of a node, in the shape `node.connect_signal` accepts back.
##
## Only the persistent ones. The editor is itself connected to every node it is showing — the scene
## tree dock listens for `script_changed`, `visibility_changed` and four more on each of them — and
## those are the editor's private business, live only while the dock exists, and pointed at objects
## that are not in the scene at all. Reporting them buried the one connection a caller made under
## six it did not, and named a target that has no path in the edited scene.
func _node_connections(node: Node) -> Array:
    var connections: Array = []
    for info in node.get_signal_list():
        var signal_name := String(info.get("name", ""))
        for connection in node.get_signal_connection_list(signal_name):
            var flags := int(connection.get("flags", 0))
            if (flags & Object.CONNECT_PERSIST) == 0:
                continue
            var callable := connection.get("callable", Callable()) as Callable
            connections.append(_connection_summary(node, signal_name, callable, flags))
    return connections

func _node_inspect(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty():
        return {
            "_gofer_error": {
                "code": "invalid_params",
                "message": "node.inspect requires node",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    return {
        "name": node.name,
        "type": node.get_class(),
        "path": _node_path(node),
        "properties": _node_properties(node),
        "groups": _authored_groups(node),
        "signals": _node_signals(node),
        "connections": _node_connections(node),
    }

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
func _node_properties(node: Node) -> Array:
    var properties: Array = []
    for info in node.get_property_list():
        var usage := int(info.get("usage", 0))
        if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
            continue
        if not (usage & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR)):
            continue
        var property_name := str(info.get("name", ""))
        if property_name.is_empty() or property_name == "script":
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

## Checks that a request names the scene the editor is actually editing.
##
## An omitted name means "whatever is open", which is what a caller that has just read the tree is
## asking for. Demanding it left the AI tools unusable: their catalog documents no `scene` parameter
## at all, so every authoring call arrived without one and was refused against the empty string.
## `expectedRevision` still carries the real protection — a scene that changed under the caller is
## refused whether or not it was named.
func _require_current_scene(scene: String) -> Dictionary:
    if scene.is_empty():
        return {}
    if scene != _current_scene_path:
        return {
            "_gofer_error": {
                "code": "wrong_scene",
                "message": "The request targets %s but the active scene is %s" % [scene, _current_scene_path],
                "retryable": false,
                "readiness": "ready",
                "details": {"expected": scene, "current": _current_scene_path}
            }
        }
    return {}

func _do_attach(parent: Node, child: Node, owner: Node, index: int) -> void:
    parent.add_child(child, true)
    if owner != null:
        child.set_owner(owner)
    if index >= 0 and index < parent.get_child_count():
        parent.move_child(child, index)

func _do_detach(parent: Node, child: Node) -> void:
    if child.get_parent() == parent:
        parent.remove_child(child)

func _do_reparent(node: Node, new_parent: Node, owner: Node, index: int) -> void:
    var old_parent := node.get_parent()
    if old_parent != null:
        old_parent.remove_child(node)
    new_parent.add_child(node, true)
    if owner != null:
        node.set_owner(owner)
    if index >= 0 and index < new_parent.get_child_count():
        new_parent.move_child(node, index)

func _undo_reparent(node: Node, old_parent: Node, owner: Node, old_index: int) -> void:
    var current_parent := node.get_parent()
    if current_parent != null:
        current_parent.remove_child(node)
    old_parent.add_child(node, true)
    if owner != null:
        node.set_owner(owner)
    if old_index >= 0 and old_index < old_parent.get_child_count():
        old_parent.move_child(node, old_index)

func _node_not_found_error(path: String) -> Dictionary:
    return {
        "_gofer_error": {
            "code": "node_not_found",
            "message": "Node %s was not found in the edited scene" % path,
            "retryable": false,
            "readiness": "ready",
            "details": {"path": path}
        }
    }

func _edited_root() -> Node:
    return EditorInterface.get_edited_scene_root()

func _find_node(path: String) -> Node:
    var root := _edited_root()
    if root == null:
        return null
    if path == root.name or path == "/" + root.name or path == "":
        return root
    var relative := path
    if relative.begins_with("/"):
        relative = relative.substr(1)
    if relative.begins_with(root.name + "/"):
        relative = relative.substr(root.name.length() + 1)
    return root.get_node_or_null(NodePath(relative))

func _node_path(node: Node) -> String:
    var root := _edited_root()
    if node == root:
        return "/" + root.name
    var path := node.get_path()
    var root_path := root.get_path()
    var relative := String(path).substr(String(root_path).length())
    return "/" + root.name + relative

func _node_summary(node: Node) -> Dictionary:
    var children: Array[Dictionary] = []
    for i in range(node.get_child_count()):
        children.append(_node_summary(node.get_child(i)))
    return {
        "name": node.name,
        "type": node.get_class(),
        "icon": _node_icon_class(node),
        "path": _node_path(node),
        "children": children
    }

## The class an icon lookup should use for a node: the script's own class where it has one, since
## that is the icon the editor draws, and the engine class otherwise.
func _node_icon_class(node: Node) -> String:
    var script: Variant = node.get_script()
    if script is Script:
        var global_name := (script as Script).get_global_name()
        if not global_name.is_empty():
            return global_name
    return node.get_class()



## Fits a decoded value onto the type the node declares the property with.
##
## `Object.set` takes what it is given for a property whose type the engine does not enforce: a
## `res://…` path written as a string landed in a CollisionShape2D's `shape` and was saved into the
## scene, which then opened with a String where a Shape2D belongs. What the node says the property
## is, is therefore checked before the value reaches it, so a mistyped write is an error naming the
## type it wanted rather than a level that will not run.
func _fit_to_property(node: Node, property: String, value: Variant) -> Dictionary:
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

func _send_event(event: String, data: Dictionary) -> void:
    var envelope := {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "event",
        "id": _session_id,
        "sequence": _next_sequence(),
        "event": event,
        "data": data
    }
    _put_json(envelope)

# Sequences start at 0 and increase by one per session, so Gofer can spot a dropped event as a gap.
var _sequence: int = 0
func _next_sequence() -> int:
    var sequence := _sequence
    _sequence += 1
    return sequence

func _put_json(value: Variant) -> void:
    if _peer == null or _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        return
    var text := JSON.stringify(value)
    _peer.put_data((text + "\n").to_utf8_buffer())
