# Chat state: who owns what

Every defect in `FIXPLAN.md` came from the same gap — a conversation kept in two places, with no
document saying which one is true. This is that document.

Read it before changing anything under `src/hooks/useChatPersistence.ts`,
`src/models/chat-timeline.ts`, `src/components/workspace/Workspace.tsx`, `scripts/ai-provider.mjs`,
or `save_chat` in `src-tauri/src/storage.rs`.

---

## The two records

| Record          | What it is                     | Lives in                                  | Written by                                                    |
| --------------- | ------------------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| `messages`      | the conversation on screen     | React state → `messages` table            | every stream event, through `applyStreamEvent`                |
| `agentMessages` | the model's memory of the task | React state → `tasks.agent_messages_json` | the worker's `turn-state` and `done` events, and nothing else |

They are not two views of one thing. `messages` is a rendering: bubbles, tool rows, statuses.
`agentMessages` is Pi's own `agent.state.messages` — the transcript that is replayed to the model,
including tool calls and their results, which `messages` cannot express.

**The transcript wins.** Every turn is answered against `agentMessages`. `messages` is sent along
too, but only as the fallback described below.

---

## The rules

1. **A save is the whole conversation.** `save_chat` replaces the task's rows. A caller holding
   fewer messages than are stored is a caller that lost some, so the backend refuses the write
   rather than performing the deletion. Nothing in the renderer may shorten `messages`.
2. **A reply is rewritten, never replaced.** A retry keeps the reply's `id` and writes over its row.
   That is what makes rule 1 possible.
3. **Only the last turn can be retried.** Re-running an earlier one is a branch, and a branch makes
   the screen and the transcript two different conversations.
4. **The transcript is reported at every step.** The worker emits `turn-state` after each
   `turn_end`, so a turn that dies part-way still leaves what it had done.
5. **A retry rolls the transcript back.** Rule 4 means a failed turn's own prompt is in the
   transcript. Re-prompting on top of it asks the question twice, so `isRetry` tells the worker to
   drop everything from the last `user` message onward.
6. **An empty transcript is rebuilt from the screen.** A task whose transcript is empty and whose
   conversation is not gets its context rebuilt from `messages`, and the turn says so.
7. **A failed read disables writing.** If `load_chat` throws, saving stays off for that mount. The
   conversation is on disk and unread, not lost.
8. **Nothing is trusted across the IPC boundary.** `isAiStreamEvent` guards every event before it
   reaches `applyStreamEvent`, and error boundaries stand around the conversation and the app root.

---

## The six ways a turn ends

The column that matters is the last one. Before this work, only the first row wrote anything.

| Ending                        | What the backend does                                   | Transcript outcome                           |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Clean finish                  | `done` with the full transcript                         | stored whole                                 |
| Model or tool error mid-turn  | worker throws; `runAgent` emits a final `turn-state`    | stored up to and including the failing step  |
| User presses Stop             | `cancel_ai_request` kills the worker, sends `aborted`   | stored up to the last completed step         |
| Worker exits without `done`   | Rust returns `Pi AI worker exited without…`             | stored up to the last completed step         |
| IPC rejects the turn outright | `send_ai_message` errors, e.g. `ai_request_in_progress` | unchanged — the turn never reached the model |
| The window closes mid-turn    | nothing; there is no code left to run                   | stored up to the last checkpoint that landed |

The last row is why `settleStoredChat` exists. A reply saved as `streaming` is read back as a turn
that is still working: the indicator never stops, and Retry is not offered, because Retry belongs to
a turn that ended badly and this one never ended at all. Both chats found on a real machine were in
that state. Reading a chat settles them to `aborted`.

---

## What is still true and still uncomfortable

- **The step that was in flight when the user pressed Stop is lost.** The worker is killed rather
  than asked to stop, so the current step never reports. Everything before it is kept. Closing this
  needs a signal the worker can answer, which is process plumbing, not a chat change.
- **A rebuilt context is thinner than a transcript.** Rule 6 recovers the conversation, not the tool
  calls — the model sees what it wrote about its work, not the work. This is announced in the turn's
  caption rather than hidden.
- **`streamError` is one channel with four writers.** The chat load, the connection, the tool
  approvals and the turn all write it, and a later one silently clears an earlier one's message. A
  failed chat read is currently wiped by the connection attempt that follows it. Not yet fixed.
