# Next task

Rewritten 2026-08-07 after working through every item the previous list left open. `npm run check`
is green apart from `format:check`, which fails on the untracked `nodelist.md` — that file is not
part of this work and was left alone. 285 Rust tests, 153 frontend, 19/19 Godot acceptance.

Nothing on the previous list is still open. What is below is what was decided, what is now covered,
and where the remaining work actually lives.

---

## Closed since the last writing

**3 — A conversation that outgrows the context window dies quietly — DECIDED.** Gofer does not
compact, and that is the answer rather than an unbuilt feature. Every turn resends the whole
conversation, `scripts/ai-provider.mjs:255` raises `finish_reason: length` as an error naming both
numbers instead of recording a one-token answer, and the composer carries a running meter of how
close the conversation is: `ContextUsage` in `WorkspaceComposer.tsx`, green to 80% of the window,
amber to 90%, red past it. The previous list called that meter unbuilt; it was already there.

What was missing was any cover for it, so `src/utils/chat-format.test.ts` now pins the three things
that make it a warning rather than decoration: the readout is the last turn's total, not the
session's; the bar leaves green well before the wall the live sweep hit at 116,449 of 120,064; and a
window nothing reported does not read as a full one.

One thing undercuts this, and it is written up as item 2 of `projectfix.md`: with the bottom panel
open, that readout is sliced in half by the panel's tab strip in three committed baselines. A
decision not to compact rests on the bar being readable.

**4 — `session.cancel` retracting a long-parked request — COVERED.**
`godot_addon_acceptance::the_addon_gives_up_a_request_it_is_still_holding` parks a real request in a
real editor and retracts it. The park that was missing turned out to be a launch, not a scene
switch: `project.set_setting` points `application/run/main_scene` at a scene that is not there,
`runtime.run` hands that to `EditorInterface.play_main_scene()`, no game ever announces itself, and
the request sits in `_runtime_pending` for the full thirty-second budget. The cancellation is
retried until it takes — nothing announces that the addon is holding a request — and then the test
asserts the caller is answered with `cancelled` rather than left to time out, and that the session
is usable straight afterwards. Ran three times in a row at 3.4s.

**5 — `require_session_task` has no unit test — COVERED.** The seam is
`godot_session::bind_test_session_info`, which mirrors `bind_test_rpc`: a slot `current_info()`
reads first, absent from every non-test build.
`godot_session_api::a_call_is_refused_only_when_the_session_belongs_to_another_task` walks all four
branches — no session, the session's own task, another task, and back — against real project
storage, so the refusal the live sweep was the only witness to is now reachable in 20ms.

**6 — A non-script file could not be deleted with a hash — FIXED.** `godot_resource list` takes
`{hashes?}` and answers with a content hash per file when asked, which is the token `delete` checks
`expectedHash` against. It is asked for rather than always done: a worktree holds game assets, and
hashing every texture to answer "what files are there" would read the whole project on a call the
agent makes to orient itself. `Workspace::hash_of` is the one place the hash comes from, so it
cannot drift from the check. The catalog now names both sources — a `godot_script` open or save, or
`list` with `hashes: true` — and
`ai_tools::listing_reports_hashes_that_a_delete_of_a_non_script_file_can_be_held_to` proves a stale
hash refuses the delete of a `.tscn` and the current one lets it through.

**7 — Three tool domains never went through the AI router in a test — TWO COVERED, ONE DECIDED.**
The scripted turn in `godot_ai_acceptance.rs` is six calls longer: `godot_resource` rescan, list
with hashes, create_tileset and describe_tileset, and `godot_project` get_settings and
search_editor_settings. The two that were worth the most are the ones that are not pass-throughs —
`project_command` rewrites the three editor-settings operations into the addon's `editor.` domain,
and `godot_resource`'s list, move and delete are answered by the desktop out of the workspace rather
than by the addon at all. Both were previously checked by a test that reads strings.

`godot_docs_search` is deliberately absent, and the module header says so: it retrieves through the
gofer-rag sidecar against downloaded embedding models, and a suite that has to fetch a model before
it can start is not one anybody runs.

**8 — `projectfix.md` was stale — RE-AUDITED.** Twenty-six of its twenty-eight items are fixed and
are gone from the file. What is left is rewritten with current numbers, plus two defects the audit
found in baselines that did not exist when the old list was written. See `projectfix.md`.

---

## Where the work is now

`projectfix.md`, which carries three items: fifteen commands still rejecting with a bare `String`,
the composer's context readout clipped by the bottom panel, and the Output tab's two segmented
controls printing on top of each other. The last two are UI defects measured in committed
screenshots, and both need their baselines re-recorded after the fix.

---

## What is deliberately not on this list

- **A script the agent wrote wrong and then fixed.** The assertion searched the whole session log
  and found an error the agent had already repaired. It reads from a cursor taken at launch now.
- **The `"op": "set_property>"` tool call.** Twice in about a hundred calls the local model emitted
  a stray character in an operation name. Validation refused it, named the problem, and the agent
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
Gofer; one that happens once is the model.** That rule found every item this list closed.

A single Godot acceptance test, without the whole suite:

```
cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance <name> -- --test-threads=1
```
