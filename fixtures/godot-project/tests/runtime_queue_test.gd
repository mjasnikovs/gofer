extends SceneTree


## Staged into the fixture project by `scripts/godot-test.mjs`, fresh from source for this run.
##
## Every call to the running game, driven event by event with the editor's facts as plain values.
## Each case here used to need a booted editor and a running game, most of them a breakpoint too.
const QUEUE_SOURCE := "res://addons/gofer/runtime_queue.gd"

const NOW := 1000
const LAUNCH_MS := 300
const REQUEST_MS := 200
const SESSION := 7
const DIALOG := {"title": "Save changes?", "text": "Save?", "buttons": ["Save", "Cancel"]}

var _queue_script: GDScript

func _initialize() -> void:
    var failures: Array[String] = []
    _queue_script = _load_queue(failures)
    if _queue_script != null:
        _test_launching(failures)
        _test_restarting(failures)
        _test_the_helper_announcing(failures)
        _test_forwarding(failures)
        _test_the_helper_answering(failures)
        _test_what_a_break_ends(failures)
        _test_what_clears_a_break(failures)
        _test_the_game_going(failures)
        _test_stopping(failures)
        _test_cancelling(failures)
        _test_the_seen_playing_latch(failures)
        _test_what_a_deadline_means(failures)
        _test_a_dialog_intercepts_a_launch(failures)
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

func _fresh() -> Variant:
    return _queue_script.new(LAUNCH_MS, REQUEST_MS)

## A queue whose game is up and whose helper has announced, with nothing waiting.
func _up() -> Variant:
    var queue: Variant = _fresh()
    queue.started(SESSION)
    queue.announced(SESSION, 2, NOW)
    return queue

## A queue with a launch in flight whose helper has announced, so the launch waits on its frame.
func _drawing(id: String = "launch") -> Variant:
    var queue: Variant = _fresh()
    queue.launch(id, false, "", PackedStringArray(), NOW, false, true, null)
    queue.started(SESSION)
    queue.announced(SESSION, 2, NOW)
    return queue

func _kinds(effects: Array) -> Array[String]:
    var kinds: Array[String] = []
    for effect: Dictionary in effects:
        kinds.append(str(effect["kind"]))
    return kinds

## The single effect, or {} when there were none or several.
func _only(effects: Array) -> Dictionary:
    return effects[0] if effects.size() == 1 else {}

## The answer given to `id`, or {} when it got none.
func _answer_to(effects: Array, id: String) -> Dictionary:
    for effect: Dictionary in effects:
        if ["result", "error", "dialog"].has(effect["kind"]) and effect["id"] == id:
            return effect
    return {}

func _test_launching(failures: Array[String]) -> void:
    var queue: Variant = _fresh()
    var args := PackedStringArray(["--level", "2"])
    var played: Array = queue.launch("a", false, "res://level.tscn", args, NOW, false, true, null)
    var play := _only(played)
    if play.get("kind", "") != "play" or play["scene"] != "res://level.tscn" or play["args"] != args:
        failures.append("A launch presses play on the scene and command line it was given: %s" % [played])
    if queue.scene != "res://level.tscn" or queue.args != args or not queue.waiting():
        failures.append("A launch remembers what it ran, for a restart, and waits for the helper")

    var missing: Array = _fresh().launch("b", false, "res://nope.tscn", PackedStringArray(), NOW, false, false, null)
    var refused := _only(missing)
    if refused.get("code", "") != "scene_not_found" or refused["retryable"] or refused["details"] != {"scene": "res://nope.tscn"}:
        failures.append("A scene that is not there is refused for good, by name: %s" % [refused])

    var running: Variant = _up()
    var again := _only(running.launch("c", false, "", PackedStringArray(), NOW, true, true, null))
    if again.get("code", "") != "already_running" or not again["retryable"]:
        failures.append("A healthy game is not run twice: %s" % [again])

    var asking: Array = _fresh().launch("d", false, "", PackedStringArray(), NOW, false, true, DIALOG)
    var dialog := _only(asking)
    if dialog.get("kind", "") != "dialog" or dialog["waiting"] or dialog["dialog"] != DIALOG:
        failures.append("A launch the editor would turn into a question answers with it, not waiting: %s" % [asking])

func _test_restarting(failures: Array[String]) -> void:
    # A halted game is replaced rather than refused: every live turn that met one ran again.
    var halted: Variant = _up()
    halted.breaked(SESSION)
    var replaced: Array = halted.launch("a", false, "res://b.tscn", PackedStringArray(), NOW, true, true, null)
    if _kinds(replaced) != ["event", "stop"] or replaced[0]["event"] != "runtime.stopped":
        failures.append("Running over a halted game stops it, and its session, first: %s" % [replaced])
    if halted.ready or halted.broke:
        failures.append("A stopped game's helper and break go with it")
    if not _kinds(halted.tick(NOW, true, null)).is_empty():
        failures.append("A restart waits for the old game to stop")
    var next: Array = halted.tick(NOW, false, null)
    if _kinds(next) != ["play"] or next[0]["scene"] != "res://b.tscn":
        failures.append("A restart whose game has stopped plays the scene it was asked for: %s" % [next])

    # A launch still in flight when the restart comes is told the game it waited on was stopped.
    var booting: Variant = _fresh()
    booting.launch("first", false, "", PackedStringArray(), NOW, false, true, null)
    var restarted: Array = booting.launch("second", true, "", PackedStringArray(), NOW, true, true, null)
    var told := _answer_to(restarted, "first")
    if restarted[0]["kind"] != "stop" or told.get("message", "") != "The game was stopped before it finished launching":
        failures.append("A restart stops the game and answers the launch it replaced: %s" % [restarted])

    # The restart waits on the old game going, so an old game that never goes is a timeout.
    var late: Array = booting.tick(NOW + LAUNCH_MS + 1, true, null)
    if _answer_to(late, "second").get("message", "") != "The game did not answer in time":
        failures.append("A restart whose old game never stopped times out: %s" % [late])

func _test_the_helper_announcing(failures: Array[String]) -> void:
    var queue: Variant = _fresh()
    queue.launch("launch", false, "", PackedStringArray(), NOW, false, true, null)
    var pinged: Array = queue.started(SESSION)
    if _only(pinged).get("payload", {}) != {"id": "", "op": "ping", "params": {}}:
        failures.append("A new session pings its helper in case the announcement raced it: %s" % [pinged])

    var announced: Array = queue.announced(SESSION, 2, NOW)
    if _kinds(announced) != ["event", "send"]:
        failures.append("The first announcement says so, then asks the launch's frame: %s" % [announced])
    elif announced[0]["event"] != "runtime.ready" or announced[0]["data"] != {"protocolVersion": 2}:
        failures.append("The ready event carries the helper's protocol: %s" % [announced[0]])
    elif announced[1]["payload"] != {"id": "launch", "op": "capture", "params": {}}:
        failures.append("The frame is asked under the launch's own id: %s" % [announced[1]])
    if not queue.ready or queue.session_id != SESSION:
        failures.append("An announcement makes the helper ready in its session")
    if not _kinds(queue.announced(SESSION, 2, NOW)).is_empty():
        failures.append("A second announcement is news to nobody")

    var framed: Array = queue.answered({"id": "launch", "ok": true, "frame": {"png": "x"}})
    if _only(framed).get("result", {}) != {"running": true, "frame": {"png": "x"}}:
        failures.append("A launch answers with its first frame: %s" % [framed])

    var blank: Variant = _drawing()
    var frameless := _only(blank.answered({"id": "launch", "ok": false, "code": "capture_unavailable"}))
    if frameless.get("result", {}) != {"running": true}:
        failures.append("A launch whose frame failed still launched: %s" % [frameless])

    for headless: PackedStringArray in [PackedStringArray(["--headless"]), PackedStringArray(["-v", "--headless"])]:
        var dark: Variant = _fresh()
        dark.launch("dark", false, "", headless, NOW, false, true, null)
        dark.started(SESSION)
        var answered: Array = dark.announced(SESSION, 2, NOW)
        if _answer_to(answered, "dark").get("result", {}) != {"running": true} or _kinds(answered).has("send"):
            failures.append("A game with no display is launched when its helper announces: %s" % [answered])
    var passed_on: Variant = _fresh()
    passed_on.launch("game", false, "", PackedStringArray(["--", "--headless"]), NOW, false, true, null)
    passed_on.started(SESSION)
    if not _kinds(passed_on.announced(SESSION, 2, NOW)).has("send"):
        failures.append("A --headless after -- is the game's argument, and the launch still waits on a frame")

    var restarted: Variant = _up()
    if restarted.ready != true:
        failures.append("An announced helper is ready")
    restarted.started(SESSION)
    if not restarted.ready:
        failures.append("The same session starting again keeps its helper")
    restarted.started(SESSION + 1)
    if restarted.ready:
        failures.append("A new session is a new game, whose helper has not announced")

func _test_forwarding(failures: Array[String]) -> void:
    var nothing: Variant = _fresh()
    if _only(nothing.forward("w", "wait", {}, NOW, false)).get("result", {}) != {"exited": true}:
        failures.append("A wait with no game has nothing left to wait for")
    var booting := _only(nothing.forward("w", "wait", {}, NOW, true))
    if booting.get("code", "") != "runtime_not_running" or not str(booting["message"]).contains("still starting"):
        failures.append("A wait on a game still booting is refused, not told it exited: %s" % [booting])
    var no_game := _only(nothing.forward("t", "tree", {}, NOW, false))
    if no_game.get("message", "") != "No game with the Gofer runtime helper is running" or not no_game["retryable"]:
        failures.append("A read with no game says there is none, retryably: %s" % [no_game])
    if nothing.waiting():
        failures.append("A refused call is not waiting")

    var up: Variant = _up()
    var sent: Array = up.forward("t", "tree", {"depth": 2}, NOW, true)
    if _only(sent).get("payload", {}) != {"id": "t", "op": "tree", "params": {"depth": 2}}:
        failures.append("A call to a live helper goes to the game as it came: %s" % [sent])
    if not up.waiting():
        failures.append("A forwarded call waits for its answer")
    var late: Array = up.tick(NOW + REQUEST_MS + 1, true, null)
    if _answer_to(late, "t").get("message", "") != "The game did not answer in time":
        failures.append("A forwarded call has the request deadline, not the launch one: %s" % [late])

    var halted: Variant = _up()
    halted.breaked(SESSION)
    var refused := _only(halted.forward("c", "capture", {}, NOW, true))
    if refused.get("code", "") != "runtime_broke" or not str(refused["message"]).contains("runtime.capture would wait"):
        failures.append("A call that needs a frame is refused while the game is paused: %s" % [refused])
    for op in ["input", "wait"]:
        if _only(halted.forward(op, op, {}, NOW, true)).get("code", "") != "runtime_broke":
            failures.append("%s waits on a frame, and a paused game draws none" % [op])
    for op in ["tree", "inspect", "monitors", "set", "pause", "resume"]:
        if _only(halted.forward(op, op, {}, NOW, true)).get("kind", "") != "send":
            failures.append("%s answers through a break and is sent" % [op])

func _test_the_helper_answering(failures: Array[String]) -> void:
    var queue: Variant = _up()
    queue.forward("t", "tree", {}, NOW, true)
    var read: Array = queue.answered({"id": "t", "ok": true, "truncated": false, "root": {}})
    if _only(read).get("result", {}) != {"truncated": false, "root": {}}:
        failures.append("An answer reaches its caller without the envelope's id and ok: %s" % [read])

    queue.forward("i", "inspect", {}, NOW, true)
    var failed := _only(queue.answered({"id": "i", "ok": false, "code": "node_not_found", "message": "No running node at '/x'"}))
    if failed.get("code", "") != "node_not_found" or failed["message"] != "No running node at '/x'" or failed["retryable"]:
        failures.append("A helper's refusal is relayed by code and message, for good: %s" % [failed])

    queue.forward("q", "inspect", {}, NOW, true)
    var bare := _only(queue.answered({"id": "q", "ok": false}))
    if bare.get("code", "") != "runtime_failed" or bare["message"] != "The runtime helper refused the request":
        failures.append("A refusal the helper did not word is still one: %s" % [bare])

    if not queue.answered({"id": "nobody", "ok": true}).is_empty():
        failures.append("An answer nobody is waiting for is dropped")
    if queue.waiting():
        failures.append("Every answered call is done waiting")

func _test_what_a_break_ends(failures: Array[String]) -> void:
    # Halting before the helper announces: the launch will never announce.
    var starting: Variant = _fresh()
    starting.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    starting.started(SESSION)
    var halted_launch := _only(starting.breaked(SESSION))
    if halted_launch.get("code", "") != "runtime_broke" or not str(halted_launch["message"]).contains("stopped at an error while starting"):
        failures.append("A launch halted before its helper announced is told why: %s" % [halted_launch])

    # Halting after: the frame will never be drawn, and nor will any frame a call waits on.
    var drawing: Variant = _drawing("launch")
    for op in ["capture", "input", "wait", "tree", "monitors"]:
        drawing.forward(op, op, {}, NOW, true)
    var ended: Array = drawing.breaked(SESSION)
    if not str(_answer_to(ended, "launch").get("message", "")).contains("before it drew its first frame"):
        failures.append("A launch waiting on its first frame is told the game halted first: %s" % [ended])
    for op in ["capture", "input", "wait"]:
        var told := _answer_to(ended, op)
        if told.get("code", "") != "runtime_broke" or not str(told["message"]).contains("what the call sent was delivered"):
            failures.append("%s waiting on frames is told the debugger stopped the game: %s" % [op, told])
    for op in ["tree", "monitors"]:
        if not _answer_to(ended, op).is_empty():
            failures.append("%s answers through a break, and is left waiting" % [op])
    if not drawing.broke:
        failures.append("A break is remembered")

    var elsewhere: Variant = _up()
    if not elsewhere.breaked(SESSION + 1).is_empty() or elsewhere.broke:
        failures.append("A break in another session is not this game's")

func _test_what_clears_a_break(failures: Array[String]) -> void:
    var queue: Variant = _up()
    queue.breaked(SESSION)
    queue.forward("t", "tree", {}, NOW, true)
    queue.answered({"id": "t", "ok": true})
    queue.announced(SESSION, 2, NOW)
    if not queue.broke:
        failures.append("A game that answers through a break is still paused")
    queue.continued(SESSION + 1)
    if not queue.broke:
        failures.append("Another session continuing does not resume this one")
    queue.continued(SESSION)
    if queue.broke:
        failures.append("A continue clears the break")
    queue.breaked(SESSION)
    queue.started(SESSION)
    if queue.broke:
        failures.append("A session starting clears the break")

func _test_the_game_going(failures: Array[String]) -> void:
    var queue: Variant = _drawing("launch")
    queue.forward("wait", "wait", {}, NOW, true)
    queue.forward("tree", "tree", {}, NOW, true)
    var gone: Array = queue.stopped(SESSION)
    if _answer_to(gone, "wait").get("result", {}) != {"exited": true}:
        failures.append("A wait whose game went is over, not failed: %s" % [gone])
    for id in ["tree", "launch"]:
        if _answer_to(gone, id).get("message", "") != "The game stopped before it could answer":
            failures.append("%s is told the game went: %s" % [id, gone])
    var last: Dictionary = gone[gone.size() - 1]
    if last.get("event", "") != "runtime.stopped":
        failures.append("Gofer hears the game stopped after its callers do: %s" % [gone])
    if queue.ready or queue.session_id != -1 or queue.waiting():
        failures.append("A game that went takes its helper and session with it")

    # A launch that never reached its helper is left to the sweep, which knows whether it played.
    var booting: Variant = _fresh()
    booting.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    booting.started(SESSION)
    booting.stopped(SESSION)
    if not booting.waiting():
        failures.append("A launch whose session ended before its helper announced waits for the sweep")

    if not _up().stopped(SESSION + 1).is_empty():
        failures.append("Another session ending is not this game going")

func _test_stopping(failures: Array[String]) -> void:
    var queue: Variant = _fresh()
    queue.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    var stopped: Array = queue.stop(true)
    if _kinds(stopped) != ["stop", "error"] or stopped[1]["message"] != "The game was stopped before it finished launching":
        failures.append("A stop presses stop and answers the launch it ended: %s" % [stopped])
    if not queue.answer_stop_when_gone("s", true, NOW).is_empty():
        failures.append("A stop whose game still plays waits for it to go")
    if not queue.tick(NOW, true, null).is_empty():
        failures.append("A stop is not answered while the game is still playing")
    if _only(queue.tick(NOW, false, null)).get("result", {}) != {"running": false}:
        failures.append("A stop whose game has gone says it is not running")

    # The editor's stop ends the session inside the call, so a launch already drawing and a call
    # waiting on the game hear the session end, not the launch be stopped.
    var drawing: Variant = _drawing("launch")
    drawing.forward("tree", "tree", {}, NOW, true)
    var ended: Array = drawing.stop(true)
    if _kinds(ended) != ["error", "error", "event", "stop"]:
        failures.append("A stop answers the session's ending, then presses stop: %s" % [ended])
    for id in ["launch", "tree"]:
        if _answer_to(ended, id).get("message", "") != "The game stopped before it could answer":
            failures.append("%s hears the game stopped: %s" % [id, ended])
    if drawing.session_id != -1 or not drawing.stopped(SESSION).is_empty():
        failures.append("The stopped the editor emits during the stop names a session already gone")

    var idle: Variant = _up()
    if _kinds(idle.stop(false)) != []:
        failures.append("Stopping no game presses nothing")
    if idle.ready:
        failures.append("A stop drops the helper at once, so the next announcement is a first one")
    if _only(idle.answer_stop_when_gone("s", false, NOW)).get("result", {}) != {"running": false}:
        failures.append("A stop with no game answers at once")

func _test_cancelling(failures: Array[String]) -> void:
    var queue: Variant = _up()
    queue.forward("t", "tree", {}, NOW, true)
    var cancelled := _only(queue.cancel("t"))
    if cancelled.get("code", "") != "cancelled" or cancelled["retryable"]:
        failures.append("A cancelled call is told so, for good: %s" % [cancelled])
    if queue.waiting() or not queue.cancel("t").is_empty():
        failures.append("A cancelled call is no longer waiting")

func _test_the_seen_playing_latch(failures: Array[String]) -> void:
    var queue: Variant = _fresh()
    queue.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    if not queue.tick(NOW, false, null).is_empty():
        failures.append("A launch that has not been seen playing is still starting, not dead")
    if not queue.tick(NOW, true, null).is_empty():
        failures.append("A launch inside its deadline is answered with nothing")
    var died := _only(queue.tick(NOW, false, null))
    if died.get("code", "") != "runtime_not_running" or not str(died["message"]).contains("started and then stopped"):
        failures.append("A game that played and then stopped must say it started and died: %s" % [died])
    if queue.waiting():
        failures.append("A launch that has been answered is no longer waiting")

func _test_what_a_deadline_means(failures: Array[String]) -> void:
    var late := NOW + LAUNCH_MS + 1

    # Still playing: late, not failed. A caller told it timed out stops a game that is coming up.
    var slow: Variant = _fresh()
    slow.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    var slow_answer := _only(slow.tick(late, true, null))
    if slow_answer.get("code", "") != "runtime_slow_start" or slow_answer["details"] != {"running": true}:
        failures.append("A launch past its deadline while the game plays is slow, and says it runs: %s" % [slow_answer])

    var never: Variant = _fresh()
    never.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    if _only(never.tick(late, false, null)).get("message", "") != "The game did not answer in time":
        failures.append("A launch that never played times out")

    for op in ["capture", "input", "wait"]:
        var waiting: Variant = _up()
        waiting.forward(op, op, {}, NOW, true)
        var frame := _only(waiting.tick(late, true, null))
        if frame.get("code", "") != "runtime_timeout" or not str(frame["message"]).contains("draws a frame"):
            failures.append("%s past its deadline must say a game can be alive and drawing nothing" % [op])

    var reading: Variant = _up()
    reading.forward("t", "tree", {}, NOW, true)
    var plain := _only(reading.tick(late, true, null))
    if plain.get("code", "") != "runtime_timeout" or str(plain["message"]).contains("draws a frame"):
        failures.append("A call that needs no frame must not be told to wait for one: %s" % [plain])

    var framed: Variant = _drawing()
    if _only(framed.tick(NOW + REQUEST_MS + 1, true, null)).get("code", "") != "runtime_slow_start":
        failures.append("A launch waiting on its first frame past the deadline is slow, not dead")

func _test_a_dialog_intercepts_a_launch(failures: Array[String]) -> void:
    var starting: Variant = _fresh()
    starting.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    var asked := _only(starting.tick(NOW, false, DIALOG))
    if asked.get("kind", "") != "dialog" or not asked["waiting"]:
        failures.append("A launch the editor turned into a question reports it, still waiting: %s" % [asked])

    # A game that is already up is not what the dialog is blocking, so the launch keeps waiting.
    var running: Variant = _fresh()
    running.launch("run", false, "", PackedStringArray(), NOW, false, true, null)
    running.tick(NOW, true, null)
    if _only(running.tick(NOW, true, DIALOG)).get("kind", "") == "dialog":
        failures.append("A launch that already reached the game is not blocked by a dialog")
