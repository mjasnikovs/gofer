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
const ProjectConfig := preload("res://addons/gofer/project_config.gd")
const RuntimeQueue := preload("res://addons/gofer/runtime_queue.gd")

var _peer: StreamPeerTCP
var _status: int = -1
## The bytes of the request line being read, decoded only once the whole line is in.
##
## Bytes, not a String. This was `_pending_line += String.chr(byte)`, which reads each byte as a
## Unicode code point: `ü` arrives as the two bytes C3 BC and came out as two characters, so a node
## called `Münze` was created, read back mangled, and could not be named again. Every non-ASCII name,
## label or string value went through this. `get_string_from_utf8` decodes the line as what it is.
var _pending_bytes: PackedByteArray = PackedByteArray()
var _ready_notified: bool = false
var _readiness: String = "starting"
## Frames the editor has been settled without opening the scene it opens for itself. See
## `STARTUP_OPEN_SETTLED_FRAMES`.
var _startup_open_settled_frames: int = 0
## The dialog the last `session.dialog` event described, as text. Empty means none was open.
var _reported_dialog: String = ""
var _session_id: String = "gofer-session"

var _current_scene_path: String = ""
var _scene_revision: int = 0
var _playing: bool = false

var _tree_nodes_seen: int = 0
var _tree_truncated: bool = false
var _tree_budget: int = MAX_TREE_NODES
var _tree_depth: int = MAX_TREE_DEPTH

var _scene_pending: Array[Dictionary] = []

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


## A scene switch outlives a cold import of everything the scene depends on.
const SCENE_SWITCH_TIMEOUT_MS := 30000
## How often a scene switch the editor has not obeyed is asked for again. The editor drops the
## request while it is busy, so it has to be repeated — but a scene the editor cannot build prints
## its complaint on every attempt, and asking at frame rate turned one bad file into a thousand
## errors and a stack of modal dialogs.
const SCENE_SWITCH_RETRY_MS := 1000

## The autoloads registered while this editor session has been running.
##
## The editor's GDScript compiler resolves an autoload's name from the map it built at startup, and
## `ProjectSettings.set_setting` does not add to it — so a script naming one registered since then
## fails to compile *in the editor*, while the same script is fine in the running game. This is what
## lets a refusal say which of the two is happening. See `_reread_the_script_on`.
var _autoloads_added_here: Array[String] = []

## The scene the running game was started on, or "" for the project's own main scene.
##
## Held so `runtime.restart` restarts what is actually running rather than the project's entry
## point, which is a different game whenever `run` named a scene.
var _runtime_scene: String = ""

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
## running, and a paused game sends none. The debugger's `continued` clears it too, for the break
## that is resumed by hand and followed by nothing.
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

## The launch deadline this editor actually waits out.
##
## The constant above is what a person gets and the only value anything ships with. It is also
## thirty seconds that one acceptance test has to sit through on purpose: a game whose helper never
## announces is told apart from a dead one by the deadline expiring, so the test cannot assert the
## difference without paying for it. That one test was the whole suite's floor, hoisted to run first
## because nothing could follow it. The environment lets it buy the same proof for four seconds.
##
## Read once, here, rather than at each of the three call sites: a deadline that could change
## between the launch and the stop is a different bug to debug.
var _runtime_launch_timeout_ms: int = _configured_launch_timeout_ms()

## The forwarded-request deadline this editor actually waits out.
##
## Read from the environment for the same reason the launch one is: the acceptance suite has to
## watch a request expire, and twenty seconds a time is the whole cost of the test. Nothing ships
## with anything but the constant.
var _runtime_request_timeout_ms: int = _configured_request_timeout_ms()

static func _configured_launch_timeout_ms() -> int:
    var value := OS.get_environment("GOFER_RUNTIME_LAUNCH_TIMEOUT_MS")
    if value.is_empty():
        return RUNTIME_LAUNCH_TIMEOUT_MS
    return maxi(1, value.to_int())

static func _configured_request_timeout_ms() -> int:
    var value := OS.get_environment("GOFER_RUNTIME_REQUEST_TIMEOUT_MS")
    if value.is_empty():
        return RUNTIME_REQUEST_TIMEOUT_MS
    return maxi(1, value.to_int())

## The runtime operations that cannot answer until the game has drawn a frame.
##
## `input` waits two process frames and then a `frame_post_draw`, `capture` waits a
## `frame_post_draw`, and waiting is all `wait` does. Every other operation answers straight out of
## the debugger message pump, which the main loop polls whether or not the game is drawing — which
## is why a halted game answers `inspect_node` in milliseconds and leaves these three to expire.

## The pending kinds that are waiting on a game the editor has already been told to start, and so
## are ended by that game dying. `restart` is not one of them: it is waiting for the *previous*
## game to go, and a stopped editor is the thing it wants.

## The commands `_handle_request` routes to the runtime bridge instead of answering synchronously.
# GENERATED-BEGIN runtime-commands sha256:b96ac9e0ddcf0feb
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
    "runtime.wait",
    "runtime.pause",
    "runtime.resume",
]
# GENERATED-END runtime-commands

## The plugin's own directory name, protected so a configuration command cannot sever the session
## that carries it.
const GOFER_PLUGIN_NAME := "gofer"
## The autoload Gofer stages; cleanup owns it, so configuration commands refuse to touch it.
const GOFER_AUTOLOAD_NAME := ProjectConfig.GOFER_AUTOLOAD_NAME
## Search results are capped so a broad query cannot exceed the 1 MiB envelope limit.
const MAX_SEARCH_RESULTS := ProjectConfig.MAX_SEARCH_RESULTS

## The bounds of a scene-tree dump, and what a call that names none answers with.
##
## The envelope is not the binding cap here. The worker holds a tool result at 24,000 characters and
## slices it there, mid-JSON, so a tree that overruns reaches the model as a fragment it cannot
## parse and without the flag that would have explained it. A live project's tree measured 116
## characters a node, 120 at the widest, so the default leaves the answer at roughly a fifth of that
## bound. A caller that wants more says so, and `root` and `depth` read a large tree a part at a
## time.
##
## The ceiling is the Explorer panel's, not the model's. This walk had no bound at all before, so a
## ceiling is a scene the panel used to draw whole and now would not; 4096 nodes is what the panel
## asks for, and about 450KB, well inside the 1 MiB envelope that ends the session if it is passed.
const MAX_TREE_NODES := 4096
const MAX_TREE_DEPTH := 32
const DEFAULT_TREE_NODES := 150

## One icon request covers a whole scene tree's worth of classes and no more, and each icon stays
## the size the editor draws it, so the batch stays far inside the envelope limit.
const MAX_ICON_CLASSES := 200
const MAX_ICON_EDGE := 64
## A script class chain is walked this far towards an engine class before the icon lookup gives up.
const MAX_ICON_BASE_DEPTH := 32

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

# GENERATED-BEGIN mutating-commands sha256:801d6dbcf7784bd2
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
    "node.change_type",
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
            var stopped := _on_session_stopped.bind(session_id)
            if not session.stopped.is_connected(stopped):
                session.stopped.connect(stopped)
            var breaked := _on_session_breaked.bind(session_id)
            if not session.breaked.is_connected(breaked):
                session.breaked.connect(breaked)
            var continued := _on_session_continued.bind(session_id)
            if not session.continued.is_connected(continued):
                session.continued.connect(continued)
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

    func _on_session_continued(session_id: int) -> void:
        var plugin = _plugin.get_ref()
        if plugin != null:
            plugin._on_runtime_debugger_session_continued(session_id)

## Points this editor's debug server at a port of its own, when the environment names one.
##
## Godot binds `network/debug/remote_port` — 6007 unless told otherwise — and tells the game it
## plays to connect to that number. A second editor playing at the same time finds 6007 taken,
## steps to 6008, and still sends its game to 6007: the game connects to the wrong editor. Nothing
## errors on either side, so the editor that launched it sits on a session that never becomes
## active until its launch deadline expires. One editor never meets this, which is why it is the
## environment that asks and the acceptance suite that sets it.
##
## `--debug-server` names the same port and was tried first. It also keeps the debug server open
## across stops, and `runtime.restart` then answered `runtime_timeout` on the CI runner in both
## jobs that run this suite — including the one that runs it a single editor at a time, where
## nothing is contending — while the two pushes before it were green. The setting alone is the
## part that was wanted.
##
## Read before the debugger is registered, because the server is started from this value the first
## time somebody presses play.
func _apply_debug_port() -> void:
    var value := OS.get_environment("GOFER_DEBUG_PORT")
    if value.is_empty():
        return
    var name := "network/debug/remote_port"
    var settings := EditorInterface.get_editor_settings()
    if not settings.has_setting(name):
        push_error("GOFER_DEBUG_PORT: this editor has no setting '%s'" % name)
        return
    var wanted := maxi(1, value.to_int())
    settings.set_setting(name, wanted)
    var stored: Variant = settings.get_setting(name)
    if stored != wanted:
        push_error("GOFER_DEBUG_PORT: %s kept %s, not %d" % [name, stored, wanted])

func _enter_tree() -> void:
    print("GOFER_ADDON_READY:%d" % PROTOCOL_VERSION)
    _apply_debug_port()
    _debugger_bridge = GoferDebuggerBridge.new(self)
    add_debugger_plugin(_debugger_bridge)
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
            _ready_notified = false
            _playing = false
            _refresh_readiness()
        return
    if status != StreamPeerTCP.STATUS_CONNECTED:
        return

    if not _ready_notified and _editor_finished_starting():
        _ready_notified = true
    _refresh_readiness()

    _track_play_state()
    _track_edited_scene()
    _track_dialog()

    var available := _peer.get_available_bytes()
    while available > 0:
        var byte := _peer.get_8()
        if byte == 10:
            var line := _pending_bytes.get_string_from_utf8()
            _pending_bytes = PackedByteArray()
            _handle_line(line)
            available = _peer.get_available_bytes()
        else:
            _pending_bytes.append(byte)
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
## The `string` field of `Engine.get_version_info()` reads "4.7.2-stable (official)" — a display
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
    var expected_scene: String = str(envelope.get("expectedScene", ""))

    var climbing := Params.a_path_that_climbs_out("", params)
    if not climbing.is_empty():
        _respond_error(
            id,
            "outside_workspace",
            (
                "%s climbs out of the project. Every path here names a file inside the task "
                + "worktree, spelled the way the project spells it, and a .. segment is refused "
                + "wherever it appears."
            ) % climbing,
            false,
            {"path": climbing}
        )
        return

    if RUNTIME_COMMANDS.has(command):
        _handle_runtime_request(id, command, params)
        return

    var result: Variant = _dispatch_command(command, params, expected_revision, expected_scene)
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

func _dispatch_command(command: String, params: Dictionary, expected_revision: Variant, expected_scene: String = "") -> Dictionary:
    if MUTATING_COMMANDS.has(command):
        var scene_check := _require_current_scene(expected_scene)
        if scene_check.has("_gofer_error"):
            return scene_check
        var check := _check_mutation_prerequisites(expected_revision)
        if check.has("_gofer_error"):
            return check
    var declared := Params.check_declared(command, params)
    if declared.has("_gofer_error"):
        return declared

# GENERATED-BEGIN dispatch-table sha256:7764e25b24871b1f
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
            return ProjectConfig.settings()
        "project.search_settings":
            return ProjectConfig.search_settings(params)
        "project.get_setting":
            return ProjectConfig.get_setting(params)
        "project.set_setting":
            return ProjectConfig.set_setting(params)
        "project.reset_setting":
            return ProjectConfig.reset_setting(params)
        "project.list_autoloads":
            return ProjectConfig.list_autoloads()
        "project.set_autoload":
            return _project_set_autoload(params)
        "project.remove_autoload":
            return ProjectConfig.remove_autoload(params)
        "project.list_input_actions":
            return ProjectConfig.list_input_actions(params)
        "project.set_input_action":
            return ProjectConfig.set_input_action(params)
        "project.remove_input_action":
            return ProjectConfig.remove_input_action(params)
        "project.reset_input_action":
            return ProjectConfig.reset_input_action(params)
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
            return _scene_tree(params)
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
        "node.change_type":
            return _node_change_type(params)
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
        "resource.create_texture":
            return _resource_create_texture(params)
        "resource.create_shape":
            return _resource_create_shape(params)
        "resource.describe_tileset":
            return _resource_describe_tileset(params)
        "session.heartbeat":
            return _session_heartbeat()
    return Params.unknown_command_error(command)
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
                "message": "The project is running and the scene cannot be mutated. Stop it with godot_runtime stop, then send this again; the edited scene and the running game are separate, so stopping loses nothing the editor holds",
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
    _send_event("scene.changed", {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_is_dirty()})

func _bump_revision() -> void:
    _advance_revision()

## Whether the editor is holding unsaved changes to the edited scene.
##
## The editor's own answer, because it is the only one that counts work Gofer did not do. Counting
## Gofer's own mutations instead made a scene a person saved with Ctrl+S read dirty until the next
## scene switch, and a scene a person edited by hand read clean — and `dirty` is the field every
## unsaved-work prompt is built on.
func _scene_is_dirty() -> bool:
    if _current_scene_path.is_empty():
        return false
    return EditorInterface.get_unsaved_scenes().has(_current_scene_path)

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
    var main_scene := str(ProjectSettings.get_setting("application/run/main_scene", ""))
    if main_scene.is_empty() or filesystem.get_file_type(main_scene) != "PackedScene":
        return true
    if _edited_root() != null:
        _startup_open_settled_frames = 0
        return true
    _startup_open_settled_frames += 1
    return _startup_open_settled_frames > STARTUP_OPEN_SETTLED_FRAMES

## What the session is, from the three things that decide it.
##
## Derived rather than assigned. `_scene_create` used to set `importing` and restore `ready` by hand
## on seven error paths; an eighth early return added without the restore leaves the editor refusing
## every mutating command `not_ready` for as long as it lives. The acceptance suite has caught that
## exact wedge once already, from another cause.
func _derived_readiness() -> String:
    if _peer == null or _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        return "unavailable"
    if not _ready_notified or not _scene_pending.is_empty():
        return "importing"
    return "ready"

## Recomputes readiness and announces it, when it moved.
func _refresh_readiness() -> void:
    var derived := _derived_readiness()
    if derived == _readiness:
        return
    _readiness = derived
    _send_event("session.%s" % derived, {"readiness": derived})

## Follows the scene the editor opens for itself.
##
## `_sweep_scene_pending` adopts the switches Gofer asked for. The editor performs others on its
## own: the scene it opens after its first import scan, and every scene a person opens in the
## editor window. Without this the session reports no open scene while one is being edited — the
## toolbar says so, `session.get_state` says so, and the debugger's launch, which plays the *edited*
## scene, starts a game with nothing in it. Every panel that refetches on `scene.changed` would
## likewise keep showing whatever it read before the editor had opened anything.
func _track_edited_scene() -> void:
    if not _scene_pending.is_empty():
        return
    var root := _edited_root()
    var path := "" if root == null else root.scene_file_path
    if path == _current_scene_path:
        return
    _current_scene_path = path
    _scene_revision = 0
    _send_event("scene.changed", {
        "scene": _current_scene_path,
        "revision": _scene_revision,
        "dirty": _scene_is_dirty()
    })

## Godot raises no signal when the project starts or stops running, so the plugin polls the editor
## and reports the transition. Gofer maps these events onto its own session lifecycle.
func _track_play_state() -> void:
    var playing := EditorInterface.is_playing_scene()
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
                "broke": _runtime_broke,
            })
        "runtime.run":
            _runtime_launch(id, false, str(params.get("scene", "")))
        "runtime.restart":
            _runtime_launch(id, true, _runtime_scene)
        "runtime.stop":
            _runtime_stop()
            if EditorInterface.is_playing_scene():
                _runtime_pending.append({"id": id, "kind": "stop", "deadline": _runtime_deadline(_runtime_launch_timeout_ms)})
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
        "runtime.wait":
            _runtime_forward(id, "wait", params)
        "runtime.pause":
            _runtime_forward(id, "pause", params)
        "runtime.resume":
            _runtime_forward(id, "resume", params)
        _:
            _respond_error_dict(id, Params.unknown_command_error(command)["_gofer_error"])

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
func _runtime_launch(id: String, restart: bool, scene: String) -> void:
    var playing := EditorInterface.is_playing_scene()
    if playing and not restart:
        _respond_error(id, "already_running", "The project is already running; stop it or use runtime.restart", true)
        return
    if not scene.is_empty() and not FileAccess.file_exists(scene):
        _respond_error(
            id,
            "scene_not_found",
            "No scene at '%s'. godot_scene list names every scene this project has" % scene,
            false,
            {"scene": scene}
        )
        return
    if playing:
        _runtime_scene = scene
        _runtime_stop()
        _runtime_pending.append({"id": id, "kind": "restart", "deadline": _runtime_deadline(_runtime_launch_timeout_ms)})
        return
    var asking: Variant = _editor_dialog()
    if asking != null:
        _respond_dialog_open(id, asking)
        return
    _runtime_scene = scene
    _runtime_play()
    _runtime_pending.append(_launch_pending(id, "run"))

## Presses Play, on the scene the caller named or on the project's own.
##
## `play_custom_scene` is the editor's F6, and it is what an agent asking to run one scene means.
## Without it the only way to run anything but the main scene is to write
## `application/run/main_scene`, run, and write it back — which one live turn did, spending two
## calls on the detour and leaving a window in which the project boots into a test scene. Another
## two reached for a `playArgs` parameter that `godot_runtime run` does not have.
func _runtime_play() -> void:
    if _runtime_scene.is_empty():
        EditorInterface.play_main_scene()
    else:
        EditorInterface.play_custom_scene(_runtime_scene)

## Answers a request the editor turned into a question for a person.
##
## Not retryable: the same request asks the same question again, and the dialog it opens has to be
## answered in the editor before anything else can happen. The text is in the message because that
## is what tells the caller what to fix — every code on its own reads as "try later".
func _respond_dialog_open(id: String, dialog: Dictionary, launch_is_waiting: bool = false) -> void:
    _respond_error(
        id,
        "editor_dialog_open",
        (
            "The editor is waiting for an answer to '%s': %s (choices: %s)%s"
            % [
                dialog["title"],
                dialog["text"],
                ", ".join(dialog["buttons"]),
                Params.after_a_dialog(launch_is_waiting)
            ]
        ),
        false,
        {"dialog": dialog}
    )

## A launch entry. `seen_playing` is what lets the sweep tell a game still booting from a game that
## booted and died: both read `is_playing_scene() == false`, and only the second one is over.
func _launch_pending(id: String, kind: String) -> Dictionary:
    return {
        "id": id,
        "kind": kind,
        "deadline": _runtime_deadline(_runtime_launch_timeout_ms),
        "seen_playing": false,
    }

## Forwards a request to the running game. Without a live helper the request fails immediately —
## the caller can start the game and retry, so the error is retryable.
func _runtime_forward(id: String, op: String, params: Dictionary) -> void:
    if not _runtime_ready or _runtime_session_id < 0:
        _respond_error(id, "runtime_not_running", "No game with the Gofer runtime helper is running", true)
        return
    if _runtime_broke:
        _respond_error(id, "runtime_broke", "The game is paused in the debugger and cannot answer until it runs on. godot_debug continue lets it go, and godot_debug stack_trace says where it is stopped. If it stopped while starting, what stopped it is in the session output - read that, fix it, and run again", true)
        return
    _runtime_pending.append({
        "id": id,
        "kind": "game",
        "op": op,
        "deadline": _runtime_deadline(_runtime_request_timeout_ms),
    })
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

## The debugger has resumed the game. It can answer again, and a game that is only being watched
## sends nothing on its own, so this is the clearing that does not wait for the game to speak.
func _on_runtime_debugger_session_continued(session_id: int) -> void:
    if session_id != _runtime_session_id:
        return
    _runtime_broke = false

func _on_runtime_debugger_session_stopped(session_id: int) -> void:
    if session_id != _runtime_session_id:
        return
    _runtime_session_id = -1
    _runtime_ready = false
    _runtime_broke = false
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
            "deadline": _runtime_deadline(_runtime_request_timeout_ms),
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

## Answers every pending call the game has run out of time for, and starts the one a restart wants.
##
## Runs even while the RPC link is down: a restart must still start the new game once the old one
## has stopped. The two editor reads are here and the arithmetic is not — which of six things a
## silence means is `RuntimeQueue.sweep`.
func _sweep_runtime_pending() -> void:
    if _runtime_pending.is_empty():
        return
    var playing := EditorInterface.is_playing_scene()
    var swept := RuntimeQueue.sweep(
        _runtime_pending,
        Time.get_ticks_msec(),
        playing,
        null if playing else _editor_dialog()
    )
    _runtime_pending.assign(swept["kept"])
    for answer in swept["answers"]:
        match str(answer["kind"]):
            "dialog":
                _respond_dialog_open(answer["id"], answer["dialog"], true)
            "result":
                _respond_result(answer["id"], answer["result"])
            _:
                _respond_error(
                    answer["id"],
                    answer["code"],
                    answer["message"],
                    answer["retryable"],
                    answer["details"]
                )
    if swept["play"]:
        _runtime_play()

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
## desktop that has real windows, verified on the pinned 4.7.2 — is a viewport of its own that the
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
        overlays.append({"image": image, "offset": window.position - main.position})
    return overlays

## Every window standing over the editor, innermost last, so a dialog opened by a dialog is
## reported and drawn after the one that opened it.
##
## Asked of the two things that already know, rather than of the tree. A window is either embedded
## in a viewport, which the viewport lists, or it is a native window, which the display server
## lists and can name the node of. Walking the editor's own tree for them finds exactly the same
## windows and costs 13 milliseconds a call across its 21,000 nodes — measured on the pinned 4.7.2
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


func _session_state() -> Dictionary:
    return {
        "state": _readiness,
        "scene": _current_scene_path,
        "revision": _scene_revision,
        "dirty": _scene_is_dirty(),
        "canUndo": _history_depths()["undoDepth"] > 0,
        "canRedo": _history_depths()["redoDepth"] > 0,
        "dialog": _editor_dialog(),
    }

## Asks the editor to close itself, which is the only way its machine-wide settings reach disk.
##
## Answers before it acts: the quit takes the socket with it, and a caller that lost its answer
## cannot tell an orderly shutdown from a crashed editor.
func _session_quit() -> Dictionary:
    _runtime_stop()
    _quit_countdown = 2
    return {"quitting": true}

## The scenes the editor is holding changes to that are not on disk.
##
## Every open scene, where `dirty` answers for the edited one alone. A task switch or a merge stops
## the editor, and this is what says which files that would throw away.
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
    _refresh_readiness()

    var kept_runtime: Array[Dictionary] = []
    for pending in _runtime_pending:
        if String(pending["id"]) == request_id:
            cancelled = true
            _respond_error(request_id, "cancelled", "The request was cancelled by its caller", false)
        else:
            kept_runtime.append(pending)
    _runtime_pending = kept_runtime

    return {"requestId": request_id, "cancelled": cancelled}

## Takes back the action just committed, so a refusal is true about the scene.
##
## A read-back mismatch means the engine did not do what the command asked, and the command then
## answers that it failed. It has to be failed: `node.rename` committed its action, found Godot
## holding another name, and returned a refusal over a scene that had changed anyway — the node
## keeping a name nobody asked for and the revision never moving to say so.
func _take_back_the_last_action() -> void:
    var history := _scene_history()
    if history != null and history.has_undo():
        history.undo()

func _undo() -> Dictionary:
    var history := _scene_history()
    if history == null:
        return _history_error("undo_unavailable", "The editor refused to undo the last action")
    if not history.has_undo():
        return _history_error("undo_unavailable", "Nothing to undo")
    var before := history.get_version()
    if not history.undo():
        return _history_error("undo_unavailable", "The editor refused to undo the last action")
    if history.get_version() == before:
        return Params.readback_error(
            "session.undo", "a step back through the history", "version %d, unmoved" % before
        )
    _after_history_step()
    return _history_depths()

func _redo() -> Dictionary:
    var history := _scene_history()
    if history == null:
        return _history_error("redo_unavailable", "The editor refused to redo the next action")
    if not history.has_redo():
        return _history_error("redo_unavailable", "Nothing to redo")
    var before := history.get_version()
    if not history.redo():
        return _history_error("redo_unavailable", "The editor refused to redo the next action")
    if history.get_version() == before:
        return Params.readback_error(
            "session.redo", "a step forward through the history", "version %d, unmoved" % before
        )
    _after_history_step()
    return _history_depths()

## Settles the editor after the scene history moved under it.
##
## `EditorUndoRedoManager` tracks a saved version per history and derives the scene's unsaved marker
## by counting actions from it. Stepping the underlying `UndoRedo` directly leaves that count
## pointing past the end of the manager's own action list, so the marker is set explicitly instead:
## a scene that just moved through its history is unsaved either way.
func _after_history_step() -> void:
    EditorInterface.mark_scene_as_unsaved()
    _advance_revision()

## Where the edited scene's history stands, counted off the editor's own `UndoRedo`.
##
## Gofer used to count its own mutations instead, and a person's Ctrl+Z moved the history without
## moving that count: the next `session.undo` stepped one action further back than it was asked to,
## into work nobody had told it about. A scene switch lost the count altogether, so an undo the Edit
## menu still offered was refused. The editor is the only place both answers are true.
func _history_depths() -> Dictionary:
    var history := _scene_history()
    if history == null:
        return {"undoDepth": 0, "redoDepth": 0}
    var undone_to := history.get_current_action() + 1
    return {"undoDepth": undone_to, "redoDepth": history.get_history_count() - undone_to}

func _history_error(code: String, message: String) -> Dictionary:
    return {
        "_gofer_error": {
            "code": code,
            "message": message,
            "retryable": false,
            "readiness": "ready",
            "details": _history_depths()
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
        stored.append(String(state.get_node_path(index)).trim_prefix("./"))
    stored.sort()
    var editing := Params.owned_paths(root)
    if stored != editing:
        return Params.readback_error(
            "the scene saved to %s" % path,
            ", ".join(editing),
            ", ".join(stored),
            {"path": path}
        )
    return {}




## The one `project.*` handler the plugin still owns, because the list it appends to is the
## plugin's: what Gofer added is what Gofer takes back when the session ends.
func _project_set_autoload(params: Dictionary) -> Dictionary:
    return ProjectConfig.set_autoload(params, _autoloads_added_here)

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
    var failure := ProjectConfig.save_project_or_error()
    if not failure.is_empty():
        return failure
    var actual := EditorInterface.is_plugin_enabled(plugin)
    if actual != enabled:
        return Params.readback_error(
            "project.set_plugin_enabled %s" % plugin, enabled, actual, {"plugin": plugin}
        )
    return {"plugin": plugin, "enabled": actual, "changed": true}

## EditorSettings are machine-wide and shared by every project this editor opens. They persist
## when the editor exits normally, so these commands never write them to disk themselves.
func _editor_search_settings(params: Dictionary) -> Dictionary:
    var wanted := Params.words_of(str(params.get("query", "")))
    var settings := EditorInterface.get_editor_settings()
    var matches: Array = []
    var total := 0
    for info in settings.get_property_list():
        var name := str(info.get("name", ""))
        if name.is_empty() or not settings.has_setting(name):
            continue
        if not Params.name_holds_every_word(name, wanted):
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
            "setting_not_found",
            (
                "Editor setting '%s' does not exist. project.search_editor_settings takes the "
                + "words you would say — every one of them has to be in the name, in any order — "
                + "and answers the names that are really there."
            ) % name,
            {"name": name}
        )
    return {"name": name, "value": Protocol.encode(settings.get_setting(name))}

func _editor_set_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or not params.has("value"):
        return Params.error("invalid_params", "editor.set_setting requires name and value")
    var settings := EditorInterface.get_editor_settings()
    if not settings.has_setting(name):
        return Params.error(
            "setting_not_found",
            (
                "Editor setting '%s' does not exist. project.search_editor_settings takes the "
                + "words you would say — every one of them has to be in the name, in any order — "
                + "and answers the names that are really there."
            ) % name,
            {"name": name}
        )
    var decoded := Protocol.decode(params["value"])
    if not decoded["ok"]:
        return Params.error("unsupported_value", decoded["message"], {"name": name})
    settings.set_setting(name, decoded["value"])
    var stored: Variant = settings.get_setting(name)
    if not Params.same_value(decoded["value"], stored):
        return Params.readback_error("editor.set_setting %s" % name, decoded["value"], stored, {"name": name})
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
    var requested := Params.rescan_paths_param(params)
    if requested.has("_gofer_error"):
        return requested
    var paths: Array = requested["value"]
    return {"_gofer_pending_scan": {
        "paths": paths,
        "walked": false,
        "scans": _scans_completed,
        "settled": 0,
        "deadline": Time.get_ticks_msec() + RESOURCE_SCAN_TIMEOUT_MS,
        "path": "" if paths.is_empty() else str(paths[0]),
    }}


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

## Takes away the sidecar of an import that produced nothing, so a walk sees a file it has not seen.
##
## Only that sidecar. One whose imported file is on disk is a working import and is left alone, so
## a rescan of an unchanged project still costs nothing and re-imports nothing.
func _discard_failed_import(path: String) -> void:
    if not _has_stale_import(path):
        return
    DirAccess.remove_absolute(path + ".import")

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
            if _scans_completed > int(pending["scans"]):
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
        if not bool(pending.get("walk", false)) and not paths.is_empty() and _import_batch(paths):
            _respond_result(pending["id"], _rescan_result(pending))
            continue
        for path: String in paths:
            _discard_failed_import(path)
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
    var answer := {
        "scanned": true,
        "path": pending.get("path", ""),
        "paths": pending.get("paths", []),
    }
    return answer.merged(pending.get("result", {}), true)

## The answer a resource writer hands back, held until the project knows the UID it just stamped.
##
## Only when the cache does not hold the path already: a shape saved over one that is registered
## keeps its id, and paying a project walk for it would make the commonest case the slowest. The
## wait is the one `resource.rescan` and `resource.create_texture` use, so a caller gets one reply
## rather than a rescan's, and never has to remember a second call — see [`_uid_is_unregistered`].
func _walk_for_a_new_uid(path: String, answer: Dictionary) -> Dictionary:
    if not _uid_is_unregistered(path):
        return answer
    return {"_gofer_pending_scan": {
        "paths": [path],
        "walk": true,
        "walked": false,
        "scans": _scans_completed,
        "settled": 0,
        "deadline": Time.get_ticks_msec() + RESOURCE_SCAN_TIMEOUT_MS,
        "path": path,
        "result": answer,
    }}

## Whether the UID a just-written resource carries is missing from the project's own cache.
##
## `ResourceSaver.save` stamps a fresh `uid://…` into a `.tres` header, and nothing else tells the
## project that UID exists: `update_file` registers the file and stops there. Every scene that then
## references it loads with `ext_resource, invalid UID: uid://… - using text path instead`, once per
## reference, in the editor and in the running game, for ever.
##
## The warning is not fatal — the loader falls back to the text path — and that is what makes it
## expensive. A live turn read two of them out of the game log and spent six calls chasing them: a
## `bash cat` the workspace refused for naming a scene, a `cat` for `.uid` sidecars a `.tres` does
## not have, a `sed` that would not parse, and finally a `sed` that stripped the UID line out of
## both files by hand. Nothing was wrong with either file.
##
## `ResourceSaver` has already put the id in the editor's own table, so `ResourceUID.has_id` says
## yes and answers nothing. The game is a second process and reads `.godot/uid_cache.bin`, which
## only a finished project walk writes — `add_id`, `update_file` and `scan_sources` all leave it
## as it was, measured. So the question this answers is about that file and no other.
func _uid_is_unregistered(path: String) -> bool:
    if ResourceLoader.get_resource_uid(path) == ResourceUID.INVALID_ID:
        return false
    var cache := FileAccess.open("res://.godot/uid_cache.bin", FileAccess.READ)
    if cache == null:
        return true
    var held := cache.get_buffer(cache.get_length()).get_string_from_utf8()
    return not held.contains(path)

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
    var targets := Params.tileset_paths(params)
    if targets.has("_gofer_error"):
        return targets
    var path: String = targets["value"]["path"]
    var texture_path: String = targets["value"]["texture"]
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

    var planned := Params.tileset_plan(params, texture_path, (texture as Texture2D).get_size())
    if planned.has("_gofer_error"):
        return planned
    var plan: Dictionary = planned["value"]
    var tile_size: Vector2i = plan["tileSize"]
    var grid: Vector2i = plan["grid"]
    var tiles: Array = plan["tiles"]
    var solid: Array = plan["solid"]

    var tile_set := TileSet.new()
    tile_set.tile_size = tile_size
    if not solid.is_empty():
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

    var written := ResourceLoader.load(path, "TileSet", ResourceLoader.CACHE_MODE_IGNORE)
    if written == null or not (written is TileSet):
        return Params.error(
            "save_failed",
            "%s was reported saved but does not load back as a TileSet" % path,
            {"path": path}
        )
    var saved_set: TileSet = written
    if saved_set.tile_size != tile_size:
        return Params.readback_error(
            "resource.create_tileset tileSize", tile_size, saved_set.tile_size, {"path": path}
        )
    if not saved_set.has_source(source_id):
        return Params.readback_error(
            "resource.create_tileset source", source_id, "no source", {"path": path}
        )
    var saved_source := saved_set.get_source(source_id)
    if not (saved_source is TileSetAtlasSource):
        return Params.readback_error(
            "resource.create_tileset source",
            "an atlas source",
            saved_source.get_class(),
            {"path": path}
        )
    var saved_atlas: TileSetAtlasSource = saved_source
    for coords in tiles:
        if not saved_atlas.has_tile(coords):
            return Params.readback_error(
                "resource.create_tileset tile",
                "a tile at (%d, %d)" % [coords.x, coords.y],
                "nothing",
                {"path": path}
            )
    for coords in solid:
        if saved_atlas.get_tile_data(coords, 0).get_collision_polygons_count(0) == 0:
            return Params.readback_error(
                "resource.create_tileset collision",
                "a collision polygon on (%d, %d)" % [coords.x, coords.y],
                "none",
                {"path": path}
            )

    var answer := {
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
    return _walk_for_a_new_uid(path, answer)


## Saves a 2D collision shape as a resource a node can be given.
##
## A resource property is filled by naming a file that already exists — `node.set_property` resolves
## it with `load` — so a shape that was never saved cannot be assigned at all. Every collision node
## in the catalogue was therefore creatable and unusable: `CollisionShape2D` had no way to reach a
## `RectangleShape2D`. This is the shape half of what `resource.create_tileset` does for tiles.
func _resource_create_shape(params: Dictionary) -> Dictionary:
    var path := Params.as_resource_path(params.get("path", ""))
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

    var written := ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
    if written == null:
        return Params.error(
            "save_failed",
            "%s was reported saved but does not load back at all" % path,
            {"path": path}
        )
    var saved_type := (written as Resource).get_class()
    if saved_type != shape_type:
        return Params.readback_error("resource.create_shape", shape_type, saved_type, {"path": path})

    var answer := {
        "path": path,
        "shapeType": saved_type,
        "replaced": replaced,
    }
    return _walk_for_a_new_uid(path, answer)


## Draws a PNG and hands back a texture the project has already imported.
##
## Every 2D task starts with no art, and until this existed the only way to make some was to leave
## the tool. Three live turns did: two reached for a Python image library through `bash`, and the
## third — on a machine that had none — hand-rolled a PNG encoder out of `struct` and `zlib`, got
## the colour type wrong, and spent six calls and a throwaway `.py` file getting a 16x16 tile onto
## disk. A Windows install has neither the shell nor the library, so this had to be an operation
## rather than a sentence pointing at one.
##
## The engine draws it. `Image` is already here, so this costs no dependency and writes a file the
## importer accepts by construction. The answer goes back through the same wait `resource.rescan`
## uses, because a PNG on disk is not a texture until the editor has imported it, and a caller who
## has to remember a second call to make the first one mean anything will forget — one live turn
## did, and `create_tileset` told it the texture does not exist.
func _resource_create_texture(params: Dictionary) -> Dictionary:
    var planned := Params.texture_plan(params)
    if planned.has("_gofer_error"):
        return planned
    var plan: Dictionary = planned["value"]
    var path: String = plan["path"]
    var size: Vector2i = plan["size"]

    var image := Image.create(size.x, size.y, false, Image.FORMAT_RGBA8)
    image.fill(plan["background"])
    for rect: Dictionary in plan["rects"]:
        image.fill_rect(rect["area"], rect["color"])

    var folder := path.get_base_dir()
    if not DirAccess.dir_exists_absolute(folder):
        var made := DirAccess.make_dir_recursive_absolute(folder)
        if made != OK:
            return Params.error(
                "save_failed",
                "Directory %s could not be created: %s" % [folder, error_string(made)],
                {"path": path}
            )
    var replaced := FileAccess.file_exists(path)
    var error := image.save_png(path)
    if error != OK:
        return Params.error(
            "save_failed",
            "Texture %s could not be saved: %s" % [path, error_string(error)],
            {"path": path, "error": error}
        )

    return {"_gofer_pending_scan": {
        "paths": [path],
        "walked": false,
        "scans": _scans_completed,
        "settled": 0,
        "deadline": Time.get_ticks_msec() + RESOURCE_SCAN_TIMEOUT_MS,
        "path": path,
        "result": {
            "path": path,
            "width": size.x,
            "height": size.y,
            "replaced": replaced,
        },
    }}


## Reports what a saved TileSet holds, so a caller painting with it can name tiles that exist.
func _resource_describe_tileset(params: Dictionary) -> Dictionary:
    var path := Params.as_resource_path(params.get("path", ""))
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





func _scene_list() -> Dictionary:
    return {"scenes": Array(EditorInterface.get_open_scenes())}

func _scene_open(params: Dictionary) -> Dictionary:
    var path := Params.as_resource_path(params.get("path", ""))
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
    if not ResourceLoader.exists(path):
        return Params.error("scene_not_found", "Scene %s does not exist" % path, {"path": path})
    return _switch_edited_scene(path)

func _scene_create(params: Dictionary) -> Dictionary:
    var path := Params.as_resource_path(params.get("path", ""))
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
    if FileAccess.file_exists(path):
        return Params.error(
            "already_exists",
            "%s is already a scene, and create writes a new one over whatever is there. " % path
            + "Open it with scene.open to work on it, or save this one over it with scene.save_as "
            + "if replacing it is what you meant."
            + Params.also_the_main_scene(
                path, String(ProjectSettings.get_setting_with_override("application/run/main_scene"))
            ),
            {"path": path}
        )
    var root: Node = ClassDB.instantiate(root_type) as Node
    if root == null:
        return {
            "_gofer_error": {
                "code": "invalid_node_type",
                "message": (
                    "Could not instantiate %s" % root_type
                    + Params.a_type_that_is_a_scene(root_type)
                ),
                "retryable": false,
                "readiness": "ready",
                "details": {"rootType": root_type}
            }
        }
    var root_name: String = params.get("rootName", "")
    root.name = root_name if not root_name.is_empty() else path.get_file().get_basename()
    var named := String(root.name)
    var scene := PackedScene.new()
    var pack_error := scene.pack(root)
    if pack_error != OK:
        root.queue_free()
        return {
            "_gofer_error": {
                "code": "scene_pack_failed",
                "message": "Could not pack new scene: %s" % error_string(pack_error),
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var folder := path.get_base_dir()
    if not DirAccess.dir_exists_absolute(folder):
        var made := DirAccess.make_dir_recursive_absolute(folder)
        if made != OK:
            root.queue_free()
            return {
                "_gofer_error": {
                    "code": "scene_save_failed",
                    "message": (
                        "Directory %s could not be created: %s" % [folder, error_string(made)]
                    ),
                    "retryable": false,
                    "readiness": "ready",
                    "details": {"path": path}
                }
            }
    var save_error := ResourceSaver.save(scene, path)
    if save_error != OK:
        root.queue_free()
        return {
            "_gofer_error": {
                "code": "scene_save_failed",
                "message": (
                    "Could not save new scene %s: %s" % [path, error_string(save_error)]
                ),
                "retryable": false,
                "readiness": "ready",
                "details": {"path": path}
            }
        }
    root.queue_free()

    var written := ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
    if written == null or not (written is PackedScene):
        return Params.error(
            "scene_save_failed",
            "%s was reported saved but does not load back as a scene" % path,
            {"path": path}
        )
    var state := (written as PackedScene).get_state()
    var saved_name := "" if state.get_node_count() == 0 else String(state.get_node_name(0))
    if saved_name != named:
        return Params.readback_error("scene.create root", named, saved_name, {"path": path})
    var saved_type := "" if state.get_node_count() == 0 else String(state.get_node_type(0))
    if saved_type != root_type:
        return Params.readback_error("scene.create rootType", root_type, saved_type, {"path": path})

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
    if not _scene_is_dirty():
        var unchanged := _saved_scene_holds(_current_scene_path, root)
        if unchanged.is_empty():
            return {
                "scene": _current_scene_path,
                "revision": _scene_revision,
                "dirty": false,
                "wrote": false
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
    return {
        "scene": _current_scene_path,
        "revision": _scene_revision,
        "dirty": _scene_is_dirty(),
        "wrote": true
    }

func _scene_save_as(params: Dictionary) -> Dictionary:
    var path := Params.as_resource_path(params.get("path", ""))
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
    var folder := path.get_base_dir()
    if not DirAccess.dir_exists_absolute(folder):
        var made := DirAccess.make_dir_recursive_absolute(folder)
        if made != OK:
            return {
                "_gofer_error": {
                    "code": "scene_save_failed",
                    "message": (
                        "Directory %s could not be created: %s" % [folder, error_string(made)]
                    ),
                    "retryable": false,
                    "readiness": "ready",
                    "details": {"path": path}
                }
            }
    EditorInterface.save_scene_as(path)
    var verified := _saved_scene_holds(path, root)
    if not verified.is_empty():
        return verified
    var owned := String(root.scene_file_path)
    if owned != path:
        return Params.readback_error(
            "scene.save_as", path, owned if not owned.is_empty() else "no file", {"path": path}
        )
    _current_scene_path = owned
    return {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_is_dirty()}

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
    _refresh_readiness()

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
    var switched: Array[Dictionary] = []
    var timed_out: Array[Dictionary] = []
    for pending in _scene_pending:
        if _edited_scene_switched(pending):
            switched.append(pending)
        elif int(pending["deadline"]) < now:
            timed_out.append(pending)
        else:
            if int(pending["next_ask"]) <= now:
                pending["next_ask"] = now + SCENE_SWITCH_RETRY_MS
                _ask_editor_to_switch(pending)
            kept.append(pending)
    # Readiness is derived from this list, and a refusal carries readiness, so the list is what it
    # will be before anything is answered out of it.
    _scene_pending = kept
    _refresh_readiness()
    for pending in switched:
        _current_scene_path = pending["path"]
        _scene_revision = 0
        var result := {
            "scene": _current_scene_path,
            "revision": _scene_revision,
            "dirty": _scene_is_dirty(),
        }
        if pending["mutating"]:
            _respond_result(pending["id"], result, _scene_revision)
        else:
            _respond_result(pending["id"], result)
    for pending in timed_out:
        _respond_error(
            pending["id"],
            "scene_switch_timeout",
            _scene_switch_failure(String(pending["path"])),
            true,
            {"path": pending["path"]}
        )

## The edited hierarchy and the revision it is at.
##
## The revision travels in the envelope for a mutating command, and `scene.get_tree` is not one —
## so without it here the one command documented as the source of `expectedRevision` answered
## without it, and an agent that read the tree before every mutation had no number to send.
##
## The scene travels with it for the same reason. A revision only counts inside one scene, and this
## is the read the tool description tells the model to make before every mutation — so a tree
## answered without naming its scene left the router's guard with nothing to guard against.
func _scene_tree(params: Dictionary) -> Dictionary:
    var root := _edited_root()
    if root == null:
        return {"truncated": false, "root": null, "revision": _scene_revision, "scene": _current_scene_path}
    var start := root
    var from := str(params.get("root", ""))
    if not from.is_empty():
        start = _find_node(from)
        if start == null:
            return _node_not_found_error(from)
    var budget := int(params.get("limit", DEFAULT_TREE_NODES))
    var levels := int(params.get("depth", MAX_TREE_DEPTH))
    _tree_nodes_seen = 0
    _tree_truncated = false
    _tree_budget = clampi(budget, 1, MAX_TREE_NODES)
    _tree_depth = clampi(levels, 0, MAX_TREE_DEPTH)
    var summary := _node_summary(start, 0)
    return {
        "truncated": _tree_truncated,
        "root": summary,
        "revision": _scene_revision,
        "scene": _current_scene_path,
    }

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
    var pending: Dictionary = {}
    var plan: Array = []
    for entry in entries:
        if typeof(entry) != TYPE_DICTIONARY:
            return Params.error(
                "invalid_params", "Each nodes entry is an object, and %s is not one" % str(entry)
            )
        var spec: Dictionary = entry
        var parent_path := Params.batch_parent_key(String(spec.get("parent", "")))
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
                "invalid_node_type",
                "Could not instantiate %s" % node_type + Params.a_type_that_is_a_scene(node_type),
                {"type": node_type}
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
        return Params.readback_error(
            command, "%s under %s" % [node.name, _node_path(parent)], "nothing", details
        )
    if node.owner != root:
        return Params.readback_error(
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
    var path := Params.as_resource_path(params.get("path", ""))
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

    var cycle := Params.instance_cycle(path, _current_scene_path)
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
    var instanced := String(node.scene_file_path)
    if instanced != path:
        return Params.readback_error(
            "node.instantiate",
            path,
            instanced if not instanced.is_empty() else "a plain copy",
            {"path": path}
        )

    _bump_revision()
    return {"node": _node_path(node), "path": path}

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

    var parent := node.get_parent()
    if new_name != old_name and parent != null:
        var sibling := parent.get_node_or_null(NodePath(new_name))
        if sibling != null and sibling != node:
            return Params.error(
                "name_taken",
                (
                    "A sibling is already called %s, and Godot makes a node's name unique among "
                    + "its siblings rather than refusing the clash. Rename or remove that one "
                    + "first, or choose another name."
                ) % new_name,
                {"node": node_path_str, "name": new_name}
            )

    var undo := _begin_action("Rename %s" % old_name)
    undo.add_do_method(node, "set_name", new_name)
    undo.add_undo_method(node, "set_name", old_name)
    undo.commit_action()

    var named := String(node.name)
    if named != new_name:
        _take_back_the_last_action()
        return Params.readback_error("node.rename", new_name, named, {"node": node_path_str})

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

## Turns a node into one of another class, keeping everything about it that the new class can hold.
##
## The one edit a Godot project needs constantly and this catalogue had no word for. A `Node2D`
## placed as a player becomes a `CharacterBody2D` the moment the game needs gravity, and the editor
## has "Change Type" on the right-click menu for exactly that.
##
## Without it a model does it by hand, and three live turns did: delete the node, create the new
## one, put the children back, re-attach the script, re-set every property, re-add every group. One
## wrote that as a single `godot_node` call of `delete` + `create_nodes` + three `instantiate`
## entries, its JSON tore across the batch, and it spent five refusals and 3,642 tokens before
## giving up on the batch. Another asked the question outright in its own reasoning: "Can I change a
## node's type? The tool list doesn't have a change type op."
##
## What travels: the name, the place under the parent, the children, the groups, the script, and
## every stored property the new class also declares. What does not: a signal connected to or from
## this node, because the connection names the node and the new one is a different object — the
## summary says so, and `node.connect_signal` is the word for putting one back.
func _node_change_type(params: Dictionary) -> Dictionary:
    var scene: String = params.get("scene", "")
    var node_path_str: String = params.get("node", "")
    var node_type: String = params.get("type", "")

    var scene_check := _require_current_scene(scene)
    if not scene_check.is_empty():
        return scene_check
    if node_path_str.is_empty() or node_type.is_empty():
        return Params.error("invalid_params", "node.change_type requires node and type")
    if UNCREATABLE_TYPES.has(node_type):
        return Params.error(
            "invalid_node_type", UNCREATABLE_TYPES[node_type], {"type": node_type}
        )

    var node := _find_node(node_path_str)
    if node == null:
        return _node_not_found_error(node_path_str)
    var root := _edited_root()
    if node == root:
        return Params.error(
            "invalid_node",
            "%s is the scene's root, and a scene is of its root — changing it is a different "
            % node_path_str
            + "scene. Make one with scene.create and move the nodes over, or put this node under "
            + "a new root with node.reparent.",
            {"node": node_path_str}
        )
    if node.get_class() == node_type:
        return Params.error(
            "invalid_node_type",
            "%s is already a %s." % [node_path_str, node_type],
            {"node": node_path_str, "type": node_type}
        )

    var replacement: Node = ClassDB.instantiate(node_type) as Node
    if replacement == null:
        return Params.error(
            "invalid_node_type",
            "Could not instantiate %s" % node_type + Params.a_type_that_is_a_scene(node_type),
            {"type": node_type}
        )

    var script := node.get_script()
    if script != null:
        var base := ""
        if script.has_method("get_instance_base_type"):
            base = str(script.get_instance_base_type())
        if (
            not base.is_empty()
            and ClassDB.class_exists(base)
            and node_type != base
            and not ClassDB.is_parent_class(node_type, base)
        ):
            replacement.free()
            return Params.error(
                "script_incompatible",
                "%s carries a script that extends %s, and a %s is not one. Change what the "
                % [node_path_str, base, node_type]
                + "script extends first, with godot_script edit, then change the type.",
                {"node": node_path_str, "type": node_type, "extends": base}
            )
        replacement.set_script(script)
    Params.carry_the_properties_over(node, replacement)
    replacement.name = node.name
    for group in node.get_groups():
        if not String(group).begins_with("_"):
            replacement.add_to_group(group, true)

    var parent := node.get_parent()
    var index := node.get_index()
    var undo := _begin_action("Change %s to %s" % [node.name, node_type])
    undo.add_do_method(self, "_do_swap_node", node, replacement, parent, root, index)
    undo.add_undo_method(self, "_do_swap_node", replacement, node, parent, root, index)
    undo.add_do_reference(replacement)
    undo.add_undo_reference(node)
    undo.commit_action()

    var attached := _attached_node(
        parent, replacement, root, "node.change_type", {"node": node_path_str}
    )
    if attached.has("_gofer_error"):
        return attached
    if replacement.get_class() != node_type:
        return Params.readback_error(
            "node.change_type", node_type, replacement.get_class(), {"node": node_path_str}
        )

    _bump_revision()
    return {"node": _node_path(replacement), "type": replacement.get_class()}

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

    if node == root:
        return Params.error(
            "cannot_delete_root",
            (
                "%s is the root of the edited scene, and a scene always has one. "
                % node_path_str
                + "To start a different scene use scene.create; to change this one's name use "
                + "node.rename."
            ),
            {"node": node_path_str}
        )

    var undo := _begin_action("Delete %s" % node.name)
    undo.add_do_method(self, "_do_detach", parent, node)
    undo.add_undo_method(self, "_do_attach", parent, node, root, index)
    undo.add_undo_reference(node)
    undo.commit_action()

    var lingering := _find_node(node_path_str)
    if lingering != null:
        return Params.readback_error(
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
        return Params.property_not_found_error(node, node_path_str, property)

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
    var fitted := Params.fit_to_property(node, property, decoded["value"])
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

    var stored: Variant = node.get(property)
    if not Params.same_value(new_value, stored):
        return Params.readback_error(
            "node.set_property %s.%s" % [node_path_str, property],
            new_value,
            stored,
            {
                "node": node_path_str,
                "property": property,
                "enumValues": Params.enum_values(node, property)
            }
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
            return Params.property_not_found_error(node, node_path_str, property)
        var decoded := Protocol.decode(spec.get("value", null))
        if not decoded["ok"]:
            return Params.error("unsupported_value", decoded["message"], {"property": property})
        var fitted := Params.fit_to_property(node, property, decoded["value"])
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

    var written: Array = []
    for key in expected:
        var wanted: Array = expected[key]
        var node: Node = wanted[0]
        var property: String = wanted[2]
        var stored: Variant = node.get(property)
        if not Params.same_value(wanted[3], stored):
            return Params.readback_error(
                "node.set_properties %s.%s" % [wanted[1], property],
                wanted[3],
                stored,
                {
                    "node": wanted[1],
                    "property": property,
                    "enumValues": Params.enum_values(node, property)
                }
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
        return {"node": _node_path(node), "groups": Params.authored_groups(node)}

    var undo := _begin_action("Add %s to %s" % [node.name, group])
    undo.add_do_method(node, "add_to_group", group, true)
    undo.add_undo_method(node, "remove_from_group", group)
    undo.commit_action()

    if not node.is_in_group(group):
        return Params.readback_error(
            "node.add_to_group", group, ", ".join(Params.authored_groups(node)), {"group": group}
        )

    _bump_revision()
    return {"node": _node_path(node), "groups": Params.authored_groups(node)}

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

    if node.is_in_group(group):
        return Params.readback_error(
            "node.remove_from_group",
            "no %s" % group,
            ", ".join(Params.authored_groups(node)),
            {"group": group}
        )

    _bump_revision()
    return {"node": _node_path(node), "groups": Params.authored_groups(node)}

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
            var check := Params.require_tile(tile_set, source_id, atlas)
            if check.has("_gofer_error"):
                return check
        plan.append([origin, width, height, source_id, atlas, alternative])

    var cells: Array = []
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

    for at in expected:
        var coords: Vector2i = at
        var wanted: Array = expected[at]
        var source := layer.get_cell_source_id(coords)
        if source != int(wanted[0]):
            return Params.readback_error(
                "node.set_cells source at (%d, %d)" % [coords.x, coords.y],
                wanted[0],
                source,
                {"node": _node_path(layer)}
            )
        if source < 0:
            continue
        var drawn := layer.get_cell_atlas_coords(coords)
        if drawn != wanted[1]:
            return Params.readback_error(
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
    var recompiled := true
    if not target.has_method(method):
        recompiled = _reread_the_script_on(target)
    if not target.has_method(method):
        return {
            "_gofer_error": {
                "code": "method_not_found",
                "message": (
                    "%s has no method %s to receive %s%s"
                    % [
                        _node_path(target),
                        method,
                        signal_name,
                        (
                            Params.where_a_method_would_be(target, method) if recompiled
                            else Params.why_the_editor_cannot_see_it(target, _autoloads_added_here)
                        )
                    ]
                ),
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

    var flags := Object.CONNECT_PERSIST
    if bool(params.get("deferred", false)):
        flags |= Object.CONNECT_DEFERRED
    if bool(params.get("oneShot", false)):
        flags |= Object.CONNECT_ONE_SHOT

    var undo := _begin_action("Connect %s.%s" % [node.name, signal_name])
    undo.add_do_method(node, "connect", signal_name, callable, flags)
    undo.add_undo_method(node, "disconnect", signal_name, callable)
    undo.commit_action()

    if not node.is_connected(signal_name, callable):
        return Params.readback_error(
            "node.connect_signal",
            "%s.%s connected to %s" % [_node_path(node), signal_name, method],
            "not connected",
            {"signal": signal_name, "target": _node_path(target), "method": method}
        )
    var recorded := Params.connection_flags(node, signal_name, callable)
    if recorded != flags:
        return Params.readback_error(
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
    var flags := Params.connection_flags(node, signal_name, callable)

    var undo := _begin_action("Disconnect %s.%s" % [node.name, signal_name])
    undo.add_do_method(node, "disconnect", signal_name, callable)
    undo.add_undo_method(node, "connect", signal_name, callable, flags)
    undo.commit_action()

    var connected := node.is_connected(signal_name, callable)
    if connected:
        return Params.readback_error(
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
                "message": (
                    "Node %s has no signal %s%s"
                    % [node_path_str, signal_name, Params.the_signals_it_does_have(node, signal_name)]
                ),
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
    var wanted: Array[String] = []
    for name in params.get("properties", []) as Array:
        wanted.append(str(name))
    var properties := Params.node_properties(node, wanted)
    if not wanted.is_empty():
        var answered: Array[String] = []
        for property in properties:
            answered.append(str((property as Dictionary)["name"]))
        for name in wanted:
            if not answered.has(name):
                return Params.property_not_found_error(node, node_path_str, name)
    var untouched: Array[String] = []
    if wanted.is_empty():
        var split := Params.split_off_class_defaults(node, properties)
        properties = split["properties"]
        untouched = split["atClassDefault"]
    return {
        "name": node.name,
        "type": node.get_class(),
        "path": _node_path(node),
        "properties": properties,
        "atClassDefault": untouched,
        "groups": Params.authored_groups(node),
        "signals": Params.node_signals(node),
        "connections": _node_connections(node),
    }

## Checks that a request names the scene the editor is actually editing.
##
## An omitted name means "whatever is open", which is what a caller that has just read the tree is
## asking for. Demanding it left the AI tools unusable: their catalog documents no `scene` parameter
## at all, so every authoring call arrived without one and was refused against the empty string.
## What names it is the router, not the model: the read ledger records the scene each revision was
## counted in and sends it back on the next mutation. `expectedRevision` alone is not the real
## protection it was once described as — the counter restarts at zero in every scene, so a caller
## holding zero matched a scene it had never read.
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

## Re-reads a node's script from disk, so a method written a moment ago is one it has.
##
## The source is assigned and the script recompiled, rather than loaded again. Both were measured
## in the pinned editor against the test below: `ResourceLoader.load(path, "Script",
## CACHE_MODE_REPLACE)` leaves `has_method` answering exactly as it did, because the instance the
## node carries is built from the compiled script and only `reload` rebuilds it. `resource.rescan`
## does not do it either — that scans the filesystem, and a script the editor has already loaded
## stays as it was loaded.
##
## Assigning updates the resource every node and every open editor already holds, which is the
## point: a second copy would answer this one call and leave the rest of the editor behind.
## `keep_state` because the editor holds instances of it, and dropping their state to answer a
## question about a method name would be a strange thing for a read to do.
func _reread_the_script_on(target: Node) -> bool:
    var script: Variant = target.get_script()
    if not (script is Script):
        return true
    var path := (script as Script).resource_path
    if path.is_empty() or not FileAccess.file_exists(path):
        return true
    var text := FileAccess.get_file_as_string(path)
    if text.is_empty():
        return true
    var loaded := script as Script
    loaded.source_code = text
    return loaded.reload(true) == OK

## Walks a path from the scene's root and asks `Params` to word where it stopped.
##
## Only for a path that is under the right root and simply names something that is not there — the
## four clauses above answer every path that is under the wrong tree, and adding a list of children
## to one of those would bury the sentence that repairs it.
func _as_far_as_the_path_goes(raw: String) -> String:
    var root := _edited_root()
    if root == null:
        return ""
    var parts := raw.strip_edges().trim_prefix("/").split("/", false)
    if parts.size() < 2 or parts[0] != String(root.name):
        return ""
    var here := root
    var reached := "/" + String(root.name)
    for index in range(1, parts.size()):
        var next := here.get_node_or_null(NodePath(parts[index]))
        if next == null:
            var present := PackedStringArray()
            for child in here.get_children():
                present.append(String(child.name))
            return Params.as_far_as_the_path_goes(reached, present, parts[index])
        here = next
        reached += "/" + parts[index]
    return ""

## The mirror of `runtime.gd`'s funnel, for the mistake made the other way round. `godot_runtime`
## names the running game's tree, whose every path starts at `/root`; this names the scene the
## editor has open, whose paths start at the scene's own root. Two trees, two processes, one node
## with two names — so a path that arrives with `/root/` in front of it is not a missing node, it
## is the other tool's spelling, and saying so costs one sentence.
##
## Two more spellings reach here, both watched in one live turn against a real editor, and neither
## is a node path at all. `/root` on its own is the running tree's root, named where this scene's
## root was meant; `res://scenes/main.tscn` is the scene the model had just opened, sent where a
## node inside it was meant. Repeating either back says only that it is absent, which is the one
## thing the caller already knew. Both are answered with the name the root actually has, because
## that is the fact that repairs them — every node path in the edited scene begins with it.
func _node_not_found_error(raw: String) -> Dictionary:
    var path := raw.strip_edges()
    var message := "Node %s was not found in the edited scene" % path
    var root := _edited_root()
    var root_path: String = "/" + String(root.name) if root != null else ""
    if path.begins_with("/root/") and _find_node(path.substr(5)) != null:
        message = (
            "%s. It is there as %s: a path that starts at /root is how godot_runtime names the"
            + " running game, which is a different tree in a different process."
        ) % [message, path.substr(5)]
    elif (path == "/root" or path == "/root/") and not root_path.is_empty():
        message = (
            "%s. /root is how godot_runtime names the running game's root, which is a different"
            + " tree in a different process; this scene's root is %s."
        ) % [message, root_path]
    elif path.begins_with("res://") and not root_path.is_empty():
        message = (
            "%s. That names a scene file, not a node inside one: this scene's root is %s, and"
            + " every node path here starts there."
        ) % [message, root_path]
    elif (
        not root_path.is_empty()
        and path != root_path
        and not path.begins_with(root_path + "/")
    ):
        message = (
            "%s. Every node path here starts at the scene's own root, which is %s."
        ) % [message, root_path]
    else:
        message += _as_far_as_the_path_goes(path)
    return {
        "_gofer_error": {
            "code": "node_not_found",
            "message": message,
            "retryable": false,
            "readiness": "ready",
            "details": {"path": path}
        }
    }

func _edited_root() -> Node:
    return EditorInterface.get_edited_scene_root()

func _find_node(raw: String) -> Node:
    var root := _edited_root()
    if root == null:
        return null
    var path := raw.strip_edges()
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

## One node and the part of its subtree the walk still has budget for.
##
## Bounded like the running tree's, and for the same reason: the answer used to be every node of
## the edited scene however many there were, and the worker slices an oversized tool result at a
## fixed character count, mid-JSON.
func _node_summary(node: Node, depth: int) -> Dictionary:
    _tree_nodes_seen += 1
    var children: Array[Dictionary] = []
    if depth < _tree_depth and _tree_nodes_seen < _tree_budget:
        for i in range(node.get_child_count()):
            if _tree_nodes_seen >= _tree_budget:
                _tree_truncated = true
                break
            children.append(_node_summary(node.get_child(i), depth + 1))
    elif node.get_child_count() > 0:
        _tree_truncated = true
    return {
        "name": node.name,
        "type": node.get_class(),
        "icon": Params.icon_class(node),
        "path": _node_path(node),
        "children": children
    }



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

## The six writes the editor's undo manager calls back by name.
##
## `EditorUndoRedoManager.add_do_method(self, "_do_attach", …)` names a method *on this object*,
## as a string. That is the coupling, and it is invisible to anything that looks for calls: these
## were moved to `params.gd` with the rest of the node arithmetic, nothing failed to compile, and
## every undo-backed write silently stopped writing. The acceptance suite is what said so.
##
## What they decide with is still `params.gd`'s. It is only the callback that has to live here.

func _do_attach(parent: Node, child: Node, owner: Node, index: int) -> void:
    parent.add_child(child, true)
    if owner != null:
        child.set_owner(owner)
    if index >= 0 and index < parent.get_child_count():
        parent.move_child(child, index)

func _do_detach(parent: Node, child: Node) -> void:
    if child.get_parent() == parent:
        parent.remove_child(child)

## Takes one node out of its place and puts another in it, with the first one's children.
##
## The same function both ways: undoing a type change is swapping the pair back, so the do and the
## undo of `node.change_type` are one method called with its two arguments the other way round.
##
## Owners are set again on the way past. A node keeps its owner while it is only moved, and loses it
## when it leaves the tree and comes back — and a node the edited scene does not own is a node the
## save writes nothing about.
func _do_swap_node(outgoing: Node, incoming: Node, parent: Node, owner: Node, index: int) -> void:
    var owners := {}
    Params.who_owned_what(outgoing, owners)
    for child in outgoing.get_children():
        outgoing.remove_child(child)
        incoming.add_child(child, true)
    if outgoing.get_parent() == parent:
        parent.remove_child(outgoing)
    parent.add_child(incoming, true)
    if owner != null:
        incoming.set_owner(owner)
    Params.give_them_back_their_owners(incoming, owners)
    if index >= 0 and index < parent.get_child_count():
        parent.move_child(incoming, index)

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

## Writes a list of [coords, source, atlas, alternative] cells, which is both halves of the undo.
func _do_paint_cells(layer: TileMapLayer, cells: Array) -> void:
    for cell in cells:
        layer.set_cell(cell[0], cell[1], cell[2], cell[3])
