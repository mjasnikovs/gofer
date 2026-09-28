## Where a node path lands, and what a path that lands nowhere is told, in either of two trees.
##
## The editor names the edited scene from its own root, `/Main/Player`; the game names its running
## tree from `/root`, `/root/Main/Player`. One node has a name in each, and both halves of the addon
## used to carry their own copy of the lookup, the walk and the refusal. The running tree's root is
## a node called `root`, so both spellings are "/" + the root's name + the rest: the walk, the path
## and the "as far as the path goes" clause are one. The lookups and refusals are not, and each tree
## keeps its own below.

const Params := preload("res://addons/gofer/params.gd")

const MAX_TREE_DEPTH := 32
## How many children a refusal lists before it says how many are left. The widest node in the
## fixtures holds nine.
const NAMES_AT_MOST := 12

## `node`'s path as the tree under `root` spells it.
static func path_in(root: Node, node: Node) -> String:
    var relative := String(node.get_path()).substr(String(root.get_path()).length())
    return "/" + String(root.name) + relative

## One node and as much of its subtree as `levels` and `budget` allow, clamped at `ceiling` nodes.
##
## Bounded because the worker slices an oversized tool result mid-JSON, and `truncated` would be
## inside what it cut.
static func tree(start: Node, root: Node, levels: int, budget: int, ceiling: int) -> Dictionary:
    var walk := {
        "seen": 0,
        "truncated": false,
        "budget": clampi(budget, 1, ceiling),
        "depth": clampi(levels, 0, MAX_TREE_DEPTH),
    }
    var summary := _summary(start, root, 0, walk)
    return {"truncated": walk["truncated"], "root": summary}

static func _summary(node: Node, root: Node, depth: int, walk: Dictionary) -> Dictionary:
    walk["seen"] = int(walk["seen"]) + 1
    var children: Array[Dictionary] = []
    if depth < int(walk["depth"]) and int(walk["seen"]) < int(walk["budget"]):
        for child in node.get_children():
            if int(walk["seen"]) >= int(walk["budget"]):
                walk["truncated"] = true
                break
            children.append(_summary(child, root, depth + 1, walk))
    elif node.get_child_count() > 0:
        walk["truncated"] = true
    return {
        "name": node.name,
        "type": node.get_class(),
        "icon": Params.icon_class(node),
        "path": path_in(root, node),
        "children": children,
    }

## Walks `raw` down from `root` and names the deepest node it reached and what that node holds.
##
## `node_not_found` used to repeat the path back, the one thing the caller knew: callers guessing at
## names under a node they could not see, or at names the engine made up, got nothing to go on.
static func as_far_as_the_path_goes(root: Node, raw: String) -> String:
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
            return _stopped_at(reached, here, parts[index])
        here = next
        reached += "/" + parts[index]
    return ""

static func _stopped_at(reached: String, here: Node, missing: String) -> String:
    var present := PackedStringArray()
    for child in here.get_children():
        present.append(String(child.name))
    if present.is_empty():
        return (
            " %s is there and has no children at all, so nothing under it is called %s."
            % [reached, missing]
        )
    var listed := ", ".join(present.slice(0, NAMES_AT_MOST))
    if present.size() > NAMES_AT_MOST:
        listed += " and %d more" % (present.size() - NAMES_AT_MOST)
    return (
        " %s is there and holds %s, and nothing under it is called %s."
        % [reached, listed, missing]
    )

## The edited node `raw` names: `/Main/Player`, `Main/Player`, `Player`, and the root by its name.
static func edited_node(root: Node, raw: String) -> Node:
    if root == null:
        return null
    var path := raw.strip_edges()
    if path == root.name or path == "/" + root.name or path == "":
        return root
    if path.begins_with("/"):
        path = path.substr(1)
    if path.begins_with(root.name + "/"):
        path = path.substr(root.name.length() + 1)
    return root.get_node_or_null(NodePath(path))

## `raw` relative to the edited root, and empty for the root itself.
static func edited_relative(root: Node, raw: String) -> String:
    var path := raw.strip_edges()
    if root == null or path == "." or path == "" or path == root.name or path == "/" + root.name:
        return ""
    if path.begins_with("/"):
        path = path.substr(1)
    if path.begins_with(root.name + "/"):
        path = path.substr(root.name.length() + 1)
    return path

## One refusal for every path of a batch the edited scene does not hold, so all are learned at once.
static func edited_all_not_found(root: Node, paths: Array) -> Dictionary:
    if paths.size() == 1:
        return edited_not_found(root, str(paths[0]))
    return Params.error(
        "node_not_found",
        "Nodes %s were not found in the edited scene" % ", ".join(paths),
        {"nodes": paths}
    )

## A path the edited scene does not hold, answered with the spelling that repairs it.
##
## `/root/...` is the running game's spelling, `/root` its root, and `res://…` the scene file rather
## than a node in it; each is answered with the name the edited root actually has.
static func edited_not_found(root: Node, raw: String) -> Dictionary:
    var path := raw.strip_edges()
    var message := "Node %s was not found in the edited scene" % path
    var root_path: String = "/" + String(root.name) if root != null else ""
    if path.begins_with("/root/") and edited_node(root, path.substr(5)) != null:
        message = (
            "%s. It is there as %s: a path that starts at /root is how the runtime.* operations"
            + " name the running game, which is a different tree in a different process."
        ) % [message, path.substr(5)]
    elif (path == "/root" or path == "/root/") and not root_path.is_empty():
        message = (
            "%s. /root is how the runtime.* operations name the running game's root, which is a"
            + " different tree in a different process; this scene's root is %s."
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
        # A live turn sent the same relative path three times before an absolute one earned it.
        message = (
            "%s. Every node path here starts at the scene's own root, which is %s.%s"
        ) % [message, root_path, as_far_as_the_path_goes(root, root_path + "/" + path)]
    else:
        message += as_far_as_the_path_goes(root, path)
    return Params.error("node_not_found", message, {"path": path})

## The running node `path` names, in the tree's own spelling or in the edited scene's.
static func running_node(tree_root: Node, current_scene: Node, path: String) -> Node:
    var found := tree_root.get_node_or_null(NodePath(path))
    if found != null:
        return found
    found = tree_root.get_node_or_null(NodePath("/root" + path if path.begins_with("/") else "/root/" + path))
    if found != null:
        return found
    return null if current_scene == null else current_scene.get_node_or_null(NodePath(path))

## What a running path that names nothing is told, and the corrected call when there is one.
##
## `parameter` is named because the callers spell it differently, and a corrected call that names
## the wrong key is not one. Only the message reaches the model: the editor relays code and message.
static func running_not_found(tree_root: Node, parameter: String, path: String) -> String:
    var plain := "No running node at '%s'" % path
    if _is_an_engine_name(path.get_file()):
        plain += (
            ". A name like that is the engine's own for a node nobody named: it belongs to one "
            + "instance, is numbered differently every run, and goes when that node is freed — "
            + "which is what a bullet or an enemy does between one call and the next. Watch "
            + "something that outlives it, or name the node where it is created"
        )
    if path.begins_with("/root/"):
        return plain + as_far_as_the_path_goes(tree_root, path)
    var spelled := "/root/" + path.trim_prefix("/")
    if tree_root.get_node_or_null(NodePath(spelled)) == null:
        return plain
    var corrected := (
        "%s. The running tree names it '%s': every path here starts at /root, while the node.*"
        + " operations name the edited scene, which is a different tree in a different process."
        + " Send \"%s\": \"%s\"."
    )
    return corrected % [plain, spelled, parameter, spelled]

## `@ClassName@ID`: the engine's name for an unnamed child, numbered per run and gone when it is.
static func _is_an_engine_name(segment: String) -> bool:
    if not segment.begins_with("@"):
        return false
    var parts := segment.split("@", false)
    return parts.size() == 2 and parts[1].is_valid_int()
