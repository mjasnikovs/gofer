# Next task

Written 2026-08-07 at commit `83482e0`, clean working tree, `npm run check` green (279 Rust tests,
146 frontend, 17/17 Godot acceptance). Ten live sweeps were run to produce this list
(`wdio.live.conf.ts`; see the memory note `gofer-live-sweep-harness`).

Each item below says what is wrong, how it is known, where it lives, and what "done" means. Where
something is a hypothesis rather than a measurement, it says so in those words.

---

## 1 — A dead editor still reports a live session — REPRODUCED, NOT FIXED

**What happens.** When the Godot editor exits on its own — a crash, or a person closing the window —
Gofer keeps reporting the session as whatever it last was. `get_godot_session`
(`src-tauri/src/godot_session_api.rs:426`) maps `godot_session::current_info()` through
`to_response` (`:595`), and neither asks whether the child process is alive or whether the RPC
connection is still open. The stored run row also stays `running`, because `stop_run_logging`
(`:368`) is only reached from `stop_session`.

**How it is known.** Measured on 2026-08-07: the user closed the editor during live run 8. The app
and the runner stayed up, the app went on presenting the session, and
`sqlite3 …/project.sqlite "select status from godot_runs"` still read `running` with the editor
process gone. The editor's own shutdown output (`RID allocations … leaked at exit`) had been
captured into the log, so the app had already seen evidence of the exit and did nothing with it.

**What is not wrong.** The transport does notice. `godot_rpc`'s reader closes the connection and
`RpcSession::readiness()` (`src-tauri/src/godot_rpc.rs:236`) answers `Unavailable`, so calls fail
with a real error. Only the state the user reads is stale.

**Done means.** `get_session` reports a session whose transport has closed as stopped or errored
rather than ready, the run row is closed with a status that says the editor exited on its own, and
the panels say the editor stopped instead of showing a ready badge over failing calls. Cover it in
`godot_session_api`'s tests for the state mapping, and — because no unit test can kill a real child
— add one live step that stops the editor process out from under the app and asserts the window says
so.

---

## 2 — The merge fix is reasoning, not evidence — UNVERIFIED

**What was changed.** Live run 10 ended with two failures: `Merge task` stayed on screen and the
project gained no commit ("nothing merged", "clean"). Two changes went in on that basis:
`mergeDisplayedTask` (`src/app/router.tsx:135`) now throws instead of returning silently when the
displayed task carries no worktree, and the `a session that belongs to another task` scenario moved
from the middle of the level story to after the merge, because it creates a second task and the
merge that followed it found nothing to do.

**What is not known.** Neither change has been through a live sweep. The diagnosis — that the
scenario changed which task was current and the merge then targeted the wrong one — is inference
from the ordering and from `displayedTask` being route-derived. It was never observed directly.

**Done means.** One full live sweep passes end to end. If the merge fails again, the new throw now
puts a sentence on screen naming what it could not do; read that sentence before changing anything
else. Do not treat this item as closed on a green run alone unless the run actually reached the
merge — check for `✓ merges the worktree the agent worked in into the project` in the output.

---

## 3 — `session.cancel` retracting a long-parked request is untested — KNOWN GAP

**What is covered.** The wire half is covered end to end against a fake addon
(`godot_rpc::a_stopped_turn_tells_the_addon_to_give_up`): a stopped turn sends `session.cancel`
naming the abandoned request, and the reply to it does not close the session. The editor half is
covered as far as `the_addon_answers_a_cancellation` (`src-tauri/src/godot_addon_acceptance.rs:768`)
can show it — the command exists, refuses a cancellation naming no request, and answers
`cancelled: false` for one that was never parked.

**What is not covered.** The case the command exists for: retracting a request the addon is actually
holding, and giving readiness back. Godot 4.7 could not be made to hold a scene switch long enough —
it opens a scene with a missing parent by dropping the orphan, and one whose root names an unknown
class by substituting a placeholder. Both were tried and both opened.

**Done means.** Either a deterministic park is found — the most promising untried route is a
`runtime.run` in an editor whose game cannot come up, which parks for `RUNTIME_LAUNCH_TIMEOUT_MS` —
or this is written down as deliberately uncovered where the test would otherwise look thin. Do not
leave it looking covered.

---

## 4 — `require_session_task` has no unit test — KNOWN GAP

**Where.** `src-tauri/src/godot_session_api.rs:138`, called from `call_godot` (`:435`) and from
every `godot_*` tool through `ai_tools::rpc`.

**Why there is no test.** Planting a fake active session needs a seam that does not exist:
`godot_session::ACTIVE_SESSION` is a process-global written only by a real `start`, and
`SessionInfo` carries no task id (the owning task is held separately in `SESSION_TASK`).

**What covers it today.** The live sweep step `does not answer with another task's scene`, which
passed in run 10 with the refusal in the log verbatim: _The Godot editor session belongs to another
task._ Before the guard, the same step answered `Level1` — a scene from a checkout the task had
nothing to do with.

**Done means.** Either a `#[cfg(test)]` seam that binds a session info the way
`godot_session::bind_test_rpc` binds a transport, with tests for the three branches (no session,
same task, other task), or an explicit note that the live sweep is the only cover. Either is
acceptable; leaving it implicit is not.

---

## 5 — A non-script file cannot be deleted with a hash — REAL GAP, DOCUMENTED ONLY

**What happens.** `godot_resource delete` takes an optional `expectedHash` that refuses the delete
if the file changed since it was read. The only thing that produces a hash is `godot_script`
open/save, which works on `.gd` files. So for every other file the parameter cannot be used, and a
delete of a `.tres` or a `.tscn` is unconditional.

**How it is known.** A live agent passed `expectedHash: 10` — it invented a number — was refused,
retried, and left an approval nobody answered, which cost the delete step in run 6. The catalog now
says where a hash comes from and that a made-up value is refused (`src-tauri/src/ai_tools.rs:326`),
which stopped the invention, but the underlying asymmetry stands.

**Done means.** Either `godot_resource list` reports a hash per file so the parameter is usable for
any file, or the parameter is documented as script-only. Decide which; today it reads as general and
is not.

---

## 6 — Three tool domains never go through the AI router in a test — KNOWN GAP

**Where.** `src-tauri/src/godot_ai_acceptance.rs` drives one scripted turn through the real worker,
the real router and a real editor. It exercises six tool calls across `godot_scene`, `godot_node`,
`godot_script`, `godot_debug`, `godot_runtime` and `godot_logs`. It never calls `godot_project`,
`godot_resource` or `godot_docs_search`, and it does not call the four wiring commands or
`node.instantiate` added on 2026-08-07.

**Why it matters less than it looks.** `ai_tools::dispatch` forwards `godot_node`/`godot_project`
operations to the addon by name, and
`every_editor_operation_the_catalog_offers_has_an_addon_handler` proves every advertised operation
has a handler. The live sweep drives all of them through the real agent.

**Done means.** Extend the scripted turn to cover the three missing domains and the new commands, or
record that the catalog test plus the live sweep is the intended cover.

---

## 7 — `projectfix.md` is partly stale and was not re-audited

**What is known.** Items 1 (the AI stream on the event bus) and 2 (the leaked listener in
`useGodotSession`) were checked on 2026-08-07 and are both already fixed in the code — item 1 by
commit `7fb2fd8`, item 2 by the `isCancelled` pattern now at `src/hooks/useGodotSession.ts:177-192`.

**What is not known.** Items 3 onward — the clipped composer footer, the popover/card elevation
ramp, and everything after them — were not looked at in this session at all. The document's own
header says it was validated against commit `4d1a607`, which is far behind.

**Done means.** Re-audit `projectfix.md` against `HEAD`, delete what is fixed, and re-date it. Do
not act on any item in it without checking the current source first.

---

## What is deliberately not on this list

- **The `"op": "set_property>"` tool call.** Twice in about a hundred calls the local model emitted
  a stray character in the operation name. Validation refused it, named the problem, and the agent
  recovered. Model noise, correctly handled; nothing to fix.
- **`godot_script open` failing on a script not yet written.** Sequencing by the model, and the
  error says exactly that.
- **The runtime probe's action counter is not device-filtered.** Deliberate: the marker device is
  what stops an action matching at all, so the count has to come from an unmarked event. The binding
  uses F13 to keep a person's typing out of it. Written down at
  `src-tauri/src/godot_runtime_acceptance.rs` beside the constant.

---

## How to check any of this

Run the live sweep and read the agent's own tool failures, which is how most of the above was found:

```
rm -rf /tmp/gofer-live-run /tmp/gofer-live-workspace
npm run build:desktop:test
GOFER_GDFORMAT=$HOME/.local/share/gofer-gdtoolkit/bin/gdformat \
  setsid nohup node node_modules/@wdio/cli/bin/wdio.js run wdio.live.conf.ts > run.log 2>&1 &
```

A full green run is about 25 minutes. The wdio reporter buffers until the end, so watch it through
`messages.payload_json` in `/tmp/gofer-live-run/data/projects/*/project.sqlite` — the aggregation
command is in the `gofer-live-sweep-harness` memory note. **A tool failure that repeats every run is
a defect in Gofer; one that happens once is the model.** That rule found every item in section 1
through 5.
