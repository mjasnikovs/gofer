extends SceneTree

const PROTOCOL_VERSION := 1
const SUPPORTED_VERSIONS := [PROTOCOL_VERSION]

var server := TCPServer.new()
var peer: StreamPeerTCP
var input_buffer := ""
var opened_scene_path := "res://main.tscn"
var opened_scene: Node

func _initialize() -> void:
    var port := _argument_port()
    if port <= 0:
        push_error("The bridge requires --port=<number>")
        quit(2)
        return
    var error := server.listen(port, "127.0.0.1")
    if error != OK:
        push_error("Could not listen on bridge port %s: %s" % [port, error_string(error)])
        quit(2)
        return
    print("GOFER_BRIDGE_READY:%s" % port)

func _process(_delta: float) -> bool:
    if peer == null and server.is_connection_available():
        peer = server.take_connection()
    if peer == null:
        return false
    peer.poll()
    if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
        peer = null
        input_buffer = ""
        return false
    var available := peer.get_available_bytes()
    if available <= 0:
        return false
    input_buffer += peer.get_utf8_string(available)
    while input_buffer.contains("\n"):
        var boundary := input_buffer.find("\n")
        var line := input_buffer.left(boundary)
        input_buffer = input_buffer.substr(boundary + 1)
        if not line.strip_edges().is_empty():
            _handle_line(line)
    return false

func _argument_port() -> int:
    for argument in OS.get_cmdline_user_args():
        if argument.begins_with("--port="):
            return argument.trim_prefix("--port=").to_int()
    return 0

func _handle_line(line: String) -> void:
    var request: Variant = JSON.parse_string(line)
    if typeof(request) != TYPE_DICTIONARY:
        _send_error("unknown", "invalid_protocol_payload", "The request must be valid JSON", {})
        return
    var request_id: String = str(request.get("id", "unknown"))
    var version: Variant = request.get("protocolVersion")
    if not _is_supported_version(version):
        _send_error(
            request_id,
            "unsupported_protocol_version",
            "Protocol version %s is not supported" % version,
            {"supportedVersions": SUPPORTED_VERSIONS}
        )
        return
    var command: String = str(request.get("command", ""))
    var params: Dictionary = request.get("params", {})
    match command:
        "handshake":
            _send_result(request_id, {"server": "godot", "acceptedVersion": PROTOCOL_VERSION})
        "open_project":
            _open_scene(request_id, params)
        "read_scene_tree":
            _read_scene_tree(request_id)
        "add_node":
            _add_node(request_id, params)
        "set_property":
            _set_property(request_id, params)
        "save_scene":
            _save_scene(request_id)
        "reload_scene":
            _reload_scene(request_id)
        "run_scene":
            _run_scene(request_id)
        "validate_script":
            _validate_script(request_id, params)
        "disconnect":
            _send_result(request_id, {"disconnected": true})
            peer.disconnect_from_host()
        "shutdown":
            _send_result(request_id, {"shutdown": true})
            if opened_scene != null:
                opened_scene.free()
                opened_scene = null
            quit(0)
        _:
            _send_error(request_id, "unsupported_command", "The command is not supported", {"command": command})

func _is_supported_version(version: Variant) -> bool:
    if typeof(version) != TYPE_INT and typeof(version) != TYPE_FLOAT:
        return false
    return version == floor(version) and int(version) in SUPPORTED_VERSIONS

func _open_scene(request_id: String, params: Dictionary) -> void:
    var path: String = str(params.get("scene", "res://main.tscn"))
    if not path.begins_with("res://") or not path.ends_with(".tscn"):
        _send_error(request_id, "invalid_scene_path", "The scene path is invalid", {})
        return
    var packed := ResourceLoader.load(path, "PackedScene") as PackedScene
    if packed == null:
        _send_error(request_id, "scene_open_failed", "The scene could not be opened", {"scene": path})
        return
    if opened_scene != null:
        opened_scene.free()
    opened_scene_path = path
    opened_scene = packed.instantiate()
    _send_result(request_id, {"scene": path, "root": opened_scene.name})

func _read_scene_tree(request_id: String) -> void:
    if not _require_scene(request_id):
        return
    _send_result(request_id, {"tree": _serialize_node(opened_scene)})

func _serialize_node(node: Node) -> Dictionary:
    var children: Array[Dictionary] = []
    for child in node.get_children():
        children.append(_serialize_node(child))
    return {"name": node.name, "type": node.get_class(), "children": children}

func _add_node(request_id: String, params: Dictionary) -> void:
    if not _require_scene(request_id):
        return
    var name: String = str(params.get("name", ""))
    var type: String = str(params.get("type", "Node"))
    if name.is_empty() or opened_scene.find_child(name, true, false) != null:
        _send_error(request_id, "invalid_node", "The node name is empty or already exists", {})
        return
    var node: Node
    if type == "Node2D":
        node = Node2D.new()
    elif type == "Node":
        node = Node.new()
    else:
        _send_error(request_id, "unsupported_node_type", "The node type is not supported", {"type": type})
        return
    node.name = name
    opened_scene.add_child(node)
    node.owner = opened_scene
    _send_result(request_id, {"path": "%s/%s" % [opened_scene.name, node.name], "type": node.get_class()})

func _set_property(request_id: String, params: Dictionary) -> void:
    if not _require_scene(request_id):
        return
    var node_name: String = str(params.get("node", ""))
    var property: String = str(params.get("property", ""))
    var node := opened_scene.find_child(node_name, true, false)
    if node == null:
        _send_error(request_id, "node_not_found", "The node was not found", {"node": node_name})
        return
    var value: Variant = params.get("value")
    if property == "position" and value is Array and value.size() == 2 and node is Node2D:
        value = Vector2(float(value[0]), float(value[1]))
    if not _has_property(node, property):
        _send_error(request_id, "property_not_found", "The property was not found", {"property": property})
        return
    node.set(property, value)
    _send_result(request_id, {"node": node_name, "property": property, "value": _wire_value(node.get(property))})

func _has_property(node: Node, property: String) -> bool:
    for entry in node.get_property_list():
        if entry.name == property:
            return true
    return false

func _wire_value(value: Variant) -> Variant:
    if value is Vector2:
        return [value.x, value.y]
    return value

func _save_scene(request_id: String) -> void:
    if not _require_scene(request_id):
        return
    var packed := PackedScene.new()
    var pack_error := packed.pack(opened_scene)
    if pack_error != OK:
        _send_error(request_id, "scene_save_failed", error_string(pack_error), {})
        return
    var save_error := ResourceSaver.save(packed, opened_scene_path)
    if save_error != OK:
        _send_error(request_id, "scene_save_failed", error_string(save_error), {})
        return
    _send_result(request_id, {"scene": opened_scene_path, "saved": true})

func _reload_scene(request_id: String) -> void:
    _open_scene(request_id, {"scene": opened_scene_path})

func _run_scene(request_id: String) -> void:
    if not _require_scene(request_id):
        return
    _send_result(request_id, {"output": [{"level": "info", "message": "Scene instantiated"}], "tree": _serialize_node(opened_scene)})

func _validate_script(request_id: String, params: Dictionary) -> void:
    var path: String = str(params.get("path", ""))
    if not path.begins_with("res://") or not path.ends_with(".gd"):
        _send_error(request_id, "invalid_script_path", "The script path is invalid", {})
        return
    var file := FileAccess.open(path, FileAccess.READ)
    if file == null:
        _send_error(request_id, "script_error", "The script could not be read", {"path": path})
        return
    var script := GDScript.new()
    script.source_code = file.get_as_text()
    if script.reload() != OK:
        _send_error(request_id, "script_error", "The script could not be parsed", {"path": path})
        return
    _send_result(request_id, {"path": path, "valid": true})

func _require_scene(request_id: String) -> bool:
    if opened_scene != null:
        return true
    _send_error(request_id, "scene_not_open", "No scene is open", {})
    return false

func _send_result(request_id: String, result: Variant) -> void:
    _send({"protocolVersion": PROTOCOL_VERSION, "id": request_id, "result": result})

func _send_error(request_id: String, code: String, message: String, details: Dictionary) -> void:
    _send({
        "protocolVersion": PROTOCOL_VERSION,
        "id": request_id,
        "error": {"code": code, "message": message, "details": details}
    })

func _send(payload: Dictionary) -> void:
    if peer != null:
        peer.put_data((JSON.stringify(payload) + "\n").to_utf8_buffer())
