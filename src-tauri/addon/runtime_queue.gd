## The launch-and-deadline arithmetic behind `runtime.*`, without the editor it used to sit in.
##
## A call to the running game waits on two things the editor knows — whether a scene is playing,
## and whether a modal dialog is up — and on nothing else. Everything after those two reads is a
## fold over the queue: which pending calls have run out of time, and what each one's silence
## means. It distinguishes six outcomes, and every one of them lived inside `plugin.gd`, which
## `extends EditorPlugin` — so reaching any of them cost a booted editor *and* a running game, and
## the latch that tells "the game is slow to start" from "the game started and died" was named by
## no test at all.
##
## Preloadable, like `params.gd` and `project_config.gd` beside it. The plugin still reads the two
## editor values and still sends the answers; this decides what the answers are.

const LAUNCH_KINDS: Array[String] = ["run", "run_frame"]
## The operations that cannot answer until the game draws, which is why their timeout says more.
const FRAME_AWAITING_OPS: Array[String] = ["input", "capture", "wait"]
## The operations a paused game cannot serve. A debugger break stops the scene tree, and only
## these two wait on it; the renderer keeps drawing through a break, so a capture answers from a
## breakpoint in about a tenth of a second, and every read - tree, node, monitors - answers too.
const PROCESS_AWAITING_OPS: Array[String] = ["input", "wait"]

## What one sweep of the queue decided.
##
## `answers` is what to send and `kept` is what is still waiting. `play` is the one effect this
## cannot do for itself: a restart whose game has finally stopped has to start the next one.
##
## A launch also ends when the game it started dies. A game that cannot boot — a main scene whose
## script does not parse is the everyday one — runs for a moment and exits, and the helper that
## would have answered never loads. Nothing used to notice: the launch sat on its deadline alone
## and then answered `runtime_timeout`, "The game did not answer in time", about a game that had
## been gone for half a minute. That reads as a slow machine, so the agent waits, and the parse
## error that caused it is never mentioned. `seen_playing` is what tells the two apart.
##
## The opposite case is answered apart from both. A launch whose deadline passes while the editor
## is still playing is a game that started and is late, not one that failed, and a caller told it
## timed out stops the game and starts another — which is the one action that turns a slow start
## into a lost one.
static func sweep(
    pending: Array, now: int, playing: bool, asking: Variant
) -> Dictionary:
    var answers: Array[Dictionary] = []
    var kept: Array[Dictionary] = []
    var play := false
    for call in pending:
        var launching: bool = LAUNCH_KINDS.has(call["kind"])
        if launching and playing:
            call["seen_playing"] = true
        if launching and asking != null and not call.get("seen_playing", false):
            answers.append({"kind": "dialog", "id": call["id"], "dialog": asking})
        elif int(call["deadline"]) < now:
            answers.append(_out_of_time(call, playing, launching))
        elif launching and not playing and call.get("seen_playing", false):
            answers.append(
                _refusal(
                    call,
                    "runtime_not_running",
                    "The game started and then stopped before it was ready; check the editor output for the error that ended it"
                )
            )
        elif call["kind"] == "stop" and not playing:
            answers.append({"kind": "result", "id": call["id"], "result": {"running": false}})
        elif call["kind"] == "restart" and not playing:
            play = true
            call["kind"] = "run"
            call["seen_playing"] = false
            kept.append(call)
        else:
            kept.append(call)
    return {"answers": answers, "kept": kept, "play": play}

## What a call that outlived its deadline is told, which is three different things.
static func _out_of_time(call: Dictionary, playing: bool, launching: bool) -> Dictionary:
    if launching and playing:
        var slow := _refusal(
            call,
            "runtime_slow_start",
            "The game is running and its helper has not answered yet. Read godot_runtime get_state rather than running it again; stopping it now would throw away a game that is still starting"
        )
        slow["details"] = {"running": true}
        return slow
    if FRAME_AWAITING_OPS.has(str(call.get("op", ""))):
        return _refusal(
            call,
            "runtime_timeout",
            "The game did not answer in time. This call cannot answer until the game draws a frame, and a game can be alive and drawing nothing - godot_runtime inspect_node and get_tree need no frame, so ask one of those: the tree itself means the game is alive and not drawing, and a runtime_broke means the debugger is holding it. If the debugger is holding it, godot_debug stack_trace says where it is stopped"
        )
    return _refusal(call, "runtime_timeout", "The game did not answer in time")

static func _refusal(call: Dictionary, code: String, message: String) -> Dictionary:
    return {
        "kind": "error",
        "id": call["id"],
        "code": code,
        "message": message,
        "retryable": true,
        "details": {}
    }
