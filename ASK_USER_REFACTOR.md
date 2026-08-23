# One ask_user, in the feed

## Context

Gofer has two tools that stop and talk to the user.

`ask_user` asks one question. It can carry up to three HTML sketches. The answer closes it.

`design_with_user` is a sub-agent. It drafts a layout, calls `ask_user`, reads the reaction,
revises, and repeats. It exists so the drafts stay in the child and the parent's context does not
fill with HTML.

Two problems.

**The split is arbitrary.** A user may want to refine any answer, not only a layout. The line
between "one question" and "a design" is drawn by the model, and it draws it wrong. A hidden third
tool, `design_session`, exists only to tell the window which side of the line a question is on.

**The dialog is a modal.** It closes on every answer and reopens once the agent has redrawn, so a
user watching a design iterate watches their own modal flicker. `design_session` exists to paper
over that.

The outcome: one tool, one card in the feed that survives a revision.

## Stories

The seven this has to serve. The first four are the common ones.

1. Model asks a question. User picks an option and it sends.
2. Model asks a question. User writes a suggestion. Model asks again about the same thing.
3. Model shows several sketches. User picks one and it sends.
4. Model shows several sketches. User iterates until it is right, then ends it.
5. User reads the question and **skips**. That is a decision, and the model is told so and told not
   to ask again.
6. User writes something that is not one of the options. Common, and already works.
7. The turn is **stopped** mid-question. The card settles. Nothing hangs.

The pencil is not on this list. See **Later**.

## What changes

**Was:** two model tools plus a hidden third. **Is now:** one tool, `ask_user`. A `brief` on the
call means it delegates to a child that draws and iterates. No `brief` and it asks directly, as
today. The parent never writes HTML at all.

**Was:** a modal `Dialog` beside the frame. **Is now:** a `Card` in the conversation feed. Child
steps while it works, then the question, with its own text field. Collapses to a summary line when
answered.

**Was:** `maxShows`, `budget`, `BUDGET_SPENT`, the settings slider. **Is now:** gone. If the model
needs to ask, it asks. `maxTurns` still caps the child's steps.

**Was:** `design_session`, `ai-design-opened`, `ai-design-closed`, `useDesignSession`. **Is now:**
gone. The tool call's own lifetime is the session.

## Verified reuse

Checked in the tree, not assumed.

`SketchFrame` is used unchanged. `Collapsible` is the answered-state primitive. `BriefProgress` is
the shape to copy for the working state.

`ToolActivity.step` already carries a child's live sub-step. `toolProgress` writes it into
`details.step`, `ai-provider.mjs:885` lifts it onto the event, `chat-timeline.ts:396` puts it on the
row and drops it when the call ends. Nothing to build.

The question registry is a keyed `HashMap` (`ask.rs:67`), and `useSettledQueue` is already a queue.
Two live questions work today.

We do **not** need to serialise the iframe. We already hold the sketch HTML string in JS.

## The one new link: `ownerCallId`

The feed block must find its question. Nothing connects a tool call to a `questionId` today. The
call id lives in the worker, the question id is minted in Rust.

The `ask_user` tool puts its own call id into the request params, the way it puts `designSession`
there today: set by us, never by the model. Rust echoes it into `QuestionPrompt`. The block matches
on it.

Verified: the timeline's `tool.id` is `event.toolCallId` (`ai-provider.mjs:871`), which is the same
id `execute` receives as its first argument. The link holds.

The child's asks carry the **parent's** call id, injected the same way. That is what makes several
rounds render as one block. It replaces `designSession` outright.

`QuestionPrompt` also gains `is_delegated`, so the block knows to draw the button that ends a
delegation.

## Decisions

- Two questions can be live at once. Each card has its own text field, so nothing has to choose
  between them.
- Clicking an option **sends immediately**. It is a whole answer.
- Every question inside a delegation carries **Done, build it**, the approve button.
- **No ration.** Nothing counts the asks. **Done, build it aborts the child's loop** — that is what
  makes it mean anything now that nothing else stops the model. `maxTurns` is the only other
  ceiling, and it counts the child's steps, not interruptions.
- **`sketches` is not in the parent's schema.** The parent sends `brief` and nothing else. The
  child's copy of the tool is the only one that can show markup, so there is no line for the model
  to draw and no both-sent case to refuse. `PARAMETERS` becomes a function of `{delegate}`.
- A delegation ends three ways, and the parent is told which:
    - **Done pressed.** The layout in words **plus the agreed HTML**. The user signed off, so the
      markup is worth carrying. The child gets one turn to write it, then the loop is closed for it.
    - **Model finished on its own.** The words, plus a line saying the user never confirmed it. No
      HTML. The parent can build or check.
    - **Steps ran out, or nothing was ever shown.** `notAgreed`, as today. `agreed.rounds` is what
      catches a child that answered without putting anything in front of anybody.
- The child may ask plain questions too. `sketchesRequired` goes.
- After a reload an answered block is a **summary line only**, from the stored tool output. The
  agreed sketch is already in project storage; the line links to the Design tab.

## Work

### 1. Worker

`scripts/ai-ask.mjs`

- `createAskUserTool({host, ownerCallId, delegate})`. Drop `budget`, `sketchesRequired`,
  `sessionId`, `BUDGET_SPENT`.
- Remove `designSession`. `PARAMETERS` becomes a function of `{delegate}`. With a delegate — the
  parent's copy — it carries `brief` and **not** `sketches`. Without one — the child's copy — it
  carries `sketches` and not `brief`. One factory, two schemas, no overlap.
- `brief` is one paragraph saying what the layout is for. Present, and the call goes to `delegate`
  instead of `host.call`.
- `delegate` is a closure built in `ai-provider.mjs`, and it carries `images: askedAbout(messages)`
  exactly as `createDesignWithUserTool` does today (`ai-provider.mjs:683`). That is the last user
  message's pictures, and it is not optional: a design is asked for in the same breath as the
  screenshot it is about, and the first build handed the child a sentence naming a screenshot it
  could not see. `blindTo` stays too, for a child with no eyes.
- A delegated call answers by which of the three endings it hit: agreed gets words plus HTML, a
  self-end gets words plus the unconfirmed line, and anything else gets `notAgreed`.
- Pressing **Done, build it** ends the child. **Not through the abort signal** —
  `ai-subagent.mjs:638-645` records why that does not work: the agent loop never asks whether it has
  been aborted, and the path that does fire throws `SubagentStopped` at line 728, which discards the
  child's answer. Aborting a design would report a stopped turn instead of the agreed layout.
- Use the shape the step ceiling already uses. The answer comes back with `approved: true` inside
  the tool's `execute`, which sets a flag on the same shared object `agreed` already rides on.
  `streamFn` reads it: allow **one** more request, so the model writes its answer from `APPROVED`,
  then return `endedStream` on the next. The loop stops cleanly and by itself, with an answer. That
  costs one model turn and is the only ending in this file that produces one.
- Rewrite `DESCRIPTION`, folding in the layout half of `design_with_user`'s prose.

`scripts/ai-design.mjs` becomes the delegating half of `ai-ask.mjs`, or `scripts/ai-ask-loop.mjs` if
that file gets long.

- Delete the tool, its `PARAMETERS`, `DESCRIPTION`, `tellWindow`, session minting.
- Keep `DESIGN_SYSTEM_PROMPT`, `agreedSketch`, `notAgreed`, `blindTo`. Amend the system prompt: it
  may ask in words, and the ending is the button, full stop.
- Fix while there: a `show_user` tool that does not exist is named at lines 4, 41, 54 and 64. Line
  64 is inside `DESCRIPTION`, so this is not a stale comment. The model is being told about a tool
  it cannot call. `MAX_SKETCH_CHARS` is pointed at `ai_tools.rs` when it is in `ask.rs:849`.
- Keep the probe. `DESIGN_PROBE_ANSWER` proves a child builds, holds the window and runs a turn,
  before the turn starts. Folded into `ask_user` unchanged, the probe would only prove the window
  answers, and a broken child would fail mid-turn instead. Probe the delegate too.

`scripts/ai-subagent.mjs`, `REACHING_CHILD_TOOLS.ask_user` takes `ownerCallId`, not `asks`. Delete
`maxShows` from the bounds.

`scripts/ai-provider.mjs:672-685`, build one tool.

### 2. Rust

`src-tauri/src/ask.rs`

- `design_session` becomes `owner_call_id`, keeping `skip_serializing_if`. The `null !== undefined`
  bug is recorded at lines 195-199 and must not come back.
- Add `is_delegated: bool`.
- Delete `design_session`, `DesignSession`, `announce_design_session`, both design events,
  `DESIGN_SESSION_TOOL`.
- Everything else stays. The registry, the gate, the 30-minute timeout, `res://` inlining,
  `chosen_sketch` and `keep_sketch` are all still right.

`src-tauri/src/ai_tools.rs:301-303`, drop the `DESIGN_SESSION_TOOL` branch.

`src-tauri/src/settings.rs`, delete `max_shows` and its default (285, 789, 813, 2038, 4541).

### 3. The feed block

New `src/components/workspace/AskBlock.tsx`. `ChatConversation.tsx` renders it in place of
`ToolCallRow` when `tool.name === 'ask_user'`. The rest of the timeline is untouched.

`Card elevation='low'` while pending. It needs to read as distinct from the feed. Flat and
`Collapsible` once answered. Exactly one `variant='primary'` per state: **Done, build it** when
delegated, **Send** otherwise.

Three states:

- **Working**. Indented child steps. Copy `BriefProgress.tsx`, which already does this.
- **Asking**. Question, `why`, options as buttons, sketches in a `Grid` of `SketchFrame`, a text
  field, **Send**, **Let the agent decide**, and **Done, build it** when delegated. Lift the body
  out of `UserQuestionDialog.tsx`.
- **Answered**. One line, click to expand.

Delete `src/hooks/useDesignSession.ts` and `UserQuestionDialog.tsx`. `useUserQuestions` and
`useSettledQueue` stay; the block subscribes by `ownerCallId`.

Drop the `UserQuestionDialog` mount (`Workspace.tsx:653-657`) and the design hook (lines 181-186).

### 4. Prose and tests

- `scripts/ai-ask.test.mjs`: `ownerCallId`, the delegate branch, `brief` and `sketches` together
  being refused.
- Delete `scripts/ai-design.test.mjs`; move `notAgreed` and `agreedSketch` across.
- `ask.rs`: delete the `design_session` routing tests; add one asserting an ordinary question sends
  no `ownerCallId` field at all.
- New `AskBlock.test.tsx`, covering all seven stories.
- `maxShows` goes from nine files, not two: `settings.rs`, `src/models/settings.ts` (125, 339, 362),
  `SettingsPage.tsx` (1087-1098), `ai-subagent.mjs` (114, 131), `ai-design.mjs:264`,
  `SettingsPage.test.tsx` and `ai-subagent.test.mjs:1046`.
- `e2e/live/design.spec.ts` and `e2e/live/sketch.spec.ts` retargeted at `ask_user`.
- `e2e/visual/application.visual.spec.ts`, `window.__GOFER_TEST_DESIGN__` goes, and
  `e2e/globals.d.ts:84` with it.
- No prose to fix. `design_with_user` appears in no doc and not in `CONTEXT.md`.

## Verify

1. `npm run check`. Note that `check:design` is the theme ratchet over `gofer-theme.css`. It says
   nothing about any of this.
2. `npm run tauri dev`, then walk the seven stories.
3. Story 4 in full: ask _"which of two HUD layouts should I use?"_. The block appears in the feed,
   iterates in place across revisions, and ends on **Done, build it**.
4. Story 7: stop mid-question. The block settles, it does not hang.
5. Restart with an answered design in the feed. Summary line, link to the Design tab.
6. The live sweep, `wdio.live.conf.ts` and `e2e/live`, against the retargeted specs.

## Known cost

None on the way in. The parent sends a paragraph and never markup, so a design ask is cheaper than
`design_with_user` is today.

On the way out, an agreed design puts one sketch — up to 8000 chars — into the parent's transcript,
where it stays across reloads. That is the price of the parent being able to build from exact
numbers instead of a description. An abandoned one costs nothing.

Story 3 — show two options, pick one, done — now spawns a child where it used to be a single call.
Same number of interruptions, one more model context.

## Later

Two features that were folded into this plan and do not belong in it. Neither is needed by any of
the seven stories. Both are their own change, after this one lands.

**One input field.** Retarget the composer at the waiting question instead of giving the block its
own text field. It needs target state in `Workspace.tsx`, a skip of the `isBusy` guard at
`Workspace.tsx:310`, a send label that names the question, and a rule for which of two live
questions wins. That is a lot of moving parts to delete ten lines of text field.

**The pencil.** A Draw button on the block, `src/services/sketch-raster.ts` to rasterise the sketch
through `<svg><foreignObject>`, `ImageScratchpad` generalised off `attachment` and lifted out of its
`Dialog`, `QuestionResponse.drawing` as base64 PNG, and `reply_answer` returning it as
`"frame": {"encoding": "png-base64", ...}` so `pictureOf` in `scripts/tool-result.mjs` lifts it out.

`src/models/annotation.ts` and `src/services/annotation-canvas.ts` need no changes for it.
`flattenAnnotations` takes `{src, size, shapes, name}` and calls `loadImage` on `src`. Hand it a
data: URL of the raster and the sketch's own 1280 by 720 as `size`.

**The pencil requires a vision model.** `modelReadsImages` checks `model.input` for `'image'`, and
when it is false `withoutPictures` blanks every image part into a sentence. A blind model cannot see
an arrow. Gate the Draw button on the same check, or it is a button that silently does nothing.

Which is also the answer to how a sketch reaches the model. With eyes: the raster PNG plus one line
naming which sketch. Without: text only. Never the HTML, because the model wrote it and it is
already in its own last message.
