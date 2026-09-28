extends SceneTree


## Staged into the fixture project by `scripts/godot-test.mjs`, fresh from source for this run.
##
## One tree serves both spellings, as it does in a game: `Main` under this SceneTree's `root` is
## `/Main/...` to the editor's lookups and `/root/Main/...` to the running game's.
const ADDRESS_SOURCE := "res://addons/gofer/node_address.gd"

var _main: Node2D

## Deferred because `root` enters the tree only after `_initialize`, and a path needs a tree.
func _initialize() -> void:
    _run.call_deferred()

func _run() -> void:
    var failures: Array[String] = []
    var address := _load_address(failures)
    if address != null:
        _main = _build_scene()
        root.add_child(_main)
        _test_paths(address, failures)
        _test_the_walk(address, failures)
        _test_as_far_as_the_path_goes(address, failures)
        _test_edited_lookup(address, failures)
        _test_edited_refusals(address, failures)
        _test_running_lookup(address, failures)
        _test_running_refusals(address, failures)
        _main.free()
    if failures.is_empty():
        print("Gofer Godot node addressing passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

func _load_address(failures: Array[String]) -> GDScript:
    if not ResourceLoader.exists(ADDRESS_SOURCE):
        failures.append("The addon node address script is not at %s" % ADDRESS_SOURCE)
        return null
    return load(ADDRESS_SOURCE) as GDScript

## Main > Player > Sprite, Main > PauseMenu > Panel + Title, Main > Crowd > Child0..Child19.
func _build_scene() -> Node2D:
    var main := Node2D.new()
    main.name = "Main"
    var player := CharacterBody2D.new()
    player.name = "Player"
    main.add_child(player)
    var sprite := Sprite2D.new()
    sprite.name = "Sprite"
    player.add_child(sprite)
    var menu := Control.new()
    menu.name = "PauseMenu"
    main.add_child(menu)
    for named in ["Panel", "Title"]:
        var part := Control.new()
        part.name = named
        menu.add_child(part)
    var crowd := Node.new()
    crowd.name = "Crowd"
    main.add_child(crowd)
    for index in range(20):
        var member := Node.new()
        member.name = "Child%d" % index
        crowd.add_child(member)
    return main

func _message(refusal: Dictionary) -> String:
    return str((refusal.get("_gofer_error", {}) as Dictionary).get("message", ""))

func _test_paths(address: GDScript, failures: Array[String]) -> void:
    var sprite := _main.get_node("Player/Sprite")
    if address.call("path_in", _main, sprite) != "/Main/Player/Sprite":
        failures.append("the edited scene spells a node from its own root")
    if address.call("path_in", _main, _main) != "/Main":
        failures.append("the edited root is spelled by its name")
    if address.call("path_in", root, sprite) != "/root/Main/Player/Sprite":
        failures.append("the running tree spells a node from /root, as get_path does")

    # The editor holds its scene deep inside its own tree; the edited spelling ignores that.
    var holder := Node.new()
    holder.name = "EditorHolder"
    root.add_child(holder)
    var nested := Node2D.new()
    nested.name = "Level"
    holder.add_child(nested)
    var inside := Node.new()
    inside.name = "Door"
    nested.add_child(inside)
    if address.call("path_in", nested, inside) != "/Level/Door":
        failures.append("an edited root nested in the editor still spells paths from itself")
    holder.free()

func _test_the_walk(address: GDScript, failures: Array[String]) -> void:
    var whole: Dictionary = address.call("tree", _main, _main, 32, 4096, 4096)
    if bool(whole["truncated"]):
        failures.append("a walk with budget to spare is not truncated")
    var top: Dictionary = whole["root"]
    if top["path"] != "/Main" or top["type"] != "Node2D" or top["icon"] != "Node2D":
        failures.append("a walk names its start's path, type and icon: %s" % [top])
    var first: Dictionary = (top["children"] as Array)[0]
    if first["name"] != "Player" or first["path"] != "/Main/Player":
        failures.append("a walk's children are spelled from the root it was given: %s" % [first])

    var running: Dictionary = address.call("tree", _main, root, 32, 4096, 2048)
    if ((running["root"] as Dictionary)["path"]) != "/root/Main":
        failures.append("the running walk spells from /root")

    var shallow: Dictionary = address.call("tree", _main, _main, 0, 4096, 4096)
    if not bool(shallow["truncated"]) or not ((shallow["root"] as Dictionary)["children"] as Array).is_empty():
        failures.append("a walk out of depth drops the children and says it did")

    var leaf: Dictionary = address.call("tree", _main.get_node("Player/Sprite"), _main, 0, 4096, 4096)
    if bool(leaf["truncated"]):
        failures.append("a node with no children loses nothing at depth zero")

    var counted: Dictionary = address.call("tree", _main, _main, 32, 5, 4096)
    if not bool(counted["truncated"]) or _count(counted["root"]) != 5:
        failures.append("a walk stops at its budget and says it did: %d" % _count(counted["root"]))

    var capped: Dictionary = address.call("tree", _main, _main, 32, 4096, 3)
    if _count(capped["root"]) != 3:
        failures.append("the ceiling holds a budget asked above it")
    var at_least_one: Dictionary = address.call("tree", _main, _main, 32, 0, 4096)
    if _count(at_least_one["root"]) != 1:
        failures.append("a budget of zero still answers with the start")
    var too_deep: Dictionary = address.call("tree", _main, _main, 99, 4096, 4096)
    if bool(too_deep["truncated"]):
        failures.append("a depth above the ceiling is held at it, not refused")

func _count(summary: Dictionary) -> int:
    var total := 1
    for child: Dictionary in summary["children"]:
        total += _count(child)
    return total

func _test_as_far_as_the_path_goes(address: GDScript, failures: Array[String]) -> void:
    var reached: String = address.call("as_far_as_the_path_goes", _main, "/Main/PauseMenu/Box")
    for named in ["/Main/PauseMenu", "Panel, Title", "called Box"]:
        if not reached.contains(named):
            failures.append("a path that stopped matching must name %s: %s" % [named, reached])
    var leaf: String = address.call("as_far_as_the_path_goes", _main, "/Main/Player/Sprite/Glow")
    if not leaf.contains("/Main/Player/Sprite is there and has no children at all"):
        failures.append("a node with nothing under it says so rather than listing nothing")
    var trimmed: String = address.call("as_far_as_the_path_goes", _main, "/Main/Crowd/Missing")
    for named in ["Child0", "Child11", "and 8 more"]:
        if not trimmed.contains(named):
            failures.append("a long list must name %s" % [named])
    if trimmed.contains("Child12"):
        failures.append("and it must stop at twelve")
    if not str(address.call("as_far_as_the_path_goes", _main, "/Other/Player")).is_empty():
        failures.append("a path under another root gains no clause")
    if not str(address.call("as_far_as_the_path_goes", _main, "/Main/Player")).is_empty():
        failures.append("a path that resolves gains no clause")
    if not str(address.call("as_far_as_the_path_goes", null, "/Main/Nope")).is_empty():
        failures.append("no scene open gains no clause")
    var running: String = address.call("as_far_as_the_path_goes", root, "/root/Main/Nope")
    if not running.contains("/root/Main is there and holds Player, PauseMenu, Crowd"):
        failures.append("the running tree walks from /root: %s" % [running])

func _test_edited_lookup(address: GDScript, failures: Array[String]) -> void:
    for spelled in ["", "Main", "/Main", "."]:
        if address.call("edited_node", _main, spelled) != _main:
            failures.append("'%s' names the edited root" % [spelled])
    var player := _main.get_node("Player")
    for spelled in ["/Main/Player", "Main/Player", "Player", " /Main/Player "]:
        if address.call("edited_node", _main, spelled) != player:
            failures.append("'%s' names the player" % [spelled])
    if address.call("edited_node", _main, "/Main/Ghost") != null:
        failures.append("a path the scene does not hold names nothing")
    if address.call("edited_node", null, "/Main") != null:
        failures.append("no scene open names nothing")

    for spelled in [".", "", "Main", "/Main"]:
        if address.call("edited_relative", _main, spelled) != "":
            failures.append("'%s' is the root, relative to itself" % [spelled])
    for spelled in ["/Main/Player/Sprite", "Main/Player/Sprite", "Player/Sprite"]:
        if address.call("edited_relative", _main, spelled) != "Player/Sprite":
            failures.append("'%s' has one relative spelling" % [spelled])

func _test_edited_refusals(address: GDScript, failures: Array[String]) -> void:
    var refused: Dictionary = address.call("edited_not_found", _main, " /Main/Ghost ")
    var failure: Dictionary = refused["_gofer_error"]
    if failure["code"] != "node_not_found" or bool(failure["retryable"]):
        failures.append("a missing node is refused as node_not_found, not retryable: %s" % [failure])
    if (failure["details"] as Dictionary).get("path", "") != "/Main/Ghost":
        failures.append("the refusal carries the path it was given, trimmed")
    if not str(failure["message"]).begins_with("Node /Main/Ghost was not found in the edited scene /Main is there"):
        failures.append("the refusal says what was not found: %s" % [failure["message"]])
    if not str(failure["message"]).contains("/Main is there and holds Player, PauseMenu, Crowd"):
        failures.append("the refusal says how far the path went: %s" % [failure["message"]])

    var game_spelling := _message(address.call("edited_not_found", _main, "/root/Main/Player"))
    if not game_spelling.contains("It is there as /Main/Player"):
        failures.append("the running game's spelling is answered with the edited one: %s" % [game_spelling])
    var game_root := _message(address.call("edited_not_found", _main, "/root"))
    if not game_root.contains("this scene's root is /Main."):
        failures.append("/root alone is answered with the edited root: %s" % [game_root])
    var scene_file := _message(address.call("edited_not_found", _main, "res://main.tscn"))
    if not scene_file.contains("That names a scene file"):
        failures.append("a scene file is not a node: %s" % [scene_file])
    var relative := _message(address.call("edited_not_found", _main, "PauseMenu/Box"))
    if not relative.contains("which is /Main. /Main/PauseMenu is there and holds Panel, Title"):
        failures.append("a relative path is answered with the root and how far it went: %s" % [relative])
    var nothing_open := _message(address.call("edited_not_found", null, "/Main/Ghost"))
    if nothing_open != "Node /Main/Ghost was not found in the edited scene":
        failures.append("with no scene open the refusal is the bare sentence: %s" % [nothing_open])

    var one: Dictionary = address.call("edited_all_not_found", _main, ["/Main/Ghost"])
    if ((one["_gofer_error"] as Dictionary)["details"] as Dictionary).get("path", "") != "/Main/Ghost":
        failures.append("a batch missing one node is refused as that node")
    var two: Dictionary = address.call("edited_all_not_found", _main, ["/Main/A", "/Main/B"])
    var both: Dictionary = two["_gofer_error"]
    if both["message"] != "Nodes /Main/A, /Main/B were not found in the edited scene":
        failures.append("a batch names every node it is missing: %s" % [both["message"]])
    if (both["details"] as Dictionary).get("nodes", []) != ["/Main/A", "/Main/B"]:
        failures.append("a batch refusal carries every missing path")

func _test_running_lookup(address: GDScript, failures: Array[String]) -> void:
    var player := _main.get_node("Player")
    for spelled in ["/root/Main/Player", "/Main/Player", "Main/Player", "Player"]:
        if address.call("running_node", root, _main, spelled) != player:
            failures.append("'%s' names the running player" % [spelled])
    if address.call("running_node", root, null, "Player") != null:
        failures.append("a scene-relative path needs a current scene")
    if address.call("running_node", root, _main, "/root/Main/Ghost") != null:
        failures.append("a path the running tree does not hold names nothing")

func _test_running_refusals(address: GDScript, failures: Array[String]) -> void:
    var walked: String = address.call("running_not_found", root, "path", "/root/Main/PauseMenu/Box")
    var expected := (
        "No running node at '/root/Main/PauseMenu/Box' /root/Main/PauseMenu is there and holds"
        + " Panel, Title, and nothing under it is called Box."
    )
    if walked != expected:
        failures.append("a running path says how far it went: %s" % [walked])
    var engine_named: String = address.call("running_not_found", root, "path", "/root/Main/@Area2D@214")
    if not engine_named.contains("the engine's own for a node nobody named"):
        failures.append("an engine-made name says it belongs to one instance: %s" % [engine_named])
    if address.call("running_not_found", root, "path", "Main/Ghost") != "No running node at 'Main/Ghost'":
        failures.append("an edited spelling of nothing is the bare sentence")
    var corrected: String = address.call("running_not_found", root, "root", "/Main/Player")
    if not corrected.ends_with("Send \"root\": \"/root/Main/Player\"."):
        failures.append("an edited spelling of a running node is corrected by its key: %s" % [corrected])
    # A live turn sent `root: "HudCommandBar"` for /root/Main/CanvasLayer/HudCommandBar, in two runs.
    var by_name: String = address.call("running_not_found", root, "root", "Sprite")
    if not by_name.ends_with("Send \"root\": \"/root/Main/Player/Sprite\"."):
        failures.append("a bare name is corrected to the one node that carries it: %s" % [by_name])
    var rooted: String = address.call("running_not_found", root, "path", "/root/Sprite")
    if not rooted.ends_with("Send \"path\": \"/root/Main/Player/Sprite\"."):
        failures.append("a /root spelling of a deeper node is corrected too: %s" % [rooted])
    var twin := Sprite2D.new()
    twin.name = "Sprite"
    _main.get_node("Crowd/Child0").add_child(twin)
    var both: String = address.call("running_not_found", root, "path", "Sprite")
    twin.free()
    if not (both.contains("/root/Main/Player/Sprite") and both.contains("/root/Main/Crowd/Child0/Sprite")):
        failures.append("a bare name two nodes carry names both: %s" % [both])
    if both.contains("Send \"path\""):
        failures.append("a bare name two nodes carry is not corrected to either: %s" % [both])
