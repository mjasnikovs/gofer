extends SceneTree

## The two halves of the addon an editor is needed to *run* still parse.
##
## `plugin.gd` extends `EditorPlugin` and `runtime.gd` runs inside the game, so neither can be
## exercised here — but both can be compiled, and a GDScript that does not compile is the one
## failure mode a refactor of them produces. Reaching that today costs a staged addon, an xvfb
## editor and a launched game; `load` costs a second, and answers the only question a moved
## function raises.
##
## It is not a substitute for `godot-acceptance.mjs`. It is what stops a rename reaching it.
func _init() -> void:
    var broken := PackedStringArray()
    for name in ["plugin", "runtime", "params", "protocol"]:
        if load("res://addons/gofer/%s.gd" % name) == null:
            broken.append(name)
    if not broken.is_empty():
        push_error("Gofer addon does not compile: %s" % ", ".join(broken))
        quit(1)
        return
    var missing := _callbacks_that_name_nothing()
    if not missing.is_empty():
        push_error("Gofer addon names undo callbacks it does not declare: %s" % ", ".join(missing))
        quit(1)
        return
    print("Gofer Godot addon compiles")
    quit(0)


## Every method the editor's undo manager is asked to call back is one the script declares.
##
## `EditorUndoRedoManager.add_do_method(self, "_do_attach", …)` names a method by string, on this
## object. Nothing checks it: not the compiler, not a call-graph search, not the type system. Six of
## these were moved into `params.gd` with the node arithmetic they belong beside, everything still
## compiled, and every undo-backed write silently stopped writing — `node.create` answered "Godot
## holds nothing" and the acceptance suite was the only thing that noticed, forty seconds later.
##
## Read off the source rather than off the object, because the object is an `EditorPlugin` and
## cannot be made without an editor. The string and the `func` line are both plain text.
func _callbacks_that_name_nothing() -> PackedStringArray:
    var missing := PackedStringArray()
    for name in ["plugin", "runtime"]:
        var path := "res://addons/gofer/%s.gd" % name
        var file := FileAccess.open(path, FileAccess.READ)
        if file == null:
            missing.append("%s (unreadable)" % name)
            continue
        var source := file.get_as_text()
        var named := RegEx.create_from_string(
            "(?:add_do_method|add_undo_method|Callable)\\(\\s*self\\s*,\\s*\"([a-z0-9_]+)\""
        )
        for found in named.search_all(source):
            var method := found.get_string(1)
            if not source.contains("func %s(" % method):
                missing.append("%s.%s" % [name, method])
    return missing
