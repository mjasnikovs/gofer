# Fix plan: the chat loses the model's memory, and Retry deletes work

Debugged on **2026-08-08** against `f27e918` on `master`.

Nothing here is inferred. Every claim marked **PROVEN** was produced by running code in this repo.
The probe that produced them is kept at the path in [Reproduce](#reproduce). Two items are marked
**UNVERIFIED** and say what would settle them.

---

## What is actually wrong

There are two records of one conversation and they do not agree.

| Record          | Lives in                        | Written when               |
| --------------- | ------------------------------- | -------------------------- |
| `messages`      | React state, mirrored to SQLite | every token                |
| `agentMessages` | React state, mirrored to SQLite | **only on a `done` event** |

`agentMessages` is the model's memory. `messages` is the screen. A turn that does not reach `done`
updates the screen and not the memory. Nothing reconciles them afterwards.

Three ordinary things stop a turn reaching `done`:

- the worker crashes or the model errors — `send_ai_message` rejects, no `done`
- the user presses Stop — `cancel_ai_request` **kills the worker process**
  (`src-tauri/src/lib.rs:1222`) and sends `{"type":"aborted"}`, which carries no transcript
- the worker exits without completing — `lib.rs` returns
  `"Pi AI worker exited without completing the response"`

The single line that only updates on success:

```
src/components/workspace/Workspace.tsx:202
if (event.type === 'done') setAgentMessages(event.agentMessages)
```

### Why the AI restarts from nothing

`scripts/ai-provider.mjs:239`:

```js
const previousMessages =
    Array.isArray(agentMessages) ? agentMessages : (
        messages.slice(0, -1).map(message => contextMessage(message, model))
    )
```

The renderer always sends an array — `agentMessages` is initialised to `[]`. `Array.isArray([])` is
`true`, so the fallback branch is unreachable from the app. If the **first** turn of a task fails,
`agentMessages` stays `[]` forever, and every later turn is sent to the model with **no history at
all** while the window shows the whole conversation.

**PROVEN.** Turn 1 crashed, turn 2 was sent with:

```json
{"agentMessages": [], "messages": ["first prompt", "partial work", "second prompt"]}
```

The model received only `second prompt`.

### Why Retry deletes work

`Workspace.tsx:364` replays from a ref and truncates:

```js
runRequest(userMessage.text, history.slice(0, assistantIndex - 1), userMessage.attachments)
```

Everything after the retried message is dropped from `messages`. 150 ms later the debounced save
runs, and `save_chat` is a **full replace** — `src-tauri/src/storage.rs:571`:

```sql
DELETE FROM messages WHERE task_id = ?1
```

then re-inserts whatever the renderer sent. There is no undo and no confirmation. Retry is offered
on **every** errored or aborted assistant message, not only the last one, so retrying an old failure
destroys every turn after it.

**PROVEN.** Conversation before Retry, then after clicking Retry on the first assistant message:

```
before: ["first prompt","partial work","second prompt","partial work"]
after:  ["first prompt","partial work"]
```

The last two turns were deleted from the database.

### Why one bad event blanks the window

There is **no error boundary anywhere in the application** —
`grep -rn "ErrorBoundary\|componentDidCatch\|getDerivedStateFromError" src` returns nothing.

`applyStreamEvent` is documented as "pure and total" but the payload it folds in is never validated:
`Workspace.tsx:200` casts `payload.event` straight from IPC. One stream event with a wrong field
name produced `<Markdown>{undefined}</Markdown>`, which threw, which unmounted the entire tree.

**PROVEN.** With a `text-delta` carrying `text` instead of `delta`, `document.body` went to
`<div />` — an empty window, no message, no recovery.

### Why "Start Session" means nothing

The word _session_ names four different things in the UI, and the same button has three labels:

| Label                  | File                         | Means                       |
| ---------------------- | ---------------------------- | --------------------------- |
| `Start session`        | `InspectorWorkspace.tsx:577` | launch the Godot editor     |
| `Start editor session` | `ExplorerPanel.tsx:340`      | the same action             |
| `Start editor session` | `InspectorPanel.tsx:170`     | the same action             |
| `New task`             | `router.tsx:113`             | new chat + new git worktree |
| "AI session"           | user-facing conversation     | one turn, or the whole chat |

Nothing on screen says a Godot editor session and an AI conversation are unrelated. They are.

---

## Tasks

Ordered. Each one lands on its own and is provable before the next starts. Do not batch them.

### 1 — Stop Retry from destroying history — **DONE**

**Was:** `Workspace.tsx` truncated `messages` and minted new ids for the replayed pair. The
debounced `save_chat` then deleted the rows. **Is now:** `retryPlan` in
`src/models/chat-timeline.ts` rewrites the failed reply in place, under its own id. Nothing is
removed. Retry is offered only on the last turn, because this conversation has no branches. The
composer keeps a half-written message through a retry, which it did not before.

`runRequest` was split: `runTurn` runs a conversation that is already decided, `startTurn` appends a
new pair and clears the composer. Retry no longer goes near the composer.

**Proven by:** 6 cases in `src/models/chat-timeline.test.ts`, 4 in
`src/components/workspace/Workspace.test.tsx` — the first test of the real `Workspace` in this repo,
driven through the desktop fake rather than a mocked IPC module.

**Mutation-checked.** Giving the rewritten reply a new id fails 3 tests. Dropping the `isLast` gate
on the Retry button fails 1. `npm run check` passes: 324 vitest tests, 294 Rust, 25 Godot.

### 2 — Make `save_chat` non-destructive — **DONE**

**Was:** `save_chat` deleted every row for the task and re-inserted the renderer's array, so any
short array silently deleted the difference. **Is now:** it counts the stored rows first and refuses
a write that holds fewer, naming what the write was about to cost. Rewriting a reply in place still
works, which is what task 1 needs.

The renderer half was worse than the plan knew: a failed `load_chat` left an empty conversation on
screen and then armed the debounced save over the full chat still on disk. Saving now stays off for
a mount whose read failed.

`truncate_chat_from` was **deliberately not added.** Nothing shortens a chat any more, and shipping
an unused destructive command is the hazard this task removed.

**Proven by:** 2 Rust tests in `storage.rs`, 1 in `Workspace.test.tsx`. **Mutation-checked** —
disabling the guard fails the shrink test; arming the save after a failed read fails the other.

### 3 — Persist the agent transcript on every ending — **DONE**

**Was:** the transcript was stored only on `done`, so a crash, a Stop, or a worker exit froze the
model's memory at the last success. **Is now:** the worker emits `turn-state` after every step and
once more on the way out of a failing turn, and the renderer stores each one.

The plan missed a consequence: a checkpointed transcript holds the failed turn's own prompt, so a
retry would ask the same question twice — once in the history, once as the question. Turns now carry
`isRetry`, and the worker rolls the transcript back past the last prompt when it is set.

The Stop path still loses the step that was in flight, because the worker is killed rather than
asked. Everything before it is kept. Closing that needs process signalling, and it is written up in
`chatstate.md` rather than half-built.

**Proven by:** 3 tests in `scripts/ai-worker.test.mjs`, 2 in `Workspace.test.tsx`.
**Mutation-checked** — removing the rollback fails the retry test; dropping the renderer's handler
fails the crash test.

### 4 — Rebuild model context when the transcript is empty — **DONE**

**Was:** the gate was `Array.isArray(agentMessages)`, and the renderer always sends an array, so the
rebuild was unreachable from the application — it only ever ran in a test that omitted the field.
**Is now:** the gate is emptiness. A task whose transcript is empty and whose conversation is not
has its context rebuilt from the screen, and the turn's caption says so.

**Proven by:** 2 tests in `scripts/ai-worker.test.mjs`. The pre-existing test that claimed to cover
this passed throughout and proved nothing about the application — it is now genuinely reachable.

### 5 — Validate stream events and add error boundaries — **DONE**

**Was:** IPC payloads were folded straight into React state, and no error boundary existed anywhere.
**Is now:** `isAiStreamEvent` in `chat-timeline.ts` drops anything the timeline does not recognise,
and `ErrorBoundary` stands around the conversation column and the app root with a way back.

**Proven by:** 2 tests in `Workspace.test.tsx`. **Mutation-checked** — removing the guard fails the
malformed-event test.

### 6 — Give the two sessions one name each — **DONE**

**Was:** one Godot action under three labels, and _session_ also meaning a task, a chat, and a log
scope. **Is now:** the Godot process is the **Editor** (`Start editor` / `Stop editor`,
`No editor running`), the chat plus worktree is the **Task**, one exchange is a **Turn**. The word
_session_ is gone from every user-facing string; it survives only in code identifiers, where it
names the Godot process and is not ambiguous.

The e2e specs that asserted the old labels were updated with it.

### 7 — Close the 150 ms hole on task switch — **DONE**

**Was:** switching tasks remounted the workspace and dropped whatever the debounce still held — a
message just sent, most of all. **Is now:** the unmount flushes the pending snapshot, and the write
names the task being left, so it lands on that task rather than the one being opened.

Not done the way the plan said. A route-loader flush needed a module-level handle on a React hook;
the unmount already runs before the new mount reads, and the two writes name different tasks, so no
global was needed.

**Proven by:** 2 tests in `Workspace.test.tsx`, driven by the manual clock so nothing but the flush
can produce a write. **Mutation-checked.**

### 8 — Write down the state model — **DONE**

`chatstate.md` names both records, the eight rules, and all six turn endings with the transcript
outcome for each.

### 9 — Settle turns the window stopped in the middle of — **DONE**

Not in the original plan. Found while settling the unverified items below, in the user's own data.

**Was:** a reply stored as `streaming` came back as a turn that was still working — the indicator
never stopped, and Retry was never offered, because Retry belongs to a turn that ended badly and
this one never ended at all. **Is now:** `settleStoredChat` settles them to `aborted` as the chat is
read, so the turn can be picked up.

**Proven by:** 2 tests in `chat-timeline.test.ts`, 1 in `Workspace.test.tsx` built from the exact
row found on disk. **Mutation-checked.**

---

## The two unverified findings, settled

### Can a usage report crash the conversation?

**Not from Pi.** `node_modules/@earendil-works/pi-ai/dist/types.d.ts:260` declares `input`,
`output`, `cacheRead`, `cacheWrite`, `totalTokens` and `cost` as required; only `reasoning` and
`cacheWrite1h` are optional. `ChatConversation.tsx` reads `input`, `output` and the optional
`reasoning`, so the unguarded read matched the type.

It crosses a process boundary as JSON, though, so the type was a promise rather than a guarantee.
`isAiStreamEvent` now requires `input`, `output` and `totalTokens` to be finite numbers and drops
the event otherwise, so the read is safe whatever the worker sends.

### Is real data already corrupted?

**Yes. Two tasks, on this machine.**

```
$ sqlite3 <project.sqlite> "SELECT t.title,
    (SELECT COUNT(*) FROM messages m WHERE m.task_id=t.id) AS msgs,
    json_array_length(t.agent_messages_json) AS transcript FROM tasks t;"

New task                      | 20 | 0
Create Mario level 1-1 clone. |  2 | 0
hi                            |  6 | 4
```

- **"New task"** — twenty messages, ten completed turns, and a transcript of **zero**. Every one of
  those turns was answered by a model that had been given no history at all. Its last reply is
  stored as `streaming`.
- **"Create Mario level 1-1 clone."** — the reported case. One prompt, one reply frozen at
  `streaming`, transcript zero. There was no Retry button on it, because the turn never ended.
- **"hi"** — six messages against a four-entry transcript. Consistent with one lost turn, but a
  transcript is not one entry per bubble, so this one is **not conclusive**.

Both zero-transcript tasks are exactly the defect in
[Why the AI restarts from nothing](#why-the-ai-restarts-from-nothing). Task 4 makes them usable
again: their context is rebuilt from the messages on screen the next time they are opened. Task 9
puts a Retry button back on the two frozen replies. Neither task needs a migration — nothing on disk
has to change.

---

## Still open

- **Stop loses the step that was in flight**, because the worker is killed rather than asked. See
  `chatstate.md`.
- **`streamError` is one channel with four writers.** The chat load, the connection, the approvals
  and the turn all write it, and the later one wipes the earlier. A failed chat read is wiped by the
  connection attempt that follows it, which is why the test for that case asserts the absent write
  rather than a visible message.

---

## Reproduce

The throwaway probe that produced the original **PROVEN** claims has been replaced by committed
tests. Everything above is re-checkable with:

```
npm run check
```

334 vitest tests, 296 Rust, 30 worker, 25 Godot acceptance. The chat behaviour specifically:

```
npx vitest run src/models/chat-timeline.test.ts src/components/workspace/Workspace.test.tsx
node --test scripts/ai-worker.test.mjs
cd src-tauri && cargo test --quiet chat
```

To re-run the database check in [Is real data already corrupted?](#is-real-data-already-corrupted):

```
sqlite3 ~/.local/share/com.gofer.desktop/projects/*/project.sqlite \
  "SELECT t.title,
     (SELECT COUNT(*) FROM messages m WHERE m.task_id=t.id),
     json_array_length(t.agent_messages_json) FROM tasks t;"
```
