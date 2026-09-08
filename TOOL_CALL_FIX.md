# Deleting an empty tool call from the conversation

## The defect

A model call arrives as `{"ops":[{"op":"set_property"}]}` — the operation named, every parameter
missing. Gofer refuses it by name. The model sends the same thing again.

Nothing in Gofer drops the parameters. The raw call is recorded in `tasks.agent_messages_json` and
it is already empty there. (`normalizeEntry` moves `op` to last, so key order in that column is not
the model's own.)

The cause is the conversation. The failed call and its error stay in the history for the rest of the
task. The model reads its own mistake on every later turn and copies it. It is self-reinforcing: the
more it fails, the more certain the next failure is.

## The evidence

Replaying the swarm task `01a0803b-a262` against the local server, ten runs each, same question and
same model:

| history                                      | tokens | bad  |
| -------------------------------------------- | ------ | ---- |
| as recorded                                  | 74k    | 7/10 |
| healthy tool pairs removed, empty calls kept | 15k    | 5/10 |
| empty-call pairs removed                     | 68k    | 0/10 |

The middle row is the control. Cutting the context to a fifth barely helped, so context size is not
the driver. Cutting the 42 empty calls out of it fixed it outright.

Two things that are **not** the cause, both measured:

- The draft model. `draft-mtp` and `draft-dflash` score the same. Turning speculation off per
  request moved 8/10 to 6/10, inside the noise of this sample.
- Streaming or parsing. The raw SSE deltas concatenate to exactly what is stored.

`draft-mtp` does abort the server — `CUDA error: the launch timed out and was terminated` inside
`common_speculative_impl_draft_mtp::process` — but that is a separate bug and it kills the request
rather than corrupting it.

## The change

**Is now.** A failed tool call stays in the conversation. Its arguments and the error sit there for
the rest of the task.

**Will be.** The pair is deleted as soon as the turn ends. The model sees a conversation where it
never happened.

1. New function in `scripts/ai-transcript.mjs`, beside `withoutTrailingAnswer`. It takes the message
   list and returns it without the empty calls.

2. The rule for dropping a pair. Every `toolCall` in the assistant message carries only `op` and
   nothing else. Every matching tool result is an error. Both hold, or nothing is dropped.

3. Never drop a call without its result. The API rejects an orphan. Drop the assistant message and
   all of its results together.

4. Leave mixed messages alone. If one call was empty and another was fine, keep both.

5. Call it in `scripts/ai-provider.mjs`, in the `turn_end` branch, just before
   `transcript.checkpoint()`. The checkpoint is what gets saved, so the stored history is clean too.

## Proving it

- Unit tests in `scripts/ai-transcript.test.mjs`. One per rule above, including the two that must
  not drop.
- Rerun the replay harness against the recorded task. Expect 7/10 to become 0/10.
- `npm run check` before commit.

## Not doing

- Not touching the refusal wording. The refusal is not the poison.
- Not touching the llama.cpp flags. The draft model made no difference.
- Not repairing the call. There is nothing in it to repair.

## Rebuilding the harness

It lives in a session scratchpad, not the repo. Read `agent_messages_json` for the task, convert it
to OpenAI chat messages (`assistant` with `tool_calls`, `tool` with `tool_call_id`), and post to
`localhost:8080/v1/chat/completions` with `stream: true`. Cut the list at index 158 for the poisoned
context and 154 for the clean one.

## Gray areas

**Sub-agents are a second loop.** `scripts/ai-subagent.mjs` runs its own agent and never builds a
transcript object — it only listens to `turn_end`. The fix above touches the main loop only, so a
sub-agent keeps poisoning itself. It needs the same prune, applied to its own
`agent.state.messages`. This was missing from the plan.

**The progress guard does not read the transcript.** `scripts/progress-guard.mjs` counts in memory:
8 identical calls, or 3 refusals, ends the turn. Pruning does not reset it, so a model that keeps
sending empty calls is still stopped. Leave it that way. It is the only backstop against a silent
retry loop once the evidence is gone.

**An aborted turn may never reach the prune.** The hook is `turn_end`. If the user stops the turn,
or the provider errors out, the last empty pair can survive into the saved state and greet the next
turn. Either prune on the resume path as well, or accept it.

**Only `ops`-shaped tools are covered.** `read`, `bash` and `subagent` can arrive empty the same way
and the rule will not see them. Not measured, so not fixed here.

**The message goes whole, text and thinking with it.** That is intended, but a sentence of real
reasoning is deleted alongside the broken call.

**Prompt cache.** Deleting mid-history re-prefills everything after the cut. Cheap when the empty
calls sit at the tail, which is the usual shape. Expensive if one happened early.

**What the user sees does not change.** The UI transcript is built from emitted events, not from the
model's message list. Pruning hides the failures from the model, not from you.

**The measurement is narrow.** One task, one model, one cut point, ten runs. 0/10 is a strong signal
but it is not a sweep.
