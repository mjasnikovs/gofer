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
            "capabilities": ["session", "scene", "node", "project"]
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
        "color":
            var rgba := _numbers(payload, 4)
            return _decode_failed("A color value requires four numbers") if rgba.is_empty() else _decoded(Color(rgba[0], rgba[1], rgba[2], rgba[3]))
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
