@tool
extends EditorPlugin

## The Gofer editor plugin.
##
## Gofer stages this addon into the active task worktree and removes it again when the session
## stops. It connects outward to Gofer's loopback RPC server using the port and token passed in the
## process environment, then answers read-only inspection requests on Godot's main thread.

const PROTOCOL_VERSION := 2

var _peer: StreamPeerTCP
var _status: int = -1
var _pending_line: String = ""
var _ready_notified: bool = false

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
        return
    if status != StreamPeerTCP.STATUS_CONNECTED:
        return

    if not _ready_notified:
        _ready_notified = true
        _send_event("session.ready", {"ready": true})

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
            "capabilities": ["session", "scene", "project"]
        }
    }
    _put_json(handshake)

func _addon_version() -> String:
    var config := ConfigFile.new()
    var path: String = get_script().get_path().get_base_dir().path_join("plugin.cfg")
    if config.load(path) == OK:
        return config.get_value("plugin", "version", "2.0.0")
    return "2.0.0"

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
    var id := envelope.get("id", "")
    var command := envelope.get("command", "")
    var params := envelope.get("params", {})
    var result := _dispatch_command(command, params)
    var response := {
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "response",
        "id": id,
        "result": result
    }
    _put_json(response)

func _dispatch_command(command: String, _params: Dictionary) -> Dictionary:
    match command:
        "session.get_state":
            return {"state": "ready"}
        "project.get_settings":
            return _project_settings()
        "scene.get_tree":
            return _scene_tree()
        "session.heartbeat":
            return {}
    return {
        "error": {
            "code": "unknown_command",
            "message": "Command '%s' is not implemented" % command,
            "retryable": false,
            "readiness": "ready",
            "details": {}
        }
    }

func _project_settings() -> Dictionary:
    return {
        "projectName": ProjectSettings.get_setting_with_override("application/config/name"),
        "mainScene": ProjectSettings.get_setting_with_override("application/run/main_scene"),
        "renderingMethod": ProjectSettings.get_setting_with_override("rendering/renderer/rendering_method")
    }

func _scene_tree() -> Dictionary:
    var editor := get_editor_interface()
    var root := editor.get_edited_scene_root()
    if root == null:
        return {"root": null}
    return {"root": _node_summary(root)}

func _node_summary(node: Node) -> Dictionary:
    var children: Array[Dictionary] = []
    for i in range(node.get_child_count()):
        children.append(_node_summary(node.get_child(i)))
    return {
        "name": node.name,
        "type": node.get_class(),
        "children": children
    }

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
