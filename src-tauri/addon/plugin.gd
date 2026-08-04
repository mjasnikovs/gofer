@tool
extends EditorPlugin

## The Gofer editor plugin.
##
## Gofer stages this addon into the active task worktree and removes it again when the session
## stops. It connects outward to Gofer's loopback RPC server using the port and token passed in the
## process environment, then answers inspection and undoable scene-authoring requests on Godot's
## main thread.

const PROTOCOL_VERSION := 2
const HANDSHAKE_ID := "handshake-1"

var _peer: StreamPeerTCP
var _status: int = -1
var _pending_line: String = ""
var _ready_notified: bool = false
var _readiness: String = "starting"
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

## The plugin's own directory name, protected so a configuration command cannot sever the session
## that carries it.
const GOFER_PLUGIN_NAME := "gofer"
## The autoload Gofer stages; cleanup owns it, so configuration commands refuse to touch it.
const GOFER_AUTOLOAD_NAME := "GoferRuntime"
## Search results are capped so a broad query cannot exceed the 1 MiB envelope limit.
const MAX_SEARCH_RESULTS := 50

## The element type of each packed array, keyed by the type of the packed array itself. The wire
## carries every array as a plain `array`, so this is what a setting declared as a packed array is
## rebuilt from.
const PACKED_ARRAY_ELEMENTS := {
    TYPE_PACKED_BYTE_ARRAY: TYPE_INT,
    TYPE_PACKED_INT32_ARRAY: TYPE_INT,
    TYPE_PACKED_INT64_ARRAY: TYPE_INT,
    TYPE_PACKED_FLOAT32_ARRAY: TYPE_FLOAT,
    TYPE_PACKED_FLOAT64_ARRAY: TYPE_FLOAT,
    TYPE_PACKED_STRING_ARRAY: TYPE_STRING,
    TYPE_PACKED_VECTOR2_ARRAY: TYPE_VECTOR2,
    TYPE_PACKED_VECTOR3_ARRAY: TYPE_VECTOR3,
    TYPE_PACKED_VECTOR4_ARRAY: TYPE_VECTOR4,
    TYPE_PACKED_COLOR_ARRAY: TYPE_COLOR,
}

const MUTATING_COMMANDS: Array[String] = [
    "session.undo",
    "session.redo",
    "scene.create",
    "scene.save",
    "scene.save_as",
    "scene.reload",
    "node.create",
    "node.duplicate",
    "node.rename",
    "node.reparent",
    "node.delete",
    "node.set_property",
    "node.add_to_group",
    "node.remove_from_group",
    "node.connect_signal",
    "node.disconnect_signal",
]

func _enter_tree() -> void:
    print("GOFER_ADDON_READY:%d" % PROTOCOL_VERSION)
    _peer = StreamPeerTCP.new()
    var port := _rpc_port()
    if port > 0:
        _peer.connect_to_host("127.0.0.1", port)
        _status = _peer.get_status()
    set_process(true)

func _exit_tree() -> void:
    print("GOFER_ADDON_STOPPED")
    if _peer:
        _peer.disconnect_from_host()
    set_process(false)

func _get_plugin_name() -> String:
    return "Gofer"

func _process(_delta: float) -> void:
    if _peer == null:
        return
    _peer.poll()
    var status := _peer.get_status()
    if status != _status:
        _status = status
        if status == StreamPeerTCP.STATUS_CONNECTED:
            _send_handshake()
        else:
            _set_readiness("unavailable")
        return
    if status != StreamPeerTCP.STATUS_CONNECTED:
        return

    if not _ready_notified:
        _ready_notified = true
        _set_readiness("ready")

    _track_play_state()

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
            "capabilities": ["session", "scene", "node", "project", "editor"]
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

    var result: Variant = _dispatch_command(command, params, expected_revision)
    var response := {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "id": id,
    }
    if result is Dictionary and result.has("_gofer_error"):
        response["kind"] = "error"
        response["error"] = result["_gofer_error"]
    else:
        response["result"] = result
        if MUTATING_COMMANDS.has(command):
            response["revision"] = _scene_revision
    _put_json(response)

func _dispatch_command(command: String, params: Dictionary, expected_revision: Variant) -> Dictionary:
    if MUTATING_COMMANDS.has(command):
        var check := _check_mutation_prerequisites(expected_revision)
        if check.has("_gofer_error"):
            return check

    match command:
        "session.get_state":
            return _session_state()
        "session.undo":
            return _undo()
        "session.redo":
            return _redo()
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
        "node.inspect":
            return _node_inspect(params)
        "session.heartbeat":
            return {}
    return _unknown_command_error(command)

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
                "message": "Mutating commands require expectedRevision",
                "retryable": true,
                "readiness": "ready",
                "details": {"currentRevision": _scene_revision}
            }
        }
    if int(expected_revision) != _scene_revision:
        return {
            "_gofer_error": {
                "code": "revision_conflict",
                "message": "The edited scene changed since revision %d" % int(expected_revision),
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

func _set_readiness(readiness: String) -> void:
    _readiness = readiness
    _send_event("session.%s" % readiness, {"readiness": readiness})

## Godot raises no signal when the project starts or stops running, so the plugin polls the editor
## and reports the transition. Gofer maps these events onto its own session lifecycle.
func _track_play_state() -> void:
    var playing := EditorInterface.is_playing_scene()
    if playing == _playing:
        return
    _playing = playing
    if playing:
        _send_event("session.playing", {"readiness": _readiness})
    else:
        _send_event("session.ready", {"readiness": _readiness})

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
    }

func _undo() -> Dictionary:
    if _undo_depth <= 0:
        return _history_error("undo_unavailable", "Nothing to undo")
    var history := _scene_history()
    if history == null or not history.undo():
        return _history_error("undo_unavailable", "The editor refused to undo the last action")
    _undo_depth -= 1
    _redo_depth += 1
    _after_history_step()
    return {"undoDepth": _undo_depth, "redoDepth": _redo_depth}

func _redo() -> Dictionary:
    if _redo_depth <= 0:
        return _history_error("redo_unavailable", "Nothing to redo")
    var history := _scene_history()
    if history == null or not history.redo():
        return _history_error("redo_unavailable", "The editor refused to redo the next action")
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
func _config_error(code: String, message: String, details: Dictionary = {}) -> Dictionary:
    return {
        "_gofer_error": {
            "code": code,
            "message": message,
            "retryable": false,
            "readiness": "ready",
            "details": details
        }
    }

## Persists project.godot after a configuration change. Returns an error dictionary on failure and
## an empty one on success, matching the `_gofer_error` convention.
func _save_project_or_error() -> Dictionary:
    var error := ProjectSettings.save()
    if error != OK:
        return _config_error("project_save_failed", "Could not save project.godot (error %d)" % error)
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
                    "value": _encode_value(ProjectSettings.get_setting(name)),
                    "restartRequired": (int(info.get("usage", 0)) & PROPERTY_USAGE_RESTART_IF_CHANGED) != 0
                }
            )
    return {"settings": matches, "totalMatches": total, "truncated": total > matches.size()}

func _project_get_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return _config_error("invalid_params", "project.get_setting requires name")
    if not ProjectSettings.has_setting(name):
        return _config_error(
            "setting_not_found", "Project setting '%s' does not exist" % name, {"name": name}
        )
    return {
        "name": name,
        "value": _encode_value(ProjectSettings.get_setting(name)),
        "restartRequired": _restart_required(name)
    }

func _project_set_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or not params.has("value"):
        return _config_error("invalid_params", "project.set_setting requires name and value")
    var typed := _reserved_setting_command(name)
    if not typed.is_empty():
        return _config_error(
            "reserved_setting",
            "'%s' has a typed command; use %s instead" % [name, typed],
            {"name": name, "command": typed}
        )
    var decoded := _decode_value(params["value"])
    if not decoded["ok"]:
        return _config_error("unsupported_value", decoded["message"], {"name": name})
    var declared := _declared_setting_type(name)
    var fitted := _fit_to_declared_type(decoded["value"], declared)
    if not fitted["ok"]:
        return _config_error(
            "type_mismatch",
            "Project setting '%s': %s" % [name, fitted["message"]],
            {"name": name, "expected": type_string(declared)}
        )
    ProjectSettings.set_setting(name, fitted["value"])
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    return {"name": name, "saved": true, "restartRequired": _restart_required(name)}

## Restores a setting's default when it has one and removes it otherwise. An autoload, input
## action, or plugin entry must go through its own removal command.
func _project_reset_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return _config_error("invalid_params", "project.reset_setting requires name")
    if not ProjectSettings.has_setting(name):
        return _config_error(
            "setting_not_found", "Project setting '%s' does not exist" % name, {"name": name}
        )
    var typed := _reserved_setting_command(name)
    if not typed.is_empty():
        return _config_error(
            "reserved_setting",
            "'%s' has a typed command; use %s instead" % [name, typed],
            {"name": name, "command": typed}
        )
    if ProjectSettings.property_can_revert(name):
        ProjectSettings.set_setting(name, ProjectSettings.property_get_revert(name))
    else:
        ProjectSettings.set_setting(name, null)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
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
        return _config_error("invalid_params", "project.set_autoload requires name and path")
    if not name.is_valid_identifier():
        return _config_error(
            "invalid_params", "Autoload name '%s' is not a valid identifier" % name, {"name": name}
        )
    if name == GOFER_AUTOLOAD_NAME:
        return _config_error(
            "gofer_managed",
            "The GoferRuntime autoload is managed by Gofer and cleaned up when the session stops"
        )
    if not path.begins_with("res://"):
        return _config_error(
            "invalid_params", "Autoload path '%s' must start with res://" % path, {"path": path}
        )
    # An autoload that points nowhere is only discovered on the next editor start, which then
    # fails to load the project the session depends on.
    if not FileAccess.file_exists(path):
        return _config_error(
            "autoload_path_not_found", "No file at '%s'" % path, {"name": name, "path": path}
        )
    ProjectSettings.set_setting("autoload/" + name, ("*" if enabled else "") + path)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    return {"name": name, "path": path, "enabled": enabled}

func _project_remove_autoload(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return _config_error("invalid_params", "project.remove_autoload requires name")
    if name == GOFER_AUTOLOAD_NAME:
        return _config_error(
            "gofer_managed",
            "The GoferRuntime autoload is managed by Gofer and cleaned up when the session stops"
        )
    var setting := "autoload/" + name
    if not ProjectSettings.has_setting(setting):
        return _config_error("autoload_not_found", "No autoload named '%s'" % name, {"name": name})
    ProjectSettings.set_setting(setting, null)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
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
                "events": _encode_input_events(data.get("events", [])),
                # Godot's built-in actions all carry the ui_ prefix; custom ones never should.
                "builtIn": name.begins_with("ui_")
            }
        )
    return {"actions": actions}

func _project_set_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or name.contains("/"):
        return _config_error("invalid_params", "project.set_input_action requires a plain action name")
    var setting := "input/" + name
    var existing: Variant = ProjectSettings.get_setting(setting)
    var current: Dictionary = existing if typeof(existing) == TYPE_DICTIONARY else {}
    var deadzone := float(params.get("deadzone", current.get("deadzone", 0.5)))
    var events: Array[InputEvent] = []
    if params.has("events"):
        var decoded := _decode_input_events(params["events"])
        if not decoded["ok"]:
            return _config_error("unsupported_value", decoded["message"], {"name": name})
        events = decoded["events"]
    else:
        events.assign(current.get("events", []))
    ProjectSettings.set_setting(setting, {"deadzone": deadzone, "events": events})
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    return {"name": name, "deadzone": deadzone, "events": _encode_input_events(events)}

## Removes an input action from project.godot. A built-in ui_ action cannot be deleted; its
## binding is changed with `project.set_input_action` and given back with
## `project.reset_input_action`.
func _project_remove_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return _config_error("invalid_params", "project.remove_input_action requires name")
    var setting := "input/" + name
    if not ProjectSettings.has_setting(setting):
        return _config_error(
            "input_action_not_found", "No input action named '%s'" % name, {"name": name}
        )
    if name.begins_with("ui_"):
        return _config_error(
            "builtin_input_action",
            "'%s' is a built-in action; change its binding, or reset it with %s"
            % [name, "project.reset_input_action"],
            {"name": name, "command": "project.reset_input_action"}
        )
    ProjectSettings.set_setting(setting, null)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    return {"name": name, "removed": true}

## Drops an action's entry from project.godot. A built-in action keeps working on the bindings
## `InputMap` ships, which is what makes this a revert; a custom action simply disappears, so
## `remove` is the honest name for it and this command refuses it.
func _project_reset_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return _config_error("invalid_params", "project.reset_input_action requires name")
    if not name.begins_with("ui_"):
        return _config_error(
            "custom_input_action",
            "'%s' has no built-in binding to return to; remove it with %s"
            % [name, "project.remove_input_action"],
            {"name": name, "command": "project.remove_input_action"}
        )
    var setting := "input/" + name
    if not ProjectSettings.has_setting(setting):
        return _config_error(
            "input_action_not_found", "No input action named '%s'" % name, {"name": name}
        )
    ProjectSettings.set_setting(setting, null)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
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
        return _config_error("invalid_params", "project.set_plugin_enabled requires plugin and enabled")
    var enabled := bool(params["enabled"])
    if plugin == GOFER_PLUGIN_NAME and not enabled:
        return _config_error(
            "gofer_managed", "Disabling the Gofer plugin would sever the session carrying this call"
        )
    if not FileAccess.file_exists("res://addons/%s/plugin.cfg" % plugin):
        return _config_error("plugin_not_found", "No plugin named '%s'" % plugin, {"plugin": plugin})
    if EditorInterface.is_plugin_enabled(plugin) == enabled:
        return {"plugin": plugin, "enabled": enabled, "changed": false}
    EditorInterface.set_plugin_enabled(plugin, enabled)
    var failure := _save_project_or_error()
    if not failure.is_empty():
        return failure
    return {"plugin": plugin, "enabled": enabled, "changed": true}

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
            matches.append({"name": name, "value": _encode_value(settings.get_setting(name))})
    return {"settings": matches, "totalMatches": total, "truncated": total > matches.size()}

func _editor_get_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return _config_error("invalid_params", "editor.get_setting requires name")
    var settings := EditorInterface.get_editor_settings()
    if not settings.has_setting(name):
        return _config_error(
            "setting_not_found", "Editor setting '%s' does not exist" % name, {"name": name}
        )
    return {"name": name, "value": _encode_value(settings.get_setting(name))}

func _editor_set_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or not params.has("value"):
        return _config_error("invalid_params", "editor.set_setting requires name and value")
    var settings := EditorInterface.get_editor_settings()
    if not settings.has_setting(name):
        return _config_error(
            "setting_not_found", "Editor setting '%s' does not exist" % name, {"name": name}
        )
    var decoded := _decode_value(params["value"])
    if not decoded["ok"]:
        return _config_error("unsupported_value", decoded["message"], {"name": name})
    settings.set_setting(name, decoded["value"])
    return {"name": name, "machineWide": true}

func _scene_list() -> Dictionary:
    return {"scenes": Array(EditorInterface.get_open_scenes())}

func _scene_open(params: Dictionary) -> Dictionary:
    var path: String = params.get("path", "")
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
    _set_readiness("importing")
    EditorInterface.open_scene_from_path(path)
    _current_scene_path = path
    _scene_revision = 0
    _scene_dirty = false
    _undo_depth = 0
    _redo_depth = 0
    _set_readiness("ready")
    return {"scene": path, "revision": _scene_revision, "dirty": _scene_dirty}

func _scene_create(params: Dictionary) -> Dictionary:
    var path: String = params.get("path", "")
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
    root.name = path.get_file().get_basename()
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
    EditorInterface.open_scene_from_path(path)
    _current_scene_path = path
    _scene_revision = 0
    _scene_dirty = false
    _undo_depth = 0
    _redo_depth = 0
    _set_readiness("ready")
    return {"scene": path, "revision": _scene_revision, "dirty": _scene_dirty}

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
    _scene_dirty = false
    return {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_dirty}

func _scene_save_as(params: Dictionary) -> Dictionary:
    var path: String = params.get("path", "")
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
    EditorInterface.save_scene_as(path)
    _current_scene_path = path
    _scene_dirty = false
    return {"scene": path, "revision": _scene_revision, "dirty": _scene_dirty}

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
    _set_readiness("importing")
    EditorInterface.reload_scene_from_path(_current_scene_path)
    _scene_revision = 0
    _scene_dirty = false
    _undo_depth = 0
    _redo_depth = 0
    _set_readiness("ready")
    return {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_dirty}

func _scene_tree() -> Dictionary:
    var root := _edited_root()
    if root == null:
        return {"root": null}
    return {"root": _node_summary(root)}

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
                "message": "node.create requires scene, parent, name, and type",
                "retryable": false,
                "readiness": "ready",
                "details": {}
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

    _bump_revision()
    return {"node": _node_path(node)}

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
                "message": "node.duplicate requires scene and node",
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
                "message": "node.rename requires scene, node, and name",
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
                "message": "node.reparent requires scene, node, and newParent",
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
                "message": "node.delete requires scene and node",
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
                "message": "node.set_property requires scene, node, property, and value",
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

    var decoded := _decode_value(value)
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
    var new_value: Variant = decoded["value"]

    var old_value: Variant = node.get(property)
    var undo := _begin_action("Set %s.%s" % [node.name, property])
    undo.add_do_method(node, "set", property, new_value)
    undo.add_undo_method(node, "set", property, old_value)
    undo.commit_action()

    _bump_revision()
    return {"node": _node_path(node), "property": property}

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
                "message": "node.inspect requires scene and node",
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
        "groups": Array(node.get_groups()),
    }

func _require_current_scene(scene: String) -> Dictionary:
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
        "path": _node_path(node),
        "children": children
    }

## Encodes every item of an array-like value.
func _encode_items(value: Variant) -> Array:
    var encoded: Array = []
    for item in value:
        encoded.append(_encode_value(item))
    return encoded

## Encodes a Variant as a tagged protocol value, the mirror of `_decode_value`. A reference to an
## object — a node, a resource without a path, anything live — is described rather than encoded,
## and anything else becomes `opaque`; those tags are read-only, because nothing on the far side
## can rebuild what they point at.
func _encode_value(value: Variant) -> Dictionary:
    match typeof(value):
        TYPE_NIL:
            return {"type": "null", "value": null}
        TYPE_BOOL:
            return {"type": "bool", "value": value}
        TYPE_INT:
            return {"type": "int", "value": value}
        TYPE_FLOAT:
            return {"type": "float", "value": value}
        TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH:
            return {"type": "string", "value": str(value)}
        TYPE_VECTOR2:
            return {"type": "vector2", "value": [value.x, value.y]}
        TYPE_VECTOR2I:
            return {"type": "vector2i", "value": [value.x, value.y]}
        TYPE_VECTOR3:
            return {"type": "vector3", "value": [value.x, value.y, value.z]}
        TYPE_VECTOR3I:
            return {"type": "vector3i", "value": [value.x, value.y, value.z]}
        TYPE_VECTOR4, TYPE_QUATERNION:
            var kind := "vector4" if typeof(value) == TYPE_VECTOR4 else "quaternion"
            return {"type": kind, "value": [value.x, value.y, value.z, value.w]}
        TYPE_VECTOR4I:
            return {"type": "vector4i", "value": [value.x, value.y, value.z, value.w]}
        TYPE_COLOR:
            return {"type": "color", "value": [value.r, value.g, value.b, value.a]}
        TYPE_RECT2:
            return {"type": "rect2", "value": [value.position.x, value.position.y, value.size.x, value.size.y]}
        TYPE_RECT2I:
            return {"type": "rect2i", "value": [value.position.x, value.position.y, value.size.x, value.size.y]}
        TYPE_PLANE:
            return {"type": "plane", "value": [value.normal.x, value.normal.y, value.normal.z, value.d]}
        TYPE_TRANSFORM2D:
            return {
                "type": "transform2d",
                "value": [value.x.x, value.x.y, value.y.x, value.y.y, value.origin.x, value.origin.y]
            }
        TYPE_BASIS:
            return {
                "type": "basis",
                "value": [
                    value.x.x, value.x.y, value.x.z,
                    value.y.x, value.y.y, value.y.z,
                    value.z.x, value.z.y, value.z.z
                ]
            }
        TYPE_TRANSFORM3D:
            return {
                "type": "transform3d",
                "value": [
                    value.basis.x.x, value.basis.x.y, value.basis.x.z,
                    value.basis.y.x, value.basis.y.y, value.basis.y.z,
                    value.basis.z.x, value.basis.z.y, value.basis.z.z,
                    value.origin.x, value.origin.y, value.origin.z
                ]
            }
        TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, \
        TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, \
        TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY, \
        TYPE_PACKED_VECTOR4_ARRAY:
            return {"type": "array", "value": _encode_items(value)}
        TYPE_DICTIONARY:
            var entries: Array = []
            for key in value:
                entries.append({"key": _encode_value(key), "value": _encode_value(value[key])})
            return {"type": "dictionary", "value": entries}
        TYPE_OBJECT:
            if value is Resource and not (value as Resource).resource_path.is_empty():
                return {
                    "type": "resource",
                    "value": {
                        "path": (value as Resource).resource_path, "resourceType": value.get_class()
                    }
                }
            if value is Node:
                return {
                    "type": "node",
                    "value": {
                        "path": str((value as Node).get_path()),
                        "nodeType": value.get_class(),
                        "instanceId": value.get_instance_id()
                    }
                }
            return {
                "type": "object",
                "value": {"className": value.get_class(), "instanceId": value.get_instance_id()}
            }
    return {
        "type": "opaque",
        "value": {"typeName": type_string(typeof(value)), "text": var_to_str(value)}
    }

## Summarizes input events for the wire. Key events name their physical key so they can be rebuilt
## with `OS.find_keycode_from_string` on the way back in.
func _encode_input_events(events: Array) -> Array:
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

## Builds typed input events from their wire summaries. Returns the same ok/value/message shape as
## `_decode_value`, with `events` in place of `value`, so malformed events are rejected rather than
## coerced into an empty binding.
func _decode_input_events(raw: Variant) -> Dictionary:
    if typeof(raw) != TYPE_ARRAY:
        return _decode_failed("events must be an array of input event objects")
    var events: Array[InputEvent] = []
    for entry in raw:
        if typeof(entry) != TYPE_DICTIONARY:
            return _decode_failed("an input event must be an object carrying a kind")
        var kind := str(entry.get("kind", ""))
        match kind:
            "key":
                var key_name := str(entry.get("key", ""))
                var code := OS.find_keycode_from_string(key_name)
                if code == KEY_NONE:
                    return _decode_failed("Unknown key '%s'" % key_name)
                var key_event := InputEventKey.new()
                key_event.physical_keycode = code
                events.append(key_event)
            "mouse_button":
                var mouse_button := int(entry.get("button", 0))
                if mouse_button < 1:
                    return _decode_failed("A mouse_button event requires a button index of 1 or higher")
                var mouse_event := InputEventMouseButton.new()
                mouse_event.button_index = mouse_button
                events.append(mouse_event)
            "joypad_button":
                var pad_button := int(entry.get("button", -1))
                if pad_button < 0:
                    return _decode_failed("A joypad_button event requires a button index")
                var joypad_event := InputEventJoypadButton.new()
                joypad_event.button_index = pad_button
                events.append(joypad_event)
            _:
                return _decode_failed("Input event kind '%s' is not supported" % kind)
    return {"ok": true, "events": events, "message": ""}

## Decodes one tagged protocol value into a Variant.
##
## Returns `{"ok": bool, "value": Variant, "message": String}`. A malformed payload is rejected
## rather than coerced, so a bad Vector2 never lands on a node as (0, 0).
func _decode_value(value: Variant) -> Dictionary:
    if typeof(value) != TYPE_DICTIONARY:
        return _decode_failed("A value must be a tagged object with a type and a value")
    var dict := value as Dictionary
    var kind: String = dict.get("type", "")
    var payload: Variant = dict.get("value", null)
    match kind:
        "null":
            return _decoded(null)
        "bool":
            if typeof(payload) != TYPE_BOOL:
                return _decode_failed("A bool value requires a boolean payload")
            return _decoded(payload)
        "int":
            if not typeof(payload) in [TYPE_INT, TYPE_FLOAT]:
                return _decode_failed("An int value requires a numeric payload")
            return _decoded(int(payload))
        "float":
            if not typeof(payload) in [TYPE_INT, TYPE_FLOAT]:
                return _decode_failed("A float value requires a numeric payload")
            return _decoded(float(payload))
        "string":
            if typeof(payload) != TYPE_STRING:
                return _decode_failed("A string value requires a string payload")
            return _decoded(payload)
        "vector2":
            var v2 := _numbers(payload, 2)
            return _decode_failed("A vector2 value requires two numbers") if v2.is_empty() else _decoded(Vector2(v2[0], v2[1]))
        "vector2i":
            var v2i := _numbers(payload, 2)
            return _decode_failed("A vector2i value requires two numbers") if v2i.is_empty() else _decoded(Vector2i(int(v2i[0]), int(v2i[1])))
        "vector3":
            var v3 := _numbers(payload, 3)
            return _decode_failed("A vector3 value requires three numbers") if v3.is_empty() else _decoded(Vector3(v3[0], v3[1], v3[2]))
        "vector3i":
            var v3i := _numbers(payload, 3)
            return _decode_failed("A vector3i value requires three numbers") if v3i.is_empty() else _decoded(Vector3i(int(v3i[0]), int(v3i[1]), int(v3i[2])))
        "vector4":
            var v4 := _numbers(payload, 4)
            return _decode_failed("A vector4 value requires four numbers") if v4.is_empty() else _decoded(Vector4(v4[0], v4[1], v4[2], v4[3]))
        "vector4i":
            var v4i := _numbers(payload, 4)
            return _decode_failed("A vector4i value requires four numbers") if v4i.is_empty() else _decoded(Vector4i(int(v4i[0]), int(v4i[1]), int(v4i[2]), int(v4i[3])))
        "quaternion":
            var quaternion := _numbers(payload, 4)
            return _decode_failed("A quaternion value requires four numbers") if quaternion.is_empty() else _decoded(Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]))
        "color":
            var rgba := _numbers(payload, 4)
            return _decode_failed("A color value requires four numbers") if rgba.is_empty() else _decoded(Color(rgba[0], rgba[1], rgba[2], rgba[3]))
        "rect2":
            var r2 := _numbers(payload, 4)
            return _decode_failed("A rect2 value requires four numbers") if r2.is_empty() else _decoded(Rect2(r2[0], r2[1], r2[2], r2[3]))
        "rect2i":
            var r2i := _numbers(payload, 4)
            return _decode_failed("A rect2i value requires four numbers") if r2i.is_empty() else _decoded(Rect2i(int(r2i[0]), int(r2i[1]), int(r2i[2]), int(r2i[3])))
        "plane":
            var plane := _numbers(payload, 4)
            return _decode_failed("A plane value requires four numbers") if plane.is_empty() else _decoded(Plane(Vector3(plane[0], plane[1], plane[2]), plane[3]))
        "transform2d":
            var t2d := _numbers(payload, 6)
            if t2d.is_empty():
                return _decode_failed("A transform2d value requires six numbers")
            return _decoded(Transform2D(Vector2(t2d[0], t2d[1]), Vector2(t2d[2], t2d[3]), Vector2(t2d[4], t2d[5])))
        "basis":
            var basis := _numbers(payload, 9)
            if basis.is_empty():
                return _decode_failed("A basis value requires nine numbers")
            return _decoded(_basis_from(basis))
        "transform3d":
            var t3d := _numbers(payload, 12)
            if t3d.is_empty():
                return _decode_failed("A transform3d value requires twelve numbers")
            return _decoded(Transform3D(_basis_from(t3d), Vector3(t3d[9], t3d[10], t3d[11])))
        "array":
            return _decode_items(payload)
        "dictionary":
            return _decode_dictionary(payload)
        "resource":
            if typeof(payload) != TYPE_DICTIONARY:
                return _decode_failed("A resource value requires an object carrying a path")
            var path: String = (payload as Dictionary).get("path", "")
            if path.is_empty():
                return _decode_failed("A resource value requires a non-empty path")
            var resource := load(path)
            if resource == null:
                return _decode_failed("Resource %s could not be loaded" % path)
            return _decoded(resource)
    return _decode_failed("Value type '%s' is not supported" % kind)

## Fits a decoded value onto the type a setting was declared with, in the `_decode_value` shape.
##
## The wire has one array tag, so a setting the engine declared as a packed array is written back
## with a plain array; the declared type is what says which packed array to rebuild. Every element
## is checked first, because `type_convert` coerces a mistyped element instead of refusing it — a
## string in a PackedInt32Array would silently become 0.
func _fit_to_declared_type(value: Variant, declared: int) -> Dictionary:
    if declared == TYPE_NIL or typeof(value) == declared:
        return _decoded(value)
    # A whole number is the natural way to write a float setting, and a string is the only way the
    # protocol carries a StringName or a NodePath.
    if declared == TYPE_FLOAT and typeof(value) == TYPE_INT:
        return _decoded(float(value))
    if typeof(value) == TYPE_STRING and declared in [TYPE_STRING_NAME, TYPE_NODE_PATH]:
        return _decoded(type_convert(value, declared))
    if typeof(value) == TYPE_ARRAY and PACKED_ARRAY_ELEMENTS.has(declared):
        var element: int = PACKED_ARRAY_ELEMENTS[declared]
        for index in (value as Array).size():
            var actual := typeof(value[index])
            # A whole number is a valid way to write one element of a float array.
            if actual == element or (element == TYPE_FLOAT and actual == TYPE_INT):
                continue
            return _decode_failed(
                "a %s takes %s elements, but item %d is %s"
                % [type_string(declared), type_string(element), index, type_string(actual)]
            )
        return _decoded(type_convert(value, declared))
    return _decode_failed(
        "expected %s, received %s" % [type_string(declared), type_string(typeof(value))]
    )

## Rebuilds a Basis from nine numbers laid out as three columns, the order `_encode_value` writes.
func _basis_from(numbers: PackedFloat64Array) -> Basis:
    return Basis(
        Vector3(numbers[0], numbers[1], numbers[2]),
        Vector3(numbers[3], numbers[4], numbers[5]),
        Vector3(numbers[6], numbers[7], numbers[8])
    )

## Decodes every tagged item of an array payload into an untyped Array.
func _decode_items(payload: Variant) -> Dictionary:
    if typeof(payload) != TYPE_ARRAY:
        return _decode_failed("An array value requires an array of tagged values")
    var items: Array = []
    for entry in payload:
        var decoded := _decode_value(entry)
        if not decoded["ok"]:
            return decoded
        items.append(decoded["value"])
    return _decoded(items)

## Rebuilds a Dictionary from the `{"key": ..., "value": ...}` entries `_encode_value` writes.
func _decode_dictionary(payload: Variant) -> Dictionary:
    if typeof(payload) != TYPE_ARRAY:
        return _decode_failed("A dictionary value requires an array of key and value entries")
    var result := {}
    for entry in payload:
        if typeof(entry) != TYPE_DICTIONARY or not (entry as Dictionary).has("key") \
                or not (entry as Dictionary).has("value"):
            return _decode_failed("A dictionary entry requires a key and a value")
        var key := _decode_value((entry as Dictionary)["key"])
        if not key["ok"]:
            return key
        var item := _decode_value((entry as Dictionary)["value"])
        if not item["ok"]:
            return item
        result[key["value"]] = item["value"]
    return _decoded(result)

func _decoded(value: Variant) -> Dictionary:
    return {"ok": true, "value": value, "message": ""}

func _decode_failed(message: String) -> Dictionary:
    return {"ok": false, "value": null, "message": message}

## Returns `size` floats from `payload`, or an empty array when the payload is not that many
## numbers. Callers treat empty as malformed, so a zero-length component list is never valid.
func _numbers(payload: Variant, size: int) -> PackedFloat64Array:
    if typeof(payload) != TYPE_ARRAY:
        return PackedFloat64Array()
    var array := payload as Array
    if array.size() != size:
        return PackedFloat64Array()
    var numbers := PackedFloat64Array()
    for item in array:
        if not typeof(item) in [TYPE_INT, TYPE_FLOAT]:
            return PackedFloat64Array()
        numbers.append(float(item))
    return numbers

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
