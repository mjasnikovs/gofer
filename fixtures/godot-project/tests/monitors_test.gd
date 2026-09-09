extends SceneTree

## Every `Performance.Monitor` the engine publishes, through the op that answers for them.
##
## `runtime.gd` resolves a monitor name through `ClassDB` rather than from a table, so this is what
## says the engine really answers for all of them and not only the ones a table once listed. The
## helper reads nothing but `Performance`, so it needs no game and no editor: it is instanced here
## and never enters a tree.
const RUNTIME_SOURCE := "res://addons/gofer/runtime.gd"

func _initialize() -> void:
    var failures: Array[String] = []
    var helper := _load_helper(failures)
    if helper != null:
        _test_every_monitor_answers(helper, failures)
        _test_the_defaults(helper, failures)
        _test_a_name_nothing_publishes(helper, failures)
        helper.free()
    if failures.is_empty():
        print("Gofer Godot runtime monitors passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

func _load_helper(failures: Array[String]) -> Node:
    if not ResourceLoader.exists(RUNTIME_SOURCE):
        failures.append("The addon runtime script is not at %s" % RUNTIME_SOURCE)
        return null
    var script := load(RUNTIME_SOURCE) as GDScript
    return script.new() as Node

func _test_every_monitor_answers(helper: Node, failures: Array[String]) -> void:
    var answered := 0
    for name in ClassDB.class_get_enum_constants(&"Performance", &"Monitor"):
        if ClassDB.class_get_integer_constant(&"Performance", name) >= Performance.MONITOR_MAX:
            continue
        var result: Dictionary = helper.call("_op_monitors", {"monitors": [name]})
        if not result.get("ok", false):
            failures.append("%s was refused: %s" % [name, result.get("message", "")])
            continue
        var values: Dictionary = result["monitors"]
        if not values.has(name):
            failures.append("%s answered under another key: %s" % [name, values.keys()])
        answered += 1
    if answered != Performance.MONITOR_MAX:
        failures.append(
            "%d of the engine's %d monitors answered" % [answered, Performance.MONITOR_MAX]
        )
    print("Gofer Godot answered %d performance monitors" % answered)

func _test_the_defaults(helper: Node, failures: Array[String]) -> void:
    var result: Dictionary = helper.call("_op_monitors", {})
    if not result.get("ok", false):
        failures.append("A call naming no monitor must answer: %s" % result.get("message", ""))
        return
    var values: Dictionary = result["monitors"]
    for wanted in ["TIME_FPS", "MEMORY_STATIC", "OBJECT_NODE_COUNT"]:
        if not values.has(wanted):
            failures.append("A call naming no monitor must answer %s" % wanted)

## `MONITOR_MAX` is an integer constant of `Performance` like the monitors are, so a name check that
## only asked `ClassDB` would take it and then read past the last monitor.
func _test_a_name_nothing_publishes(helper: Node, failures: Array[String]) -> void:
    for name in ["frames_per_second", "MONITOR_MAX"]:
        var result: Dictionary = helper.call("_op_monitors", {"monitors": [name]})
        if result.get("ok", false):
            failures.append("%s is not a monitor and must be refused" % name)
            continue
        if str(result.get("code", "")) != "unknown_monitor":
            failures.append("%s must be refused as unknown_monitor" % name)
        if not str(result.get("message", "")).contains("schema"):
            failures.append("A refused monitor must point at where the names are")
