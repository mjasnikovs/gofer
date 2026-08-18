# REFACTOR3 — Kill trusted memory

One principle drives every task here: **the app must never report its own bookkeeping as reality.**
Ten live sweeps found one defect shape: Gofer answered truthfully about a wrong question
(`saved: true` while Godot saved nothing, a badge alive after the editor died, tools declared but
unreachable). This refactor removes the pattern, not the instances.

## Rules for the executor

1. One task per commit. `npm run check` green before moving on.
2. Every task ends with a **sabotage proof**: plant the defect the task claims to prevent, show the
   gate or the app go red, revert, show green. Paste both outputs into the task log below. No pasted
   red+green, not done.
3. Never weaken a check or assertion to get past red. If an assertion is wrong, say why in the
   commit message.
4. Do not claim "fixed", "done", or "works" without the pasted proof.

---

## Task 1 — Command-surface drift check

**Is now:** five surfaces must agree by hand: command registration in `src-tauri/src/lib.rs`, types
in `src/services/desktop.ts`, the allow-list in `src-tauri/permissions/main-window-commands.toml`,
the handlers in `src-tauri/addon/protocol.gd`, and the schemas in `protocol/schemas/v2/`. The sweeps
found four commands declared in the protocol that the addon never implemented. Nothing can catch
that today.

**Will be:** `scripts/check-command-surface.mjs` parses all five surfaces and fails on any command
present in one and missing in another. It joins the `check:*` chain in `package.json` and therefore
the pre-commit gate.

Steps:

1. Write the parser for each surface. Exact string matching on names. No heuristics that "probably"
   match.
2. Run it. It should fail today if any drift still exists. Fix real drift by implementing or
   deleting, never by teaching the checker to ignore.
3. Wire it into `npm run check`.

Sabotage proof: add a fake command to the toml only. Show `check` red. Revert. Show green.

---

## Task 2 — Generate the mechanical surfaces

**Is now:** the toml allow-list, the `desktop.ts` command-name strings, and the addon's dispatch
table are hand-written copies of the schema.

**Will be:** a generator (`scripts/generate-command-surface.mjs`) emits those three from
`protocol/schemas/v2/`. Generated files carry a header comment and a checksum. Task 1's checker
fails if a generated file was hand-edited.

Steps:

1. Generate only the mechanical parts. Hand-written logic stays hand-written.
2. Regeneration must be idempotent: running it twice changes nothing.
3. Add `generate` to the docs in AGENTS.md: schema change → regenerate.

Sabotage proof: hand-edit one generated file. Show `check` red. Regenerate. Show green.

---

## Task 3 — Read-back before "done"

**Is now:** mutating Godot commands answer success from their own state. `project.set_setting` said
`saved: true` while Godot created a junk setting and ran the old scene.

**Will be:** every mutating command in `src-tauri/addon/` re-reads the named thing through Godot's
own API before replying. Setting write → fresh `get_setting` on the exact key. Node change →
re-fetch the node. Scene save → re-open metadata. Mismatch returns an error naming both values,
never success.

### Every mutating command in the addon

The schema's `MUTATING_COMMANDS` names the eighteen that change the **edited scene** and therefore
carry `expectedRevision`. Eleven more change the **project or a file** and are not scene mutations,
so the schema is right not to list them — but they write, and the defect that started this refactor
was one of them. All twenty-nine are read back.

| Command                                   | Read back through                                       |
| ----------------------------------------- | ------------------------------------------------------- |
| `session.undo` / `session.redo`           | the scene history's own `get_version()` across the step |
| `scene.create`                            | the file, reloaded, for its root name and type          |
| `scene.save` / `scene.save_as`            | the file, reloaded, node for node against the tree      |
| `scene.reload`                            | the editor really editing a new root (already did)      |
| `node.create`                             | the parent resolving the child, owned by the root       |
| `node.instantiate`                        | the same, plus `scene_file_path`                        |
| `node.duplicate`                          | the parent resolving the copy, owned by the root        |
| `node.rename`                             | `node.name`                                             |
| `node.reparent`                           | the new parent resolving the node, owned by the root    |
| `node.delete`                             | the path resolving to nothing                           |
| `node.set_property`                       | `node.get(property)`                                    |
| `node.add_to_group` / `remove_from_group` | `node.is_in_group`                                      |
| `node.connect_signal`                     | `is_connected`, and the flags Godot recorded            |
| `node.disconnect_signal`                  | `is_connected`                                          |
| `node.set_cells`                          | `get_cell_source_id` / `get_cell_atlas_coords` per cell |
| `project.set_setting`                     | `ProjectSettings.get_setting`                           |
| `project.reset_setting`                   | the same, against the default or nothing                |
| `project.set_autoload`                    | the `autoload/` entry, star and all                     |
| `project.remove_autoload`                 | `has_setting`                                           |
| `project.set_input_action`                | the stored action; the reply is built from it           |
| `project.remove_input_action`             | `has_setting`                                           |
| `project.reset_input_action`              | `has_setting`                                           |
| `project.set_plugin_enabled`              | `EditorInterface.is_plugin_enabled`                     |
| `editor.set_setting`                      | `EditorSettings.get_setting`                            |
| `resource.create_tileset`                 | the file, reloaded, for tiles and collision polygons    |
| `resource.create_shape`                   | the file, reloaded, for its class                       |

`resource.rescan` is the one write with nothing to read: it tells the editor's filesystem a file
changed and names no value.

Steps:

1. List every mutating command in the addon. Put the list in this file.
2. Add read-back to each. The read must go through Godot, not through the value the command still
   holds in a local variable.
3. Extend `test:godot:addon` with one read-back test per mutating command.

Sabotage proof: make one command skip its write but keep its old reply. Show the acceptance suite
red with a value mismatch. Revert. Show green.

---

## Task 4 — Derive status, delete stored status

**Is now:** run badge, `get_godot_session` state, stale-save banner, and node selection live in app
memory and outlive reality. A dead editor still shows `running` (reproduced 2026-08-07, never
fixed).

**Will be:** no UI status field is stored. Each one is derived from a live probe or expires with its
cause. Commit 9f61414 ("ask Godot instead of remembering") is the model — extend it to every status.

### Every stored status, and what became of it

| Where                             | What it claimed               | Verdict                                                  |
| --------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `godot_session.rs` `state`        | the editor's lifecycle        | **deleted.** Derived from the child and the addon        |
| `godot_session_api.rs` run row    | a run in progress             | **closed on open.** Gofer's own death left it open       |
| `debug-panel.ts` `isLaunched`     | a game to stop                | **scoped.** Expires with the editor's play state         |
| `debug-panel.ts` `stopped`        | where the game is stopped     | the same — it is part of the same reading                |
| `ui-state.ts` runtime `selection` | a node in the running game    | **scoped** to the run it was read from                   |
| `GameView.tsx` `capture`          | the game's last frame         | **scoped** to the run it was captured from               |
| `ui-state.ts` edited `selection`  | a node in the edited scene    | already retired against the open scene (`774d166`)       |
| `script-buffers.ts` `conflict`    | the stale-save banner         | already answerable and cleared by its answer (`ac5a290`) |
| `godot-session-state.ts` `scene`  | the edited scene and `dirty`  | event-scoped; the addon polls the editor and re-emits    |
| `health.ts`                       | what the workspace is missing | recomputed by Rust on every read                         |

Steps:

1. Inventory every stored status in `src/` and `src-tauri/src/`. Above.
2. Replace each: live probe with a short timeout, or event-scoped state that dies with the event
   that created it.
3. The dead-editor case gets a test: kill the editor process mid-session, assert the badge flips
   within its probe interval.

Sabotage proof: kill Godot by hand while the app runs. Show the badge flip. Then re-introduce one
stored field, show the new test red, revert, green.

---

## Task 5 — Tool reachability, and register docs-RAG

**Is now:** the agent's tools are assembled in `scripts/ai-provider.mjs` (line ~204). Docs-RAG
appears nowhere in that list. Zero calls was not the model refusing the tool. The tool does not
exist at the call site.

**Correction, found while executing:** docs-RAG _is_ at the call site. `godot_docs_search` is the
tenth entry of `CATALOG` in `src-tauri/src/ai_tools.rs`, the whole catalog is sent to the worker,
and `createGodotTools` builds a tool from every entry. What was missing is the other half: nothing
proved the tool could answer. It retrieves through a sidecar script and a 2.9 GB model cache that
live outside the binary, so it can be declared to the model with nothing behind it, and every call
fails as `docs_unavailable` while the turn carries on. See the log below.

**Will be:** docs-RAG is a registered tool backed by `scripts/rag-retrieve.mjs`. At worker startup,
every declared tool is invoked once in a dry-run/ping mode. A tool that cannot answer fails startup
loudly.

Steps:

1. Register the docs-RAG tool with a description the model can act on.
2. Add the startup reachability pass.
3. Add a `test:worker` case: declared-but-dead tool → startup fails.

Sabotage proof: point the docs-RAG tool at a missing script path. Show startup red. Revert. Show
green. Then one real chat asking a docs question, paste the SQLite `messages` row showing the tool
call.

---

## Task 6 — Sweep asserts named things

**Is now:** two sweep assertions passed by matching the agent's own chat transcript. Text search
over the window is satisfied by the agent talking about the thing instead of doing it.

**Will be:** every `e2e/live` assertion reads a named source: the exact setting via
`project.get_setting`, the exact SQLite row, the exact file on disk. Window-text assertions are
deleted or rewritten. New scenarios: docs question asserts ≥1 docs-RAG call; long chat asserts
compaction ran and the session continued.

Sabotage proof: disable docs-RAG registration, run that one scenario, show red with "0 docs-RAG
calls". Revert. Show that scenario green.

---

## Order

1 → 2 → 3 → 5 → 4 → 6. Task 1 is the foundation. Task 6 is the proof the class is dead: one full
sweep, all scenarios green, report pasted here.

## Task log

(the executor appends proofs here, newest last)

### Task 1 — Command-surface drift check (2026-08-08)

`scripts/check-command-surface.mjs` parses nine anchored regions across the five surfaces and
compares them as exact strings. Two namespaces:

- **Desktop commands** must agree three ways: the `invoke_handler` list in `src-tauri/src/lib.rs`,
  the `DesktopCommandMap` keys in `src/services/desktop.ts`, and `commands.allow` in
  `src-tauri/permissions/main-window-commands.toml`. 55 names each. Keys carrying `:` are a Tauri
  plugin's own commands with their own permission set, so they are excluded by name, not by guess.
- **Mutating Godot commands** must agree five ways: the schema enum in
  `protocol/schemas/v2/request.schema.json`, `MUTATING_COMMANDS` in `src-tauri/addon/plugin.gd`, in
  `src-tauri/src/protocol_v2.rs` (whose declared array length is checked against its own entries),
  in `src/services/godot-protocol.ts`, and the prose list in `protocol/README.md`. 18 names each.
  Every one must also have a case in the addon's `_dispatch_command` table (48 handlers), and every
  handler name must satisfy the schema's own `command` pattern.

Each parser throws by name if its anchor moves, so a renamed constant fails loudly instead of
silently parsing to nothing. Empty and duplicated lists fail too.

**Real drift found on the first run.** `protocol/README.md` listed 17 mutating commands; the other
four surfaces listed 18. `node.set_cells` was implemented, gated, and enumerated everywhere except
the specification that is supposed to be frozen:

```
Error: command surfaces disagree:
mutating Godot command node.set_cells is declared in protocol/schemas/v2/request.schema.json,
src-tauri/addon/plugin.gd MUTATING_COMMANDS, src-tauri/src/protocol_v2.rs MUTATING_COMMANDS,
src/services/godot-protocol.ts MUTATING_COMMANDS but missing from protocol/README.md mutating
command list
```

Fixed by adding the command to the README, not by teaching the checker to skip prose.

Wired in as `check:command-surface`, between `check:ignored-tests` and `check:design` in the `check`
chain, and therefore in the pre-commit gate.

#### Sabotage proof

Added `"adopt_a_stray_command"` to the toml allow-list only. `npm run check`:

```
> npm run --silent format:check && ... && npm run --silent check:command-surface && ...

Error: command surfaces disagree:
desktop command adopt_a_stray_command is declared in
src-tauri/permissions/main-window-commands.toml but missing from src-tauri/src/lib.rs,
src/services/desktop.ts
    at file:///home/edgars/hub/gofer/scripts/check-command-surface.mjs:201:32
PIPESTATUS=1
```

Reverted. Full `npm run check`:

```
25/25 Godot acceptance tests passed in 24.8s across 6 processes
...
[chrome 150.0.7871.128 linux #0-0] 1 passing (645ms)
Spec Files:	 1 passed, 1 total (100% completed) in 00:00:02
PIPESTATUS=0
```

### Task 2 — Generate the mechanical surfaces (2026-08-08)

`scripts/generate-command-surface.mjs` emits six regions across four files. Three sources, none of
them generated:

- `protocol/schemas/v2/request.schema.json` — which commands mutate the edited scene. Unchanged.
- `protocol/schemas/v2/commands.json` — **new.** Every command the addon answers and the addon
  method that answers it. 48 entries. It carries no mutating flag, so it cannot disagree with the
  schema about one.
- `src-tauri/src/lib.rs` `generate_handler!` — which desktop commands exist.

Generated:

| File                                              | Region              | From          |
| ------------------------------------------------- | ------------------- | ------------- |
| `src-tauri/addon/plugin.gd`                       | `MUTATING_COMMANDS` | schema        |
| `src-tauri/addon/plugin.gd`                       | dispatch table      | commands.json |
| `src-tauri/src/protocol_v2.rs`                    | `MUTATING_COMMANDS` | schema        |
| `src/services/godot-protocol.ts`                  | `MUTATING_COMMANDS` | schema        |
| `src-tauri/permissions/main-window-commands.toml` | `commands.allow`    | lib.rs        |

Each region sits between `GENERATED-BEGIN <name> sha256:<checksum>` and `GENERATED-END <name>` in
the target file's own comment syntax, so the checksum moves in the diff whenever the body does. The
emitters produce the bytes prettier and rustfmt already leave behind, so no formatting pass runs
after generation and the checksum cannot go stale.

Handler arity is **read from the addon**, not declared in the catalogue: `_scene_tree()` takes no
params and `_scene_open(params)` does, and a catalogue that repeated that could disagree with the
function it names. A catalogue entry naming a method `plugin.gd` does not define fails generation.

`session.heartbeat` was the one dispatch case with an inline body (`return {}`). It now calls a real
`_session_heartbeat()`, which is what makes every one of the 48 cases the same shape.

Two surfaces stay hand-written, on purpose, and Task 1's checker still holds them to the rest:

- `src/services/desktop.ts` — each name carries an argument type and a response type. Those are
  decisions, not transcription.
- `protocol/README.md` — states the mutating list as prose, and prettier's `proseWrap: always`
  reflows prose. A generated region there would fight the formatter.

Task 1's checker gained two things: it now compares `commands.json` against the addon's dispatch
table by name, and it ends by calling `checkSurfacesAreGenerated()`, which regenerates every region
into memory and fails naming any file that differs. Wired as `npm run generate`; documented in
AGENTS.md under "Generated command surfaces".

Regeneration is idempotent — the first run after adding the markers reproduced all six regions
byte-for-byte apart from the heartbeat change above, and a second run rewrote nothing.

#### Sabotage proof

Hand-edited a generated region: swapped `'session.undo'` and `'session.redo'` in
`src/services/godot-protocol.ts`. Chosen because Task 1's comparison is set-based — it would pass
this. Only the new gate can see it. `npm run check`:

```
Error: these generated regions do not match their source — run `npm run generate`:
src/services/godot-protocol.ts
    at checkSurfacesAreGenerated (file:///home/edgars/hub/gofer/scripts/generate-command-surface.mjs:214:15)
    at async file:///home/edgars/hub/gofer/scripts/check-command-surface.mjs:220:1
PIPESTATUS=1
```

`npm run generate` rewrote the region. Full `npm run check`:

```
25/25 Godot acceptance tests passed in 27.0s across 6 processes
...
[chrome 150.0.7871.128 linux #0-0] 1 passing (645ms)
Spec Files:	 1 passed, 1 total (100% completed) in 00:00:02
PIPESTATUS=0
```

### Task 3 — Read-back before "done" (2026-08-08)

Twenty-nine mutating commands, listed in the task above with what each one now re-reads. Two shared
helpers carry the pattern:

- `_readback_error(what, wanted, found, details)` — one error code, `readback_mismatch`, naming both
  values. A mismatch is never a success with a caveat.
- `_same_value(wanted, found)` — the comparison. Three things make an exact one wrong and none of
  them is a failed write: a property the engine declares as a float stores 32 bits, so a double
  comes back a few bits away from itself; a number written as `5` into a float property reads back
  as `5.0`; and a property holding no object is a `TYPE_OBJECT` variant with a null pointer, not
  `TYPE_NIL`, so clearing one reads back as a different type than the null that cleared it.

Three read-backs are worth naming on their own:

- **`scene.save`** loads the saved file again with `CACHE_MODE_IGNORE` — a plain load answers with
  the `PackedScene` the editor already holds, which is the bookkeeping, not the file — and compares
  its `SceneState` node for node against the root and everything it owns. That set is exactly what a
  save is supposed to write, so `dirty: false` can no longer be said about a file that is minutes
  old.
- **`node.create`** checks the owner as well as the parent. A node the root does not own resolves in
  the tree, answers for itself, and is left out of the `.tscn` entirely on the next save.
- **`node.connect_signal`** reports the flags Godot recorded rather than the ones it asked for. A
  connection without `CONNECT_PERSIST` works in the editor and is dropped when the scene is packed.

`scene.reload` already waited for the editor to really switch (commit 9f61414's pattern) and is
unchanged. `session.undo` and `session.redo` read the scene history's own `get_version()` across the
step, because `UndoRedo.undo()` answers `true` for an action list it walked without doing anything.

Two replies gained a field, both of them the read-back itself: `node.set_property` and
`editor.set_setting` now carry `value`, encoded from what the object holds afterwards.

New module, one test per state family rather than one per command — each test boots a real editor
and this suite is a pre-commit gate, so the twenty-nine assertions share five sessions:

```
godot_readback_acceptance::every_scene_command_answers_from_the_file_it_wrote
godot_readback_acceptance::every_node_command_answers_from_the_edited_tree
godot_readback_acceptance::cells_and_resources_answer_from_what_they_wrote
godot_readback_acceptance::history_commands_answer_from_the_editors_own_history
godot_readback_acceptance::every_configuration_command_answers_from_godot
```

Each drives a mutating command and reads the same thing back by a route the command does not
control: the sibling read command, `scene.get_tree`, or the bytes of `project.godot` and the `.tscn`
on disk.

One harness change: `scene.reload` joined `SCENE_SWITCHES` in the acceptance `Session`. A reload
replaces the root with the one on disk and answers revision 0, which is a rebase like `scene.open`,
not a revision moving backwards.

The whole existing suite runs through the new read-backs unchanged — 25 tests, none of them
weakened, none of them found lying. The 30-test suite costs 34.3s against 29.7s for 25.

#### Sabotage proof

`project.set_setting` made to skip its write and keep its old reply:

```gdscript
    # SABOTAGE: the write is skipped and the old reply kept.
    var failure := _save_project_or_error()
```

`npm run test:godot:addon`:

```
FAIL godot_addon_acceptance::configuration_editors_persist_across_restarts_and_clean_up
FAIL godot_addon_acceptance::the_addon_gives_up_a_request_it_is_still_holding
FAIL godot_journey_acceptance::the_final_journey_takes_one_task_from_connect_to_a_second_task
FAIL godot_readback_acceptance::every_configuration_command_answers_from_godot

project.set_setting failed: readback_mismatch: project.set_setting readback/knob:
the write asked for 7 and Godot holds <null>

project.set_setting failed: readback_mismatch: project.set_setting application/run/main_scene:
the write asked for res://not-here.tscn and Godot holds res://main.tscn

26/30 Godot acceptance tests passed in 32.9s across 6 processes
```

Reverted. Full `npm run check`:

```
30/30 Godot acceptance tests passed in 34.4s across 6 processes
...
[chrome 150.0.7871.128 linux #0-0] 1 passing (721ms)
Spec Files:	 1 passed, 1 total (100% completed) in 00:00:02
PIPESTATUS=0
```

### Task 5 — Tool reachability, and register docs-RAG (2026-08-08)

The premise was half wrong and the fix is the other half. `godot_docs_search` was already the tenth
entry of `CATALOG`, already sent to the worker, already built into a tool by `createGodotTools`. It
was never proven. Its description is now one the model can act on — search before writing a class,
method, signal or constant you are not certain of — and every tool is now proven before the turn
starts.

**The pass.** `scripts/ai-reachability.mjs` invokes every declared tool once, before the model is
told anything, and the turn does not start unless all of them answer:

- The four workspace tools are one probe in four steps against one file: `write` puts a known word
  in `.gofer-tool-probe`, `edit` replaces it, and `read` and `bash` each have to come back with the
  replacement. A tool that answered without doing its work is caught by the tool after it, so the
  pass proves the workspace — that it exists, that it can be written, that the shell starts in it —
  rather than proving four functions exist. The file is removed whether the pass succeeds or fails.
- Every other declared tool is asked over the same duplex channel a real call uses, with the
  reserved `{probe: true}` request. The model cannot forge one: the tools it is given take
  `{op, params}`, so nothing it writes reaches that level of the call.

**The answer.** `probe()` in `src-tauri/src/ai_tools.rs` answers it before the operation is read — a
probe names none — and before approvals, because proving a tool can answer must never open a dialog.
Nine domains route to the editor session, the debug adapter or the log buffer, all compiled into the
binary: being routed is the whole of their reachability. `godot_docs_search` is the exception and
the reason the pass exists, so its probe reads the machine: the sidecar script, then the ten model
files the retrieval loads. A domain added to the catalog with no probe fails `unprobed_tool` rather
than defaulting to reachable, and `npm run check` holds that.

Nothing is exempt. A tool with no probe of its own is probed through the backend, which answers
`unknown_tool` for a name it does not route.

New `test:worker` cases:

```
a declared tool that cannot answer stops the turn before the model is asked
a dead tool fails worker startup loudly rather than quietly
the workspace tools are proven against the workspace, not assumed
a tool that never answers its probe is given up on, and one the turn outlived is not
a workspace tool that answers without doing its work is caught by the next one
```

Six existing tests changed: their fake backends now answer the probe, because a fake that stays
silent is a backend the application would refuse to talk to. `godot_ai_acceptance` points the
documentation probe at the `fixtures/rag` sidecar and a staged cache directory, for the same reason
the tool is otherwise absent from that suite — a suite that downloads three gigabytes before it can
start is not one anybody runs.

#### Sabotage proof

The documentation tool pointed at a script path that does not exist, and the real turn run:

```
thread 'godot_ai_acceptance::an_ai_turn_edits_a_scene_fixes_a_diagnostic_debugs_and_captures_the_game'
panicked at src/godot_ai_acceptance.rs:624:9:
the AI turn failed: Pi AI request failed: The turn was not started, because the model would have
been told about a tool it cannot use:
- godot_docs_search: docs_unavailable: Gofer RAG retrieve worker was not found at
/home/edgars/hub/gofer/src-tauri/../fixtures/rag/retrieve-worker-that-was-never-installed.mjs.
Run npm install, or set GOFER_RAG_RETRIEVE_WORKER.
```

Reverted. Full `npm run check`:

```
30/30 Godot acceptance tests passed in 28.6s across 6 processes
...
[chrome 150.0.7871.128 linux #0-0] 1 passing (683ms)
Spec Files:	 1 passed, 1 total (100% completed) in 00:00:02
EXIT=0
```

#### The tool being used, for real

One turn against the local model (Qwen3.6-27B on 127.0.0.1:8080) through the real worker, the real
router, the real gofer-rag sidecar and the real 2.9 GB index — asked what `Tween` does and which
method starts a property tween. The streamed tool events:

```
{"requestId":1,"event":{"id":"AQgmFVQE3GUiR1J65Oy8YOg7qwlmyGvZ","name":"godot_docs_search",
 "startedAt":1786211483706,"target":"search","type":"tool-start"}}
{"requestId":1,"event":{"endedAt":1786211495228,"id":"AQgmFVQE3GUiR1J65Oy8YOg7qwlmyGvZ",
 "isError":false,"output":"{\"passages\":[{\"chapter\":\"Tween\",\"order\":1515,
 \"score\":3.1728694438934326,\"text\":\"...tween.tween_property($Sprite, \\\"position\\\",
 Vector2(100, 200), 1.0)...\"}]}"}}
```

The answer it wrote back names `tween_property` and `create_tween` off those passages. This was run
through `run_ai_worker_with` and thrown away, not through the window, so it is a live turn rather
than a `messages` row. The row belongs to Task 6, which adds the scenario that asserts ≥1 docs-RAG
call to `e2e/live`.

### Task 4 — Derive status, delete stored status (2026-08-08)

The premise held. The one field everything else hung off was `GodotSession.state` in
`src-tauri/src/godot_session.rs`, and the only thing that ever moved it was
`update_state_from_event`, which runs on the event-subscription worker. With nothing subscribed the
state never moved at all, and `get_godot_session` answered from it. Both earlier fixes — `f1e20dc`'s
child poll and `9f61414`'s reconcile tick — added someone to ask; neither made the answer true.

**The field is gone.** `derive_state` works the state out on every read from three live facts, each
owned by the thing that can see it:

- the child process, asked with `try_wait`. An editor that crashed or that the user closed is
  `Error` from the moment it exits, whether or not anything ever polls.
- the addon's own readiness. It announces every transition it makes, and the transport records them
  on its reader thread — which lives as long as the connection, subscriber or not.
- whether Godot is playing the project, which the addon polls out of
  `EditorInterface.is_playing_scene()` every frame.

The last two now live in `godot_rpc.rs` beside the connection that produced them, so they expire
with it rather than being cleaned up by someone. Three consequences worth naming:

- The handshake used to set readiness to `Ready`. A connected socket is not a ready editor, and an
  editor importing four thousand resources said `ready` for the length of the import. It sets
  `Starting`, and the addon's own first announcement is what moves it.
- `session.debug_paused`, `session.stopping` and `Staging` have no producer anywhere. They stay in
  the enum, which is the frozen protocol's, and `derive_state` names none of them.
- The addon kept `_ready_notified` across a dropped connection, so a reconnected addon never said it
  was ready again: `_readiness` stayed on the `unavailable` the drop wrote and every mutation was
  refused `not_ready` against a healthy editor. The announcement belongs to the connection, so it
  goes with it.

`poll_editor_exit` is now only a latch — "was this call the one that found it" — because there is no
longer a state for it to mark.

**The run row.** `godot_runs.status` is closed when the editor stops and when it is found gone. A
Gofer that is killed closes nothing, and nothing later ever would: the run belonged to a session of
a process that no longer exists. The row read as a session running right now in the user's own
history — the stale badge, written to disk. `close_abandoned_runs` ends every open row when the
project database opens, dated by the last output that run actually recorded.

**The renderer.** Four surfaces, all of them now derived on the way out rather than dispatched on a
change, so there is no render that still shows the thing that has gone:

- `whileTheGameRuns(panel, isPlaying)` retires the launch, the stop, its frames and its scopes
  together. The adapter reports a debuggee that ends while it is watching for the next stop and says
  nothing at all about one killed from outside — so Stop Game sat there over a game gone for an hour
  with the stack of its last breakpoint underneath it.
- The toolbar's Run/Stop reads the editor's play state rather than what Gofer launched, so a game
  the Game tab's own Run started is one the toolbar can stop. Stop routes by how it was started:
  `terminate` for a debug session, `runtime.stop` otherwise.
- `nodeStillChosen` retires a runtime node against the run it was read from, the way an edited node
  was already retired against its scene. A stored runtime node is dropped on the way in: a project
  reopens with no game running.
- A captured game frame is retired with its run. A capture of the editor viewport is not of a game,
  so nothing retires it.

One test fixture changed rather than one assertion: `InspectorWorkspace.test.tsx`'s fake backend now
moves the editor's play state on launch and terminate and announces it, because a fake that answers
`ready` through a running game is a backend the application would be right to disbelieve.

New tests:

```
godot_rpc::tests::the_addons_readiness_and_play_state_are_taken_from_its_own_events
godot_session::tests::an_editor_that_exits_on_its_own_is_reported_as_failed   (reads before polling)
storage::tests::a_run_left_open_by_a_gofer_that_died_is_closed_when_the_project_opens_again
InspectorWorkspace > stops presenting an editor whose process is gone, within one tick
InspectorWorkspace > stops offering to stop a game the editor is no longer playing
the game surface > stops showing a frame of the game once that game is gone
the game surface > keeps a capture of the editor across a game that came and went
nodeStillChosen > six cases, including a stored runtime node that is never given back
while the game runs > three cases
```

#### Sabotage proof

**The editor killed for real.** `godot_runtime_acceptance` runs the pinned editor, plays the fixture
game through it, and now reads the session's own view at each step — the view every badge is derived
from, with nothing subscribed to the event channel. The test ends by killing the editor process,
which is what a crash and a person closing the window both look like: no event, no reply, nothing
told. Sabotaged by keeping what the addon last said after the addon is gone:

```rust
        state.connection = ConnectionState::Idle;
        // SABOTAGE: what the addon last said is kept after the addon is gone.
```

`npm run test:godot:addon`:

```
FAIL godot_runtime_acceptance::the_runtime_loop_drives_input_and_proves_it_with_tree_and_screenshots
panicked at src/godot_runtime_acceptance.rs:308:9:
the session settled on Ready/playing=false rather than Starting/playing=false
29/30 Godot acceptance tests passed in 44.7s across 6 processes
```

**One stored field, three times.** Each of the three derivations was replaced by the remembered
value it deleted.

`derive_state` made to keep the last state instead of asking the child:

```rust
    // SABOTAGE: the state is remembered instead of asked, so a dead editor keeps its last one.
    if false {
        return SessionState::Error;
    }
```

```
FAILED godot_session::tests::an_editor_that_exits_on_its_own_is_reported_as_failed
assertion `left == right` failed
  left: Starting
 right: Error
```

`whileTheGameRuns` made to believe the launch until something contradicts it:

```
 × retires the launch, the stop and its frames the moment the game is gone
 × stops offering to stop a game the editor is no longer playing
   expected true to be false
      Tests  2 failed | 43 passed (45)
```

`nodeStillChosen` made to keep a runtime node, on the old reasoning that the edited scene changing
does not touch it:

```
 × retires a runtime node when the game it belonged to ends
AssertionError: expected { origin: 'runtime', …(3) } to be undefined
      Tests  1 failed | 32 passed (33)
```

Reverted. Full `npm run check`:

```
 Test Files  29 passed (29)
      Tests  422 passed (422)
test result: ok. 302 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.06s
Gofer Godot protocol fixtures passed
30/30 Godot acceptance tests passed in 37.0s across 6 processes
[chrome 150.0.7871.128 linux #0-0] 1 passing (650ms)
Spec Files:	 1 passed, 1 total (100% completed) in 00:00:02
EXIT=0
```

### Task 6 — Sweep asserts named things (2026-08-08)

One rule now decides every assertion in `e2e/live`: **a claim about something the agent worked on is
read from the thing that owns it.** The window is still asserted against — this is a sweep that
presses buttons — but only for words the window owns and the agent never writes. "No editor running"
is one of those. `application/run/main_scene` is not: the transcript beside the panel says it a
dozen times, and that is how a text search over the window passed while the inspector showed
nothing.

#### What each rewritten assertion reads now

| The claim                             | Read before                             | Reads now                                                                                              |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| the agent used its Godot tools        | `godot_scene` in the transcript         | the `tools` array of the assistant row in `messages`                                                   |
| the level's input actions exist       | `move_left` anywhere in `project.godot` | `project.list_input_actions`                                                                           |
| the level has a player                | `scripts/mario.gd` exists               | `scene.get_tree` for a `CharacterBody2D` named Player, plus the scene resource that carries the script |
| the camera and the HUD                | `Camera2D`/`CanvasLayer` as substrings  | `scene.get_tree`, by type and by parent                                                                |
| three enemies, instanced              | `instance=ExtResource(` counted         | the nodes instancing `res://scenes/goomba.tscn`, resolved through the file's own resource ids          |
| the coin's wiring is in the inspector | the whole window                        | the inspector's own region                                                                             |
| the inspector reads the main scene    | the whole window                        | the inspector's own region                                                                             |
| the approval dialog names the file    | the whole window                        | the open dialog                                                                                        |
| the run row closes with the editor    | one read, taken immediately             | the row, waited for — the backend closes it when it notices                                            |

Two assertions still read the model's own words, on purpose. `SEEN`/`BLIND` is the only thing that
can say the image bytes arrived, and it is guarded by its opposite. The refusals — "contains no
project.godot" — are the application's sentences, and the agent never writes them.

The `.tscn` reads parse the file rather than searching it: `uid="uid://…"` contains `id="`, so the
first pattern mapped every resource that carries a uid under its uid, and a level with three enemy
instances in it read as having none. Named here because the fix is a regex and the failure was three
agent turns.

#### New scenarios

- **the documentation tool** asks a documentation question and holds the turn to at least one
  `godot_docs_search` call in the `messages` rows — and to what that call answered, because a tool
  declared with nothing behind it answers `docs_unavailable` while the turn carries on.
- **a conversation that outgrows the context window** narrows the connection to a 48,000-token
  window after the Mario build has filled ~80,000, then asks one more question. It asserts the
  compaction summary the task row now remembers in place of the conversation, and the finished
  answer written after it. Both numbers are bounds the scenario proves nothing outside: below the
  line nothing is summarised, and at 28,000 the turn after the summary filled 34,934 tokens of the
  window and stopped after one word.

`untilTurnSettled` waits on the row rather than on the composer. `Ask anything` is on screen for the
beat between the message being sent and the turn declaring itself, so a wait on the placeholder came
back before the turn had started — and the test that walked away next took the turn with it and
blamed the application for an `aborted` reply it had interrupted itself.

#### Three defects the honest assertions found

- **A game frame retired by the run it was a picture of.** `GameView` tagged each capture with the
  workspace's runtime epoch read when the command was _sent_; pressing Run moves that epoch, and the
  move and the answer race. The panel read "No frame captured" over a game it had just started and
  drawn. The tag is gone: a game frame is shown while the editor is playing, and the commands that
  end a game take its picture down when they are pressed rather than when they answer.
- **A play state that could not come back.** `runtime.stopped` — the game's debugger session going
  away — was taken as the editor having stopped. A restart tears that session down and starts the
  next game inside one frame, so the addon's own play-state poll never sees a gap and never
  announces the new game: Gofer stayed certain nothing was playing over a game that ran for minutes,
  and Restart failed two sweeps running. The editor's poll is now the only writer of that fact; the
  helper's teardown says nothing about it.
- **Three assertions naming controls the application does not have.** `Agent system prompt` (the
  agent's prompt is not a connection field and lives in its own section), `Session` (the output
  scope is called `This run`), and `Editor session stopped` (the toolbar says `Editor stopped`).
  Each had been failing since the rename; each is a test that could never have gone green.

One race in the sweep itself: `openLevelInEditor` clicked and read the tree in the same breath, and
the fixture's main scene has a `Player` in it too — so the level's own tree was read before the
editor had switched. It now waits for the editor to say it is editing the level.

#### Sabotage proof

docs-RAG registration disabled — `createGodotTools` filtered `godot_docs_search` out, so the model
is never given the tool and the reachability pass has nothing to probe:

```
[WebKitGTK 605.1.15 linux #0-0]     the documentation tool
[WebKitGTK 605.1.15 linux #0-0]        ✖ answers a documentation question with at least one docs-RAG call
[WebKitGTK 605.1.15 linux #0-0] 1 failing (2m 52s)
the documentation question made 0 docs-RAG calls; the agent called
["bash","bash","bash","bash","bash","bash","bash","bash","bash"]
```

Nine bash calls: told to search the documentation with a tool it did not have, the agent went
looking for the docs on the filesystem and then `curl`ed docs.godotengine.org.

Reverted. The same scenario:

```
[WebKitGTK 605.1.15 linux #0-0]        ✓ answers a documentation question with at least one docs-RAG call
[WebKitGTK 605.1.15 linux #0-0] 1 passing (43.7s)
```

and the row it passed on:

```
{"name": "godot_docs_search", "target": "search", "status": "complete"}
{"passages":[{"chapter":"CharacterBody2D","order":543,"score":4.864238262176514,"text":"CharacterBody2D
Inherits: PhysicsBody2D < CollisionObject2D < Node2D < CanvasItem < Node < Object…
```

#### The full sweep

Every scenario, in order, against the real editor, the real model and the real 2.9 GiB index:

```
130 passing (14m 42.8s)
Spec Files:	 1 passed, 1 total (100% completed) in 00:14:44
```

The compaction scenario's own evidence, from the task row afterwards — 178 entries where there were
266, the first of them the summary:

```
agent messages: 178 roles[0:3]: ['compactionSummary', 'assistant', 'toolResult']
summary tokensBefore: 59082 chars: 5057
## Goal
- Build a side-scrolling platformer in Godot 4 using `CharacterBody2D` for the player and
  `TileMapLayer` for terrain.
```

Full `npm run check`:

```
 Test Files  29 passed (29)
      Tests  424 passed (424)
test result: ok. 302 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.06s
Gofer Godot protocol fixtures passed
30/30 Godot acceptance tests passed in 37.6s across 6 processes
[chrome 150.0.7871.128 linux #0-0] 1 passing (649ms)
Spec Files:	 1 passed, 1 total (100% completed) in 00:00:02
EXIT=0
```
