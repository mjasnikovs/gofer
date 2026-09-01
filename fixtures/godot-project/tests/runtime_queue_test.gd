extends SceneTree


## Staged into the fixture project by `scripts/godot-test.mjs`, fresh from source for this run.
##
## Every case here used to need a booted editor and a running game. `seen_playing` — the latch that
## tells a slow start from a game that started and died — was named by no test at all.
const QUEUE_SOURCE := "res://addons/gofer/runtime_queue.gd"

const NOW := 1000

func _initialize() -> void:
    var failures: Array[String] = []
    var queue := _load_queue(failures)
    if queue != null:
        _test_nothing_to_do(queue, failures)
        _test_the_seen_playing_latch(queue, failures)
        _test_what_a_deadline_means(queue, failures)
        _test_stop_and_restart(queue, failures)
        _test_a_dialog_intercepts_a_launch(queue, failures)
    if failures.is_empty():
        print("Gofer Godot runtime queue passed")
        quit(0)
        return
    for failure in failures:
        push_error(failure)
    quit(1)

func _load_queue(failures: Array[String]) -> GDScript:
    if not ResourceLoader.exists(QUEUE_SOURCE):
        failures.append("The addon runtime queue script is not at %s" % QUEUE_SOURCE)
        return null
    return load(QUEUE_SOURCE) as GDScript

## One pending call. `deadline` is in the future unless a case moves it.
func _call(kind: String, overrides: Dictionary = {}) -> Dictionary:
    var pending := {"id": "c1", "kind": kind, "deadline": NOW + 100}
    for key in overrides:
        pending[key] = overrides[key]
    return pending

## The single answer a sweep produced, or {} when it produced none.
func _only(swept: Dictionary) -> Dictionary:
    var answers: Array = swept["answers"]
    return answers[0] if answers.size() == 1 else {}

func _test_nothing_to_do(queue: GDScript, failures: Array[String]) -> void:
    var waiting := _call("run")
    var swept: Dictionary = queue.sweep([waiting], NOW, true, null)
    if not (swept["answers"] as Array).is_empty():
        failures.append("A launch inside its deadline is answered with nothing")
    if (swept["kept"] as Array).size() != 1:
        failures.append("A launch inside its deadline is still waiting")
    if bool(swept["play"]):
        failures.append("Nothing but a restart starts a game")

func _test_the_seen_playing_latch(queue: GDScript, failures: Array[String]) -> void:
    # Never played: the game is slow to start, and there is nothing to report yet.
    var starting := _call("run")
    var early: Dictionary = queue.sweep([starting], NOW, false, null)
    if not (early["answers"] as Array).is_empty():
        failures.append("A launch that has not been seen playing is still starting, not dead")

    # One sweep while playing sets the latch, and the next sweep with the game gone says why.
    var swept: Dictionary = queue.sweep([starting], NOW, true, null)
    if not bool(starting.get("seen_playing", false)):
        failures.append("A launch swept while the game plays must latch that it played")
    swept = queue.sweep((swept["kept"] as Array), NOW, false, null)
    if str(_only(swept).get("code", "")) != "runtime_not_running":
        failures.append("A game that played and then stopped must say it started and died")
    if not (swept["kept"] as Array).is_empty():
        failures.append("A launch that has been answered is no longer waiting")

func _test_what_a_deadline_means(queue: GDScript, failures: Array[String]) -> void:
    var late := {"deadline": NOW - 1}

    # Still playing: late, not failed. A caller told it timed out stops a game that is coming up.
    var slow: Dictionary = queue.sweep([_call("run", late)], NOW, true, null)
    var slow_answer := _only(slow)
    if str(slow_answer.get("code", "")) != "runtime_slow_start":
        failures.append("A launch past its deadline while the game plays is slow, not timed out")
    elif bool((slow_answer.get("details", {}) as Dictionary).get("running", false)) != true:
        failures.append("A slow start says the game is running, which is what stops a caller killing it")

    var awaiting := late.duplicate()
    awaiting["op"] = "capture"
    var frame: Dictionary = queue.sweep([_call("forward", awaiting)], NOW, false, null)
    var frame_answer := _only(frame)
    if str(frame_answer.get("code", "")) != "runtime_timeout":
        failures.append("A frame-awaiting call past its deadline times out")
    elif not str(frame_answer.get("message", "")).contains("draws a frame"):
        failures.append("A frame-awaiting timeout must say a game can be alive and drawing nothing")

    var reading := late.duplicate()
    reading["op"] = "get_tree"
    var plain: Dictionary = queue.sweep([_call("forward", reading)], NOW, false, null)
    var plain_answer := _only(plain)
    if str(plain_answer.get("code", "")) != "runtime_timeout":
        failures.append("A call past its deadline times out")
    elif str(plain_answer.get("message", "")).contains("draws a frame"):
        failures.append("A call that needs no frame must not be told to wait for one")

func _test_stop_and_restart(queue: GDScript, failures: Array[String]) -> void:
    var stopping := _call("stop")
    var waiting: Dictionary = queue.sweep([stopping], NOW, true, null)
    if not (waiting["answers"] as Array).is_empty():
        failures.append("A stop is not answered while the game is still playing")

    var gone: Dictionary = queue.sweep([stopping], NOW, false, null)
    var answer := _only(gone)
    if str(answer.get("kind", "")) != "result":
        failures.append("A stop whose game has gone answers, rather than refusing")
    elif bool((answer.get("result", {}) as Dictionary).get("running", true)):
        failures.append("A stop that has happened says the game is not running")

    var restarting := _call("restart", {"seen_playing": true})
    var held: Dictionary = queue.sweep([restarting], NOW, true, null)
    if bool(held["play"]):
        failures.append("A restart waits for the old game to stop before starting the next")

    var again: Dictionary = queue.sweep([restarting], NOW, false, null)
    if not bool(again["play"]):
        failures.append("A restart whose game has stopped starts the next one")
    if str(restarting["kind"]) != "run":
        failures.append("A restart that has started again is an ordinary launch")
    if bool(restarting.get("seen_playing", true)):
        failures.append("A restart clears the latch, or the new game inherits the old one's history")
    if (again["kept"] as Array).size() != 1:
        failures.append("A restarted launch is still waiting for its helper")

func _test_a_dialog_intercepts_a_launch(queue: GDScript, failures: Array[String]) -> void:
    var asking := {"title": "Save changes?"}
    var starting := _call("run")
    var stopped: Dictionary = queue.sweep([starting], NOW, false, asking)
    if str(_only(stopped).get("kind", "")) != "dialog":
        failures.append("A launch the editor turned into a question reports the question")

    # A game that is already up is not what the dialog is blocking, so the launch keeps waiting.
    var running := _call("run", {"seen_playing": true})
    var through: Dictionary = queue.sweep([running], NOW, false, asking)
    if str(_only(through).get("kind", "")) == "dialog":
        failures.append("A launch that already reached the game is not blocked by a dialog")
