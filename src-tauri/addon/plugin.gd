@tool
extends EditorPlugin

## The Gofer editor plugin.
##
## Gofer stages this addon into the active task worktree and removes it again when the session
## stops. It connects outward to Gofer's loopback RPC server using the port and token passed in the
## process environment, then answers inspection and undoable scene-authoring requests on Godot's
## main thread.

const PROTOCOL_VERSION := 2

var _peer: StreamPeerTCP
var _status: int = -1
var _pending_line: String = ""
var _ready_notified: bool = false
var _readiness: String = "starting"

# Edited scene state. A revision starts at 0 when a scene is opened or created and increments on
# every accepted mutation. Save keeps the revision and clears dirty; reload resets both.
var _current_scene_path: String = ""
var _scene_revision: int = 0
var _scene_dirty: bool = false
var _undo_depth: int = 0
var _redo_depth: int = 0

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
        "id": "handshake-1",
        "token": _rpc_token(),
        "acceptedVersions": [PROTOCOL_VERSION],
        "client": {
            "name": "gofer-godot-addon",
            "addonVersion": _addon_version(),
            "engineVersion": Engine.get_version_info()["string"],
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

func _bump_revision() -> void:
    _scene_revision += 1
    _scene_dirty = true
    _undo_depth += 1
    _redo_depth = 0
    _send_event("scene.changed", {"scene": _current_scene_path, "revision": _scene_revision, "dirty": _scene_dirty})

func _set_readiness(readiness: String) -> void:
    _readiness = readiness
    _send_event("session.%s" % readiness, {"readiness": readiness})

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
        return {
            "_gofer_error": {
                "code": "undo_unavailable",
                "message": "Nothing to undo",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var undo := get_undo_redo()
    undo.undo()
    _undo_depth -= 1
    _redo_depth += 1
    _bump_revision()
    return {"undoDepth": _undo_depth, "redoDepth": _redo_depth}

func _redo() -> Dictionary:
    if _redo_depth <= 0:
        return {
            "_gofer_error": {
                "code": "redo_unavailable",
                "message": "Nothing to redo",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }
    var undo := get_undo_redo()
    undo.redo()
    _undo_depth += 1
    _redo_depth -= 1
    _bump_revision()
    return {"undoDepth": _undo_depth, "redoDepth": _redo_depth}

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
    var undo := get_undo_redo()
    undo.create_action("Create %s" % node_name)
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
    var undo := get_undo_redo()
    undo.create_action("Duplicate %s" % node.name)
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

    var undo := get_undo_redo()
    undo.create_action("Rename %s" % old_name)
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

    var undo := get_undo_redo()
    undo.create_action("Reparent %s" % node.name)
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

    var undo := get_undo_redo()
    undo.create_action("Delete %s" % node.name)
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

    var new_value: Variant = _from_tagged(value)
    if new_value == null and value != null and value.get("type", "") != "null":
        return {
            "_gofer_error": {
                "code": "unsupported_value",
                "message": "The supplied value type is not supported",
                "retryable": false,
                "readiness": "ready",
                "details": {}
            }
        }

    var old_value: Variant = node.get(property)
    var undo := get_undo_redo()
    undo.create_action("Set %s.%s" % [node.name, property])
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

func _from_tagged(value: Variant) -> Variant:
    if typeof(value) != TYPE_DICTIONARY:
        return null
    var dict := value as Dictionary
    var kind: String = dict.get("type", "")
    var payload: Variant = dict.get("value", null)
    match kind:
        "null":
            return null
        "bool":
            return payload if typeof(payload) == TYPE_BOOL else null
        "int":
            return int(payload) if typeof(payload) in [TYPE_INT, TYPE_FLOAT] else null
        "float":
            return float(payload) if typeof(payload) in [TYPE_INT, TYPE_FLOAT] else null
        "string":
            return payload if typeof(payload) == TYPE_STRING else null
        "vector2":
            return _to_vector2(payload)
        "vector2i":
            return _to_vector2i(payload)
        "vector3":
            return _to_vector3(payload)
        "vector3i":
            return _to_vector3i(payload)
        "vector4":
            return _to_vector4(payload)
        "color":
            return _to_color(payload)
        "resource":
            if typeof(payload) != TYPE_DICTIONARY:
                return null
            var path: String = payload.get("path", "")
            if path.is_empty():
                return null
            return load(path)
    return null

func _to_vector2(payload: Variant) -> Vector2:
    if typeof(payload) != TYPE_ARRAY or (payload as Array).size() != 2:
        return Vector2.ZERO
    var arr := payload as Array
    return Vector2(float(arr[0]), float(arr[1]))

func _to_vector2i(payload: Variant) -> Vector2i:
    if typeof(payload) != TYPE_ARRAY or (payload as Array).size() != 2:
        return Vector2i.ZERO
    var arr := payload as Array
    return Vector2i(int(arr[0]), int(arr[1]))

func _to_vector3(payload: Variant) -> Vector3:
    if typeof(payload) != TYPE_ARRAY or (payload as Array).size() != 3:
        return Vector3.ZERO
    var arr := payload as Array
    return Vector3(float(arr[0]), float(arr[1]), float(arr[2]))

func _to_vector3i(payload: Variant) -> Vector3i:
    if typeof(payload) != TYPE_ARRAY or (payload as Array).size() != 3:
        return Vector3i.ZERO
    var arr := payload as Array
    return Vector3i(int(arr[0]), int(arr[1]), int(arr[2]))

func _to_vector4(payload: Variant) -> Vector4:
    if typeof(payload) != TYPE_ARRAY or (payload as Array).size() != 4:
        return Vector4.ZERO
    var arr := payload as Array
    return Vector4(float(arr[0]), float(arr[1]), float(arr[2]), float(arr[3]))

func _to_color(payload: Variant) -> Color:
    if typeof(payload) != TYPE_ARRAY or (payload as Array).size() != 4:
        return Color.WHITE
    var arr := payload as Array
    return Color(float(arr[0]), float(arr[1]), float(arr[2]), float(arr[3]))

func _send_event(event: String, data: Dictionary) -> void:
    var envelope := {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "event",
        "sequence": _next_sequence(),
        "event": event,
        "data": data
    }
    _put_json(envelope)

var _sequence: int = 0
func _next_sequence() -> int:
    _sequence += 1
    return _sequence

func _put_json(value: Variant) -> void:
    if _peer == null or _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        return
    var text := JSON.stringify(value)
    _peer.put_data((text + "\n").to_utf8_buffer())
