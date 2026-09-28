extends RefCounted

## Every call to the running game, from admission to answer, and what is known about that game.
##
## Each event takes the editor's facts as values and returns effects for the plugin to perform in
## order, so the plugin decides nothing and none of this needs an editor or a game to test. Effects
## are keyed by `kind`: `result`, `error` and `dialog` answer a call, `send` goes to the game, `event`
## to Gofer, and `play` and `stop` press the editor's buttons.

const LAUNCH_KINDS: Array[String] = ["run", "run_frame"]
## The operations that cannot answer until the game draws, which is why their timeout says more.
const FRAME_AWAITING_OPS: Array[String] = ["input", "capture", "wait"]
## The operations whose answer, when the game is gone, is that the waiting is over rather than a
## failure. A benchmark ends: that is the outcome it was run for, and a caller told `not running`
## loses the rest of the list it sent — the `get_state` and the log read that carried the numbers.
const EXIT_ANSWERING_OPS: Array[String] = ["wait"]
## The operations a paused game cannot serve. A debugger break stops the scene tree, and every read
## - tree, node, monitors - still answers through it.
##
## Capture is here because only Linux draws through a break. The same breakpoint on Windows never
## produces another frame, and macOS produces one only sometimes, so the capture that answered in a
## tenth of a second here spent its whole timeout there and then said the game was slow.
const PROCESS_AWAITING_OPS: Array[String] = ["capture", "input", "wait"]
## The engine flag that starts a game with no display, and only where the engine reads it: anything
## after a `--` belongs to the game.
const HEADLESS_FLAG := "--headless"

## The debugger session of the game the helper lives in, or -1 when there is none.
var session_id: int = -1
## Whether the helper in the current game has announced itself.
var ready: bool = false
## Whether the debugger has paused the game and the game has said nothing since.
##
## Not the debugger's own `is_breaked()`: a break Gofer's debug adapter continues or terminates
## leaves that set over a game that runs and answers, and every runtime call would be refused.
var broke: bool = false
## The scene and command line the running game was started with, so a restart replays them rather
## than the project's own main scene.
var scene: String = ""
var args: PackedStringArray = PackedStringArray()

var _pending: Array[Dictionary] = []
var _launch_ms: int
var _request_ms: int

func _init(launch_ms: int, request_ms: int) -> void:
    _launch_ms = launch_ms
    _request_ms = request_ms

## Whether any call is waiting, so the plugin reads the editor's dialog only when one is.
func waiting() -> bool:
    return not _pending.is_empty()

## Starts (or restarts) the game. The launch is answered once the helper announces, with the first
## frame attached, because only a game that has drawn is proven started.
func launch(
    id: String,
    restart: bool,
    wanted_scene: String,
    wanted_args: PackedStringArray,
    now: int,
    playing: bool,
    scene_exists: bool,
    asking: Variant
) -> Array[Dictionary]:
    # A game halted at an error is worth nothing to keep: four of four live turns that met
    # runtime_broke ran again without stopping first and were refused for it.
    if playing and not restart and ready and not broke:
        return [_error(id, "already_running", "The project is already running. Stop it with runtime.stop and run again, or use runtime.restart to run the same scene from the start")]
    if not wanted_scene.is_empty() and not scene_exists:
        return [
            _error(
                id,
                "scene_not_found",
                "No scene at '%s'. scene.list names every scene this project has" % wanted_scene,
                false,
                {"scene": wanted_scene}
            )
        ]
    if playing:
        scene = wanted_scene
        args = wanted_args
        var stopping := stop(true)
        _pending.append({"id": id, "kind": "restart", "deadline": now + _launch_ms})
        return stopping
    if asking != null:
        return [{"kind": "dialog", "id": id, "dialog": asking, "waiting": false}]
    scene = wanted_scene
    args = wanted_args
    # `seen_playing` is what tells a game still booting from one that booted and died.
    _pending.append({"id": id, "kind": "run", "deadline": now + _launch_ms, "seen_playing": false})
    return [_play()]

## Stops the game. Readiness drops now rather than when the session tears down, so the next game's
## announcement reads as a first one; launches waiting on this game are answered, not left to expire.
func stop(playing: bool) -> Array[Dictionary]:
    var effects: Array[Dictionary] = []
    if playing:
        # The editor's stop ends the debugger session inside the call, before anything below runs,
        # so its ending is answered first; the `stopped` it emits then names a session already gone.
        if session_id >= 0:
            effects.append_array(stopped(session_id))
        effects.append({"kind": "stop"})
    ready = false
    broke = false
    effects.append_array(
        _fail(["run", "restart", "run_frame"], "runtime_not_running", "The game was stopped before it finished launching")
    )
    return effects

## Answers `runtime.stop` once the game is gone, which may already be so.
func answer_stop_when_gone(id: String, playing: bool, now: int) -> Array[Dictionary]:
    if not playing:
        return [_result(id, {"running": false})]
    _pending.append({"id": id, "kind": "stop", "deadline": now + _launch_ms})
    return []

## Admits a call for the game. Without a live helper it is refused at once, retryably: the caller
## can start the game and ask again.
func forward(id: String, op: String, params: Dictionary, now: int, playing: bool) -> Array[Dictionary]:
    if not ready or session_id < 0:
        # A wait sent before the helper announced answered `exited: true` about a game that was
        # still booting; only a game the editor is no longer playing has exited.
        if EXIT_ANSWERING_OPS.has(op) and not playing:
            return [_result(id, {"exited": true})]
        return [_error(id, "runtime_not_running", _why_no_helper_answers(playing))]
    if broke and _a_break_ends({"kind": "game", "op": op}):
        return [_error(id, "runtime_broke", "The game is paused in the debugger, so runtime.%s would wait for a frame that never comes. runtime.get_tree, runtime.inspect_node and runtime.get_monitors all answer while it is paused. debug.continue lets it go, and debug.stack_trace says where it is stopped. If it stopped while starting, what stopped it is in the session output - read that, fix it, and run again; runtime.run restarts a halted game by itself" % op)]
    _pending.append({"id": id, "kind": "game", "op": op, "deadline": now + _request_ms})
    return [_send({"id": id, "op": op, "params": params})]

## A new debugger session is a new game: the previous helper's readiness was its own, and the new
## one is pinged in case its announcement raced the session setup.
func started(session: int) -> Array[Dictionary]:
    if session_id != session:
        ready = false
    session_id = session
    broke = false
    return [_send({"id": "", "op": "ping", "params": {}})]

## The debugger paused the game: alive, still playing, and answering nothing.
##
## A break cannot tell an error from a breakpoint, so a launch halted at one the caller armed is
## turned back into a success by the router, which reads the adapter's stop reason.
func breaked(session: int) -> Array[Dictionary]:
    if session != session_id:
        return []
    broke = true
    var effects: Array[Dictionary] = []
    var kept: Array[Dictionary] = []
    for call in _pending:
        if _a_break_ends(call):
            effects.append(_error(call["id"], "runtime_broke", _what_a_break_tells(call)))
        else:
            kept.append(call)
    _pending = kept
    return effects

## The debugger resumed the game. A watched game sends nothing on its own, so this clears the break
## without waiting for it to speak.
func continued(session: int) -> Array[Dictionary]:
    if session == session_id:
        broke = false
    return []

## The game's debugger session ended. A wait is answered as over; every other call to the game, and
## a launch that already reached it, is told the game went. Other launches are left to the sweep.
func stopped(session: int) -> Array[Dictionary]:
    if session != session_id:
        return []
    session_id = -1
    ready = false
    broke = false
    var effects: Array[Dictionary] = []
    var kept: Array[Dictionary] = []
    for call in _pending:
        if call["kind"] == "game" and EXIT_ANSWERING_OPS.has(str(call.get("op", ""))):
            # The frame count is left out rather than reported as zero: the frames that passed
            # went unobserved.
            effects.append(_result(call["id"], {"exited": true}))
        else:
            kept.append(call)
    _pending = kept
    effects.append_array(
        _fail(["game", "run_frame"], "runtime_not_running", "The game stopped before it could answer")
    )
    effects.append({"kind": "event", "event": "runtime.stopped", "data": {}})
    return effects

## The helper announced itself. The first launch waiting on it is answered, with a frame asked for.
func announced(session: int, protocol_version: Variant, now: int) -> Array[Dictionary]:
    var first := not ready
    session_id = session
    ready = true
    var effects: Array[Dictionary] = []
    if first:
        effects.append({"kind": "event", "event": "runtime.ready", "data": {"protocolVersion": protocol_version}})
    for index in range(_pending.size()):
        var call := _pending[index]
        if call["kind"] != "run":
            continue
        _pending.remove_at(index)
        # A game with no display draws nothing, so the frame that proves every other launch would
        # only time out here, about a game that started fine.
        if _asks_for_no_display(args):
            effects.append(_result(call["id"], {"running": true}))
            return effects
        _pending.append({"id": call["id"], "kind": "run_frame", "deadline": now + _request_ms, "seen_playing": true})
        effects.append(_send({"id": call["id"], "op": "capture", "params": {}}))
        return effects
    return effects

## The helper answered a call. A launch's frame is best-effort: a game that cannot draw one still
## counts as launched.
func answered(payload: Dictionary) -> Array[Dictionary]:
    var id := str(payload.get("id", ""))
    for index in range(_pending.size()):
        var call := _pending[index]
        if str(call["id"]) != id:
            continue
        _pending.remove_at(index)
        if call["kind"] == "run_frame":
            var launch_result := {"running": true}
            if payload.get("ok", false) and payload.has("frame"):
                launch_result["frame"] = payload["frame"]
            return [_result(id, launch_result)]
        if payload.get("ok", false):
            var result := payload.duplicate()
            result.erase("id")
            result.erase("ok")
            return [_result(id, result)]
        return [
            _error(
                id,
                str(payload.get("code", "runtime_failed")),
                str(payload.get("message", "The runtime helper refused the request")),
                false
            )
        ]
    return []

## Takes a call back at its caller's request. Empty when no call had that id.
func cancel(request_id: String) -> Array[Dictionary]:
    var effects: Array[Dictionary] = []
    var kept: Array[Dictionary] = []
    for call in _pending:
        if String(call["id"]) == request_id:
            effects.append(_error(request_id, "cancelled", "The request was cancelled by its caller", false))
        else:
            kept.append(call)
    _pending = kept
    return effects

## One editor frame: answers the calls that ran out of time, and starts the game a restart awaits.
##
## `seen_playing` tells a game that booted and died, which is over, from one still booting. A launch
## past its deadline while the editor still plays is late, not failed: a caller told it timed out
## would stop a game that is still coming up.
func tick(now: int, playing: bool, asking: Variant) -> Array[Dictionary]:
    var effects: Array[Dictionary] = []
    var kept: Array[Dictionary] = []
    var play := false
    for call in _pending:
        var launching: bool = LAUNCH_KINDS.has(call["kind"])
        if launching and playing:
            call["seen_playing"] = true
        if launching and asking != null and not call.get("seen_playing", false):
            effects.append({"kind": "dialog", "id": call["id"], "dialog": asking, "waiting": true})
        elif int(call["deadline"]) < now:
            effects.append(_out_of_time(call, playing, launching))
        elif launching and not playing and call.get("seen_playing", false):
            effects.append(
                _error(
                    call["id"],
                    "runtime_not_running",
                    "The game started and then stopped before it was ready; check the editor output for the error that ended it"
                )
            )
        elif call["kind"] == "stop" and not playing:
            effects.append(_result(call["id"], {"running": false}))
        elif call["kind"] == "restart" and not playing:
            play = true
            call["kind"] = "run"
            call["seen_playing"] = false
            kept.append(call)
        else:
            kept.append(call)
    _pending = kept
    if play:
        effects.append(_play())
    return effects

## The one rule for which calls a debugger break ends: every launch, and every call that waits on a
## frame the paused game will not draw.
static func _a_break_ends(call: Dictionary) -> bool:
    match str(call["kind"]):
        "run", "run_frame":
            return true
        "game":
            return PROCESS_AWAITING_OPS.has(str(call.get("op", "")))
    return false

static func _what_a_break_tells(call: Dictionary) -> String:
    match str(call["kind"]):
        "run":
            return "The game stopped at an error while starting and is paused in the debugger; read the error in the session output, fix what it names, and run again - runtime.run restarts a halted game by itself, no stop is needed first"
        "run_frame":
            return "The game halted in the debugger before it drew its first frame, at an error or at a breakpoint; debug.stack_trace says where. If it is an error, it is in the session output - fix what it names and run again; runtime.run restarts a halted game by itself"
    # A live turn pressed the key that reached its own breakpoint and waited out twenty seconds to
    # be told the game had stopped. The press was delivered; only the answer was owed.
    return (
        "The debugger stopped the game while this call was waiting for frames: what "
        + "the call sent was delivered, and the game halted before it could answer. "
        + "debug.stack_trace says where it stopped; debug.continue lets it run on."
    )

## A game the editor plays whose helper never answered is halted or still starting: a live turn read
## `running: true` and "no game" ten seconds apart and took them for two games.
static func _why_no_helper_answers(playing: bool) -> String:
    if not playing:
        return "No game with the Gofer runtime helper is running"
    return (
        "A game is playing but its Gofer helper has not answered, so nothing inside it can be "
        + "read: it is halted at an error or still starting. runtime.get_state says which; "
        + "runtime.stop ends it."
    )

static func _asks_for_no_display(launched_with: PackedStringArray) -> bool:
    for arg in launched_with:
        if arg == "--":
            return false
        if arg == HEADLESS_FLAG:
            return true
    return false

## Answers and drops every pending call of the named kinds; the rest stay waiting.
func _fail(kinds: Array, code: String, message: String) -> Array[Dictionary]:
    var effects: Array[Dictionary] = []
    var kept: Array[Dictionary] = []
    for call in _pending:
        if kinds.has(call["kind"]):
            effects.append(_error(call["id"], code, message))
        else:
            kept.append(call)
    _pending = kept
    return effects

## What a call that outlived its deadline is told, which is three different things.
static func _out_of_time(call: Dictionary, playing: bool, launching: bool) -> Dictionary:
    if launching and playing:
        return _error(
            call["id"],
            "runtime_slow_start",
            "The game is running and its helper has not answered yet. Read runtime.get_state rather than running it again; stopping it now would throw away a game that is still starting",
            true,
            {"running": true}
        )
    if FRAME_AWAITING_OPS.has(str(call.get("op", ""))):
        return _error(
            call["id"],
            "runtime_timeout",
            "The game did not answer in time. This call cannot answer until the game draws a frame, and a game can be alive and drawing nothing - runtime.inspect_node and runtime.get_tree need no frame, so ask one of those: the tree itself means the game is alive and not drawing, and a runtime_broke means the debugger is holding it. If the debugger is holding it, debug.stack_trace says where it is stopped"
        )
    return _error(call["id"], "runtime_timeout", "The game did not answer in time")

func _play() -> Dictionary:
    return {"kind": "play", "scene": scene, "args": args}

static func _send(payload: Dictionary) -> Dictionary:
    return {"kind": "send", "payload": payload}

static func _result(id: Variant, result: Dictionary) -> Dictionary:
    return {"kind": "result", "id": id, "result": result}

static func _error(
    id: Variant, code: String, message: String, retryable: bool = true, details: Dictionary = {}
) -> Dictionary:
    return {
        "kind": "error",
        "id": id,
        "code": code,
        "message": message,
        "retryable": retryable,
        "details": details.duplicate()
    }
