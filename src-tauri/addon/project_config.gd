## Everything the `project.*` commands decide, which is nothing an editor has to be open for.
##
## Project settings, autoloads and the input map are `ProjectSettings` and `InputMap`, not
## `EditorInterface` — but all of it lived inside `plugin.gd`, which `extends EditorPlugin`, so a
## reserved setting name, a dot written where a slash belongs, and a type mismatch on a declared
## setting each cost a real editor boot under xvfb to exercise. Two acceptance tests carried the
## lot between them and neither could say much.
##
## Preloadable, like `params.gd` and `protocol.gd` beside it. Which side of that line a function
## belongs on is decided by what it touches, and none of this touches the editor.
##
## `project.list_plugins` and `project.set_plugin_enabled` are not here: they ask
## `EditorInterface.is_plugin_enabled`, so they stay with the handlers that need one.

const Protocol := preload("res://addons/gofer/protocol.gd")
const Params := preload("res://addons/gofer/params.gd")

## The name of the autoload Gofer installs for itself, which no caller may write.
const GOFER_AUTOLOAD_NAME := "GoferRuntime"
## How many matches a settings search answers with before it says it truncated.
const MAX_SEARCH_RESULTS := 50

static func settings() -> Dictionary:
    return {
        "projectName": ProjectSettings.get_setting_with_override("application/config/name"),
        "mainScene": ProjectSettings.get_setting_with_override("application/run/main_scene"),
        "renderingMethod": ProjectSettings.get_setting_with_override("rendering/renderer/rendering_method")
    }

## Persists project.godot after a configuration change. Returns an error dictionary on failure and
## an empty one on success, matching the `_gofer_error` convention.
static func save_project_or_error() -> Dictionary:
    var error := ProjectSettings.save()
    if error != OK:
        return Params.error("project_save_failed", "Could not save project.godot (error %d)" % error)
    return {}

## Whether the editor asks for a restart after this setting changes. Custom settings carry no
## property info and are therefore never restart-required.
static func _restart_required(name: String) -> bool:
    for info in ProjectSettings.get_property_list():
        if str(info.get("name", "")) == name:
            return (int(info.get("usage", 0)) & PROPERTY_USAGE_RESTART_IF_CHANGED) != 0
    return false

## The Variant type the engine declared a setting with, or `TYPE_NIL` when nothing declared it.
##
## Only a declared setting has a default to revert to; a setting the project or Gofer invented
## reverts to null, which is how the two are told apart. Writing a value of the wrong type into a
## declared setting is what puts `config/name=5` in project.godot, so the write path refuses it.
static func _declared_setting_type(name: String) -> int:
    if not ProjectSettings.property_can_revert(name):
        return TYPE_NIL
    return typeof(ProjectSettings.property_get_revert(name))

static func search_settings(params: Dictionary) -> Dictionary:
    var wanted := Params.words_of(str(params.get("query", "")))
    var matches: Array = []
    var total := 0
    for info in ProjectSettings.get_property_list():
        var name := str(info.get("name", ""))
        if name.is_empty() or not ProjectSettings.has_setting(name):
            continue
        if not Params.name_holds_every_word(name, wanted):
            continue
        total += 1
        if matches.size() < MAX_SEARCH_RESULTS:
            matches.append(
                {
                    "name": name,
                    "value": Protocol.encode(ProjectSettings.get_setting(name)),
                    "restartRequired": (int(info.get("usage", 0)) & PROPERTY_USAGE_RESTART_IF_CHANGED) != 0
                }
            )
    return {"settings": matches, "totalMatches": total, "truncated": total > matches.size()}

static func get_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.get_setting requires name")
    if not ProjectSettings.has_setting(name):
        return Params.error(
            "setting_not_found",
            (
                "Project setting '%s' does not exist. project.search_settings takes the words you "
                + "would say — every one of them has to be in the name, in any order — and answers "
                + "the names that are really there."
            ) % name,
            {"name": name}
        )
    return {
        "name": name,
        "value": Protocol.encode(ProjectSettings.get_setting(name)),
        "restartRequired": _restart_required(name)
    }

static func set_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or not params.has("value"):
        return Params.error("invalid_params", "project.set_setting requires name and value")
    var typed := Params.reserved_setting_command(name)
    if not typed.is_empty():
        return Params.error(
            "reserved_setting",
            "'%s' has a typed command; use %s instead" % [name, typed],
            {"name": name, "command": typed}
        )
    var decoded := Protocol.decode(params["value"])
    if not decoded["ok"]:
        return Params.error("unsupported_value", decoded["message"], {"name": name})
    var declared := _declared_setting_type(name)
    var fitted := Protocol.fit_to_declared_type(decoded["value"], declared)
    if not fitted["ok"]:
        return Params.error(
            "type_mismatch",
            "Project setting '%s': %s" % [name, fitted["message"]],
            {"name": name, "expected": type_string(declared)}
        )
    var existed := ProjectSettings.has_setting(name)
    if not existed:
        var meant := _setting_meant(name)
        if not meant.is_empty():
            return Params.error(
                "setting_not_found",
                "There is no project setting '%s'. Did you mean '%s'?" % [name, meant],
                {"name": name, "didYouMean": meant}
            )
    ProjectSettings.set_setting(name, fitted["value"])
    var failure := save_project_or_error()
    if not failure.is_empty():
        return failure
    var stored: Variant = ProjectSettings.get_setting(name)
    if not Params.same_value(fitted["value"], stored):
        return Params.readback_error("project.set_setting %s" % name, fitted["value"], stored, {"name": name})
    return {
        "name": name,
        "saved": true,
        "created": not existed,
        "restartRequired": _restart_required(name)
    }

## The setting a name was probably meant to be, or "" when there is nothing close.
##
## Godot names its settings `section/key`, and a caller that writes them with dots gets a brand-new
## custom setting instead of the built-in one — accepted, saved, and read back, while the setting
## that governs anything stays untouched. Custom settings are legitimate, so an unknown name is not
## refused on its own; it is refused only when swapping the separator finds a real one.
static func _setting_meant(name: String) -> String:
    if not name.contains("."):
        return ""
    var candidate := name.replace(".", "/")
    return candidate if ProjectSettings.has_setting(candidate) else ""

## Restores a setting's default when it has one and removes it otherwise. An autoload, input
## action, or plugin entry must go through its own removal command.
static func reset_setting(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.reset_setting requires name")
    if not ProjectSettings.has_setting(name):
        return Params.error(
            "setting_not_found",
            (
                "Project setting '%s' does not exist. project.search_settings takes the words you "
                + "would say — every one of them has to be in the name, in any order — and answers "
                + "the names that are really there."
            ) % name,
            {"name": name}
        )
    var typed := Params.reserved_setting_command(name)
    if not typed.is_empty():
        return Params.error(
            "reserved_setting",
            "'%s' has a typed command; use %s instead" % [name, typed],
            {"name": name, "command": typed}
        )
    var before: Variant = ProjectSettings.get_setting(name)
    var wanted: Variant = null
    if ProjectSettings.property_can_revert(name):
        wanted = ProjectSettings.property_get_revert(name)
    ProjectSettings.set_setting(name, wanted)
    var failure := save_project_or_error()
    if not failure.is_empty():
        return failure
    var stored: Variant = ProjectSettings.get_setting(name)
    if not Params.same_value(wanted, stored):
        return Params.readback_error("project.reset_setting %s" % name, wanted, stored, {"name": name})
    return {
        "name": name,
        "value": Protocol.encode(stored),
        "previous": Protocol.encode(before),
        "changed": not Params.same_value(before, stored),
        "restartRequired": _restart_required(name)
    }

static func list_autoloads() -> Dictionary:
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

static func set_autoload(params: Dictionary, added_here: Array) -> Dictionary:
    var name := str(params.get("name", ""))
    var path := str(params.get("path", ""))
    var enabled := bool(params.get("enabled", true))
    if name.is_empty() or path.is_empty():
        return Params.error("invalid_params", "project.set_autoload requires name and path")
    if not name.is_valid_identifier():
        return Params.error(
            "invalid_params", "Autoload name '%s' is not a valid identifier" % name, {"name": name}
        )
    if name == GOFER_AUTOLOAD_NAME:
        return Params.error(
            "gofer_managed",
            "The GoferRuntime autoload is managed by Gofer and cleaned up when the session stops"
        )
    if not path.begins_with("res://"):
        return Params.error(
            "invalid_params", "Autoload path '%s' must start with res://" % path, {"path": path}
        )
    if not FileAccess.file_exists(path):
        return Params.error(
            "autoload_path_not_found", "No file at '%s'" % path, {"name": name, "path": path}
        )
    var entry := ("*" if enabled else "") + path
    ProjectSettings.set_setting("autoload/" + name, entry)
    if not added_here.has(name):
        added_here.append(name)
    var failure := save_project_or_error()
    if not failure.is_empty():
        return failure
    var stored := str(ProjectSettings.get_setting("autoload/" + name, ""))
    if stored != entry:
        return Params.readback_error("project.set_autoload %s" % name, entry, stored, {"name": name})
    return {"name": name, "path": path, "enabled": enabled}

static func remove_autoload(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.remove_autoload requires name")
    if name == GOFER_AUTOLOAD_NAME:
        return Params.error(
            "gofer_managed",
            "The GoferRuntime autoload is managed by Gofer and cleaned up when the session stops"
        )
    var setting := "autoload/" + name
    if not ProjectSettings.has_setting(setting):
        return Params.error("autoload_not_found", "No autoload named '%s'" % name, {"name": name})
    ProjectSettings.set_setting(setting, null)
    var failure := save_project_or_error()
    if not failure.is_empty():
        return failure
    if ProjectSettings.has_setting(setting):
        return Params.readback_error(
            "project.remove_autoload %s" % name,
            "no autoload",
            ProjectSettings.get_setting(setting),
            {"name": name}
        )
    return {"name": name, "removed": true}

## The Input Map, with the actions this project chose written out and the engine's own named.
##
## Godot registers all 72 of its `ui_*` actions as project settings, events and all, so the whole
## list is 8,909 characters. Four recorded live runs asked for it and **every one of them got 72
## actions of which none was the project's** — about 2,200 tokens each of a constant table, for the
## one fact that the project had declared nothing.
##
## What tells them apart is the settings inspector's own revert arrow, and unlike `Node`'s it works:
## measured on the pinned 4.7.2 against a project declaring `move_left` and overriding `ui_accept`,
## `property_can_revert` with a value differing from `property_get_revert` named exactly those two
## of 73. So an overridden built-in is one the project chose and is written out with the rest.
##
## `names` answers exactly what it lists, chosen or not, which is how the events of an untouched
## built-in are read. A name that is not there is refused rather than left out, the rule
## `node.inspect` and `runtime.inspect_node` both follow.
static func list_input_actions(params: Dictionary) -> Dictionary:
    var wanted: Array[String] = []
    for name in params.get("names", []) as Array:
        wanted.append(str(name))
    var actions: Array = []
    var untouched: Array[String] = []
    for info in ProjectSettings.get_property_list():
        var setting := str(info.get("name", ""))
        if not setting.begins_with("input/"):
            continue
        if setting.contains("."):
            continue
        var data: Variant = ProjectSettings.get_setting(setting)
        if typeof(data) != TYPE_DICTIONARY:
            continue
        var name := setting.trim_prefix("input/")
        if not wanted.is_empty():
            if not wanted.has(name):
                continue
        elif _is_at_its_engine_default(setting):
            untouched.append(name)
            continue
        actions.append(
            {
                "name": name,
                "deadzone": data.get("deadzone", 0.5),
                "events": Params.encode_input_events(data.get("events", [])),
                "builtIn": name.begins_with("ui_")
            }
        )
    if not wanted.is_empty():
        var answered: Array[String] = []
        for action in actions:
            answered.append(str((action as Dictionary)["name"]))
        for name in wanted:
            if not answered.has(name):
                return Params.error(
                    "action_not_found",
                    "There is no input action named '%s'. list_input_actions with no names says "
                    % name
                    + "which there are.",
                    {"name": name}
                )
    return {"actions": actions, "atEngineDefault": untouched}

## Whether a setting still holds what Godot ships it with.
static func _is_at_its_engine_default(setting: String) -> bool:
    if not ProjectSettings.property_can_revert(setting):
        return false
    return ProjectSettings.get_setting(setting) == ProjectSettings.property_get_revert(setting)

static func set_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty() or name.contains("/"):
        return Params.error("invalid_params", "project.set_input_action requires a plain action name")
    var setting := "input/" + name
    var existing: Variant = ProjectSettings.get_setting(setting)
    var current: Dictionary = existing if typeof(existing) == TYPE_DICTIONARY else {}
    var deadzone := float(params.get("deadzone", current.get("deadzone", 0.5)))
    var events: Array[InputEvent] = []
    if params.has("events"):
        var decoded := Params.decode_input_events(params["events"])
        if not decoded["ok"]:
            return Params.error("unsupported_value", decoded["message"], {"name": name})
        events = decoded["events"]
    else:
        events.assign(current.get("events", []))
    ProjectSettings.set_setting(setting, {"deadzone": deadzone, "events": events})
    var failure := save_project_or_error()
    if not failure.is_empty():
        return failure
    var stored: Variant = ProjectSettings.get_setting(setting)
    if typeof(stored) != TYPE_DICTIONARY:
        return Params.readback_error(
            "project.set_input_action %s" % name, "an action", stored, {"name": name}
        )
    var held: Dictionary = stored
    var held_events: Array = held.get("events", [])
    if not Params.same_value(deadzone, float(held.get("deadzone", -1.0))):
        return Params.readback_error(
            "project.set_input_action %s deadzone" % name,
            deadzone,
            held.get("deadzone", null),
            {"name": name}
        )
    if held_events.size() != events.size():
        return Params.readback_error(
            "project.set_input_action %s events" % name,
            "%d events" % events.size(),
            "%d events" % held_events.size(),
            {"name": name}
        )
    return {
        "name": name,
        "deadzone": float(held.get("deadzone", deadzone)),
        "events": Params.encode_input_events(held_events)
    }

## Removes an input action from project.godot. A built-in ui_ action cannot be deleted; its
## binding is changed with `project.set_input_action` and given back with
## `project.reset_input_action`.
static func remove_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.remove_input_action requires name")
    var setting := "input/" + name
    if not ProjectSettings.has_setting(setting):
        return Params.error(
            "input_action_not_found", "No input action named '%s'" % name, {"name": name}
        )
    if name.begins_with("ui_"):
        return Params.error(
            "builtin_input_action",
            "'%s' is a built-in action; change its binding, or reset it with %s"
            % [name, "project.reset_input_action"],
            {"name": name, "command": "project.reset_input_action"}
        )
    ProjectSettings.set_setting(setting, null)
    var failure := save_project_or_error()
    if not failure.is_empty():
        return failure
    if ProjectSettings.has_setting(setting):
        return Params.readback_error(
            "project.remove_input_action %s" % name,
            "no action",
            ProjectSettings.get_setting(setting),
            {"name": name}
        )
    return {"name": name, "removed": true}

## Drops an action's entry from project.godot. A built-in action keeps working on the bindings
## `InputMap` ships, which is what makes this a revert; a custom action simply disappears, so
## `remove` is the honest name for it and this command refuses it.
static func reset_input_action(params: Dictionary) -> Dictionary:
    var name := str(params.get("name", ""))
    if name.is_empty():
        return Params.error("invalid_params", "project.reset_input_action requires name")
    if not name.begins_with("ui_"):
        return Params.error(
            "custom_input_action",
            "'%s' has no built-in binding to return to; remove it with %s"
            % [name, "project.remove_input_action"],
            {"name": name, "command": "project.remove_input_action"}
        )
    var setting := "input/" + name
    if not ProjectSettings.has_setting(setting):
        return Params.error(
            "input_action_not_found", "No input action named '%s'" % name, {"name": name}
        )
    ProjectSettings.set_setting(setting, null)
    var failure := save_project_or_error()
    if not failure.is_empty():
        return failure
    if ProjectSettings.has_setting(setting):
        return Params.readback_error(
            "project.reset_input_action %s" % name,
            "no override",
            ProjectSettings.get_setting(setting),
            {"name": name}
        )
    return {"name": name, "reset": true, "restartRequired": true}
