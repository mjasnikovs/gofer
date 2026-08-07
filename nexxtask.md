# Next task

Rewritten 2026-08-07 after live sweep runs 4 through 7 (`wdio.live.conf.ts`; see the memory note
`gofer-live-sweep-harness`). Run 7 was fully green: 128 of 128 steps in 9 minutes, against the real
editor and the real local model. The working tree carries the tileset/tilemap work and the fixes
below, uncommitted; `npm run check` is green (283 Rust tests, 148 frontend, 18/18 Godot acceptance).

Each item says what is wrong, how it is known, where it lives, and what "done" means. Where
something is a hypothesis rather than a measurement, it says so in those words.

---

## Closed since the last writing

**1 — A dead editor still reports a live session — FIXED, VERIFIED LIVE.** Four separate defects sat
behind this one heading, and each needed its own fix:

- Nothing ever asked whether the child was alive. `godot_session::poll_editor_exit` now asks, and
  the event-forward worker's quiet tick is what calls it (`godot_session_api.rs`) — the renderer
  fetches the session once on mount and then listens, so a check that only ran in `get_session` was
  a check nobody made.
- `stop_run_logging("exited")` was never a status the `godot_runs` CHECK accepts, so the close
  silently failed and the row stayed `running`. The status is a `RunOutcome` enum now, and a test
  closes a run with each of its values.
- `start_session` short-circuited on `current_info()` and answered with the _dead_ session, so the
  "Start editor session" button returned the failed session and started nothing. It now polls first
  and skips the short-circuit when `godot_session::editor_has_exited()`.
- The event subscription belongs to the editor it was made for, and `useGodotSession`'s `subscribe`
  guard was only reset by `stop()`. After a crash the next editor came up with nothing draining its
  events, so it never left `starting` and the window sat on "Loading the scene tree…".

Covered by `an editor that exits on its own` in the live sweep (three steps), by two tests in
`godot_session.rs`, one in `godot_session_api.rs`, and one in `InspectorWorkspace.test.tsx`.

**Stopping the session reported a failed read — FIXED, VERIFIED LIVE.** Pressing Stop put _The scene
tree could not be read — The RPC session was stopped_ on screen: the panels have reads in flight
when the editor goes away, and the answer was true about a question that was already void.
`useGodotQuery` now drops `session_stopped`, `session_not_active` and `transport_closed`, so the
panel falls back to the empty state it already has for having no session.

**2 — The merge fix is reasoning, not evidence — VERIFIED.**
`✓ merges the worktree the agent worked in into the project` has passed in every sweep since, with
the level present in the project afterwards and Gofer's own scaffolding kept out of it.

---

## 3 — A conversation that outgrows the context window dies quietly — HALF FIXED

**What happens.** There is no compaction and no trimming: every turn resends the whole conversation.
When it stops fitting, the server answers one or two tokens with `finish_reason: length`, and Gofer
used to record that as a _complete_ assistant message. Live run 4 recorded nine of them in a row,
each reading "I" or "Let", each with `input: 116,449` against a 120,064-token window. Every step
after that failed, and nothing on screen said why.

**What is fixed.** `scripts/ai-provider.mjs` raises that as an error naming both numbers and the way
out, rather than recording it as an answer. Covered by
`reports a turn that ran out of context rather than recording it as an answer`.

**What is not fixed.** The wall itself. A long session still ends there; the user is told to start a
new task. Compaction, a running context meter that warns before the cliff, or dropping the oldest
tool results are all unbuilt.

**Done means.** Decide whether Gofer compacts. If it does not, that is a legitimate answer — but the
composer should say how close the conversation is to the wall before it hits it, not after.

---

## 4 — `session.cancel` retracting a long-parked request is untested — KNOWN GAP

**What is covered.** The wire half is covered end to end against a fake addon
(`godot_rpc::a_stopped_turn_tells_the_addon_to_give_up`). The editor half is covered as far as
`the_addon_answers_a_cancellation` (`src-tauri/src/godot_addon_acceptance.rs`) can show it — the
command exists, refuses a cancellation naming no request, and answers `cancelled: false` for one
that was never parked.

**What is not covered.** The case the command exists for: retracting a request the addon is actually
holding, and giving readiness back. Godot 4.7 could not be made to hold a scene switch long enough —
it opens a scene with a missing parent by dropping the orphan, and one whose root names an unknown
class by substituting a placeholder. Both were tried and both opened.

**Done means.** Either a deterministic park is found — the most promising untried route is a
`runtime.run` in an editor whose game cannot come up, which parks for `RUNTIME_LAUNCH_TIMEOUT_MS` —
or this is written down as deliberately uncovered where the test would otherwise look thin. Do not
leave it looking covered.

---

## 5 — `require_session_task` has no unit test — KNOWN GAP

**Where.** `src-tauri/src/godot_session_api.rs:138`, called from `call_godot` and from every
`godot_*` tool through `ai_tools::rpc`.

**Why there is no test.** Planting a fake active session needs a seam that does not exist:
`godot_session::ACTIVE_SESSION` is a process-global written only by a real `start`, and
`SessionInfo` carries no task id (the owning task is held separately in `SESSION_TASK`).

**What covers it today.** The live sweep step `does not answer with another task's scene`, which has
passed in every run with the refusal in the log verbatim: _The Godot editor session belongs to
another task._ Before the guard, the same step answered `Level1` — a scene from a checkout the task
had nothing to do with.

**Done means.** Either a `#[cfg(test)]` seam that binds a session info the way
`godot_session::bind_test_rpc` binds a transport, with tests for the three branches (no session,
same task, other task), or an explicit note that the live sweep is the only cover.

---

## 6 — A non-script file cannot be deleted with a hash — REAL GAP, DOCUMENTED ONLY

**What happens.** `godot_resource delete` takes an optional `expectedHash` that refuses the delete
if the file changed since it was read. The only thing that produces a hash is `godot_script`
open/save, which works on `.gd` files. So for every other file the parameter cannot be used, and a
delete of a `.tres` or a `.tscn` is unconditional.

**How it is known.** A live agent passed `expectedHash: 10` — it invented a number — was refused,
retried, and left an approval nobody answered. The catalog now says where a hash comes from and that
a made-up value is refused (`src-tauri/src/ai_tools.rs`), which stopped the invention, but the
underlying asymmetry stands.

**Done means.** Either `godot_resource list` reports a hash per file so the parameter is usable for
any file, or the parameter is documented as script-only. Decide which; today it reads as general and
is not.

---

## 7 — Three tool domains never go through the AI router in a test — KNOWN GAP

**Where.** `src-tauri/src/godot_ai_acceptance.rs` drives one scripted turn through the real worker,
the real router and a real editor. It never calls `godot_project`, `godot_resource` or
`godot_docs_search`, and it does not call the wiring commands, `node.instantiate`, or the four
tileset commands added on 2026-08-07.

**Why it matters less than it looks.** `ai_tools::dispatch` forwards operations to the addon by
name, and `every_editor_operation_the_catalog_offers_has_an_addon_handler` proves every advertised
operation has a handler — it now covers `godot_resource` as well. The live sweep drives all of them
through the real agent, including the tileset commands.

**Done means.** Extend the scripted turn to cover the three missing domains and the new commands, or
record that the catalog test plus the live sweep is the intended cover.

---

## 8 — `projectfix.md` is partly stale and was not re-audited

**What is known.** Items 1 (the AI stream on the event bus) and 2 (the leaked listener in
`useGodotSession`) were checked on 2026-08-07 and are both already fixed in the code.

**What is not known.** Items 3 onward — the clipped composer footer, the popover/card elevation
ramp, and everything after them — were not looked at at all. The document's own header says it was
validated against commit `4d1a607`, which is far behind.

**Done means.** Re-audit `projectfix.md` against `HEAD`, delete what is fixed, and re-date it. Do
not act on any item in it without checking the current source first.

---

## What is deliberately not on this list

- **A script the agent wrote wrong and then fixed.** Run 5 failed
  `reports no error from the script the agent wrote` on a parse error the agent had already been
  told about by `godot_script diagnostics` and had repaired a minute later; the language server
  confirmed it clean (`published: true`, no diagnostics) and the level ran. The assertion was wrong,
  not the app — it searched the whole session log. It now reads from a cursor taken when the game
  launched.
- **The `"op": "set_property>"` tool call.** Twice in about a hundred calls the local model emitted
  a stray character in the operation name. Validation refused it, named the problem, and the agent
  recovered. Model noise, correctly handled.
- **The game window's size.** A tiling window manager owns it and Godot resizes the viewport to
  match, so the sweep asserts a size is named and non-zero rather than `640×360`.
- **The runtime probe's action counter is not device-filtered.** Deliberate: the marker device is
  what stops an action matching at all, so the count has to come from an unmarked event. Written
  down at `src-tauri/src/godot_runtime_acceptance.rs` beside the constant.

---

## How to check any of this

Run the live sweep and read the agent's own tool failures, which is how most of the above was found:

```
rm -rf /tmp/gofer-live-run /tmp/gofer-live-workspace
npm run build:desktop:test
npx wdio run wdio.live.conf.ts > run.log 2>&1
```

A green run is 13–15 minutes; a run where the agent needs many retries is closer to 50. The wdio
reporter buffers until the end, so watch it through the `messages` table in
`/tmp/gofer-live-run/data/projects/*/project.sqlite` — the aggregation command is in the
`gofer-live-sweep-harness` memory note. **A tool failure that repeats every run is a defect in
Gofer; one that happens once is the model.** That rule found every item above.
