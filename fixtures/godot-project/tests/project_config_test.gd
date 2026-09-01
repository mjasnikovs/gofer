extends SceneTree


## Staged into the fixture project by `scripts/godot-test.mjs`, fresh from source for this run.
##
## `project_config.gd` preloads `params.gd` and `protocol.gd`, and GDScript resolves a preload
## against `res://` at parse time, so all three have to sit where the shipped addon sits.
##
## Every one of these used to need a real editor under xvfb, because the functions lived inside
## `plugin.gd`. Two acceptance tests carried the lot between them and cost 23 seconds doing it.
const PROJECT_SOURCE := "res://addons/gofer/project_config.gd"

func _initialize() -> void:
    var failures: Array[String] = []
    var config := _load_config(failures)
    if config != null:
        _test_reading_a_setting(config, failures)
        _test_refusing_a_setting(config, failures)
        _test_the_dot_repair(config, failures)
        _test_searching(config, failures)
        _test_autoloads(config, failures)
        _test_input_actions(config, failures)
    if failures.is_empty():
        print("Gofer Godot project configuration passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

func _load_config(failures: Array[String]) -> GDScript:
    if not ResourceLoader.exists(PROJECT_SOURCE):
        failures.append("The addon project configuration script is not at %s" % PROJECT_SOURCE)
        return null
    return load(PROJECT_SOURCE) as GDScript

## The code an answer refused with, or "" when it did not refuse.
func _refusal(answer: Dictionary) -> String:
    var error: Variant = answer.get("_gofer_error", null)
    if error is Dictionary:
        return str((error as Dictionary).get("code", ""))
    return ""

func _test_reading_a_setting(config: GDScript, failures: Array[String]) -> void:
    var missing: Dictionary = config.get_setting({"name": "no/such/setting"})
    if _refusal(missing) != "setting_not_found":
        failures.append("A setting that does not exist must be refused as setting_not_found")

    if _refusal(config.get_setting({})) != "invalid_params":
        failures.append("project.get_setting with no name must be refused")

    var named: Dictionary = config.get_setting({"name": "application/config/name"})
    if named.has("_gofer_error"):
        failures.append("A setting the project declares must be readable")
    elif not named.has("restartRequired"):
        failures.append("A read setting says whether changing it needs a restart")

    # PROPERTY_USAGE_RESTART_IF_CHANGED is the engine's own flag, and reading it was the one thing
    # the acceptance test booted an editor twice to see.
    var spoken: Dictionary = config.get_setting({"name": "audio/general/text_to_speech"})
    if spoken.get("restartRequired", null) != true:
        failures.append("A setting the engine marks restart-if-changed must say so")

func _test_refusing_a_setting(config: GDScript, failures: Array[String]) -> void:
    var wrong_type: Dictionary = config.set_setting(
        {"name": "application/config/name", "value": {"type": "int", "value": 5}}
    )
    if _refusal(wrong_type) != "type_mismatch":
        failures.append("A value of the wrong type for a declared setting must be refused")

    # `input/`, `autoload/` and `editor_plugins/` each have a typed command, and writing them as
    # raw settings is how a caller half-configures one and never learns why it did not take.
    for reserved in ["input/ui_accept", "autoload/Thing", "editor_plugins/whatever"]:
        var taken: Dictionary = config.set_setting(
            {"name": reserved, "value": {"type": "int", "value": 1}}
        )
        if _refusal(taken) != "reserved_setting":
            failures.append("'%s' has a typed command and must name it" % reserved)

    if _refusal(config.set_setting({"name": "a/b"})) != "invalid_params":
        failures.append("project.set_setting with no value must be refused")

func _test_the_dot_repair(config: GDScript, failures: Array[String]) -> void:
    # A name written with dots creates a brand-new custom setting that governs nothing, while the
    # built-in one stays untouched. The repair is the whole reason this refusal exists.
    var dotted: Dictionary = config.set_setting(
        {"name": "application.config.name", "value": {"type": "string", "value": "x"}}
    )
    if _refusal(dotted) != "setting_not_found":
        failures.append("A setting name written with dots must be refused, not created")
    elif str(dotted["_gofer_error"]["details"].get("didYouMean", "")) != "application/config/name":
        failures.append("A dotted name must name the setting it was probably meant to be")

func _test_searching(config: GDScript, failures: Array[String]) -> void:
    var spoken: Dictionary = config.search_settings({"query": "text to speech"})
    var backwards: Dictionary = config.search_settings({"query": "speech to text"})
    if int(spoken.get("totalMatches", 0)) == 0:
        failures.append("A search for words that are really in a name must find it")
    if int(backwards.get("totalMatches", -1)) != int(spoken.get("totalMatches", 0)):
        failures.append("The order of the words is not part of the question")

    var everything: Dictionary = config.search_settings({"query": ""})
    if int(everything.get("totalMatches", 0)) < config.MAX_SEARCH_RESULTS:
        failures.append("An empty query must match more settings than one page holds")
    elif not bool(everything.get("truncated", false)):
        failures.append("A search with more matches than it answers with must say it truncated")

func _test_autoloads(config: GDScript, failures: Array[String]) -> void:
    var added: Array = []
    var reserved: Dictionary = config.set_autoload(
        {"name": config.GOFER_AUTOLOAD_NAME, "path": "res://tests/project_config_test.gd"}, added
    )
    if _refusal(reserved) != "gofer_managed":
        failures.append("The autoload Gofer installs for itself may not be written by a caller")

    var not_a_name: Dictionary = config.set_autoload({"name": "9lives", "path": "res://x.gd"}, added)
    if _refusal(not_a_name) != "invalid_params":
        failures.append("An autoload name that is not an identifier must be refused")

    var outside: Dictionary = config.set_autoload({"name": "Ok", "path": "/etc/passwd"}, added)
    if _refusal(outside) != "invalid_params":
        failures.append("An autoload path that does not start with res:// must be refused")

    var nowhere: Dictionary = config.set_autoload(
        {"name": "Ok", "path": "res://no/such/file.gd"}, added
    )
    if _refusal(nowhere) != "autoload_path_not_found":
        failures.append("An autoload path with no file behind it must be refused")

    if not added.is_empty():
        failures.append("A refused autoload is not one Gofer has to take back")

func _test_input_actions(config: GDScript, failures: Array[String]) -> void:
    var listed: Dictionary = config.list_input_actions({})
    if not listed.has("actions"):
        failures.append("The input map answers with its actions")

    if _refusal(config.set_input_action({})) != "invalid_params":
        failures.append("project.set_input_action with no name must be refused")

    if _refusal(config.remove_input_action({})) != "invalid_params":
        failures.append("project.remove_input_action with no name must be refused")
