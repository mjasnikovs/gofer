# RUNNINGLOOP

**This file is your task.** Reading it is not the work. Doing it is.

Run Gofer. Observe it. Fix what it did wrong. Then run it again.

Start the first run as soon as you have read this. Do not ask permission. Do not report a plan and
wait. The loop never ends — it stops only when the human says stop.

## What the loop is for

Gofer is the thing under test. The local model is the driver, not the subject.

One prompt goes in. A Mario World 1-1 level should come out. Every place where Gofer wasted the
model's turns is a defect, and the defect is Gofer's until proven otherwise.

## The prompt

Exactly one message, typed into the chat, every run:

```
Create a Mario World 1-1 level. Make it playable.
```

Do not help. Do not send a second message. Do not answer a question the model asks unless the
interface blocks without an answer, and if it does, that block is itself a finding.

The run is over when the model says it is done. Not when a timer expires.

## The workspace

**A blank Godot project for every run.** Not the seeded fixture. Not a project from a previous run.

Blank means: a `project.godot` naming the project, an empty `git` repository with one commit, and
nothing else. A task only gets a branch inside a repository that has a commit, so the commit is
mandatory.

Point the harness at it with `GOFER_LIVE_WORKSPACE`.

Wipe `/tmp/gofer-live-run` between runs too. A stale application data directory carries the previous
run's project row, settings and message history.

## Where the machinery already is

Nothing here drives one prompt yet. Build that from these parts on the first run.

- `wdio.live.conf.ts` — points the release binary at a real project with nothing stubbed. It sets
  `GOFER_WORKSPACE_DIR`, redirects `GOFER_APP_DATA_DIR` to `/tmp/gofer-live-run`, copies the user's
  own settings in, and kills a stale application first. Copy it; do not edit it.
- `e2e/live/workspace-fixture.ts` — seeds a project and commits it. It seeds from
  `fixtures/live-project`, which is **not** blank. A blank run needs its own project made the same
  way: `project.godot`, `git init`, one commit.
- `e2e/live/harness.ts` — how to drive the WebKitGTK window. `installActivityProbe` first, then the
  click, type and wait helpers.
- `e2e/live/workspace.spec.ts` — its private `sendChat` is the pattern for sending one message and
  waiting out the turn. It types into `[role="textbox"]`, reads the text back, presses Enter, and
  treats the composer emptying as the send. A turn is over when the composer takes another message.
- One spec file only. The Tauri service keeps one embedded driver on a fixed port, so a second spec
  attaches to the window the first left running.
- The release build is `npm run build:desktop:test`.
- Set `GOFER_GDFORMAT` or every formatting step quietly does nothing.
- The model endpoint defaults to `http://127.0.0.1:8080/v1`. It is llama.cpp in Docker. If it is
  down, no run is possible — check it before blaming Gofer.

## The three defect classes

Every finding is one of these. Name it before fixing it.

### 1. Silent failure

The tool answered success and the thing is broken.

This is the worst class and the one with the longest history in this repo. The rule that works: **a
mutating tool reads back what Godot actually holds, and answers with that.** Not with what it was
asked to do.

### 2. Blind waiting

The tool polled, slept, or ran to timeout instead of waiting on an edge.

Every wait needs two things: an edge that says the work is finished, and a reason when it is not.
`filesystem_changed` is the model for this — the asset import work already landed. Any other wait
that has no named edge is a defect waiting to happen.

A timeout whose message does not say what was being waited for is always a defect.

### 3. Mute failure

The tool failed honestly and the message did not teach.

The test: could the model do something different next turn, knowing only that sentence? If not, the
message is wrong. "Import failed" is mute. "Godot has no importer for `.xcf`; supported image
formats are png, jpg, webp, svg" is not.

## Triage: whose fault is it?

This decides what gets fixed. Get it right.

| What happened                                                | Whose fault                          | What to fix                                                  |
| ------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------ |
| The model passed a parameter the tool does not accept        | The model, or the tool's description | The tool description, or the agent prompt. **Not the tool.** |
| The model called a tool that does not exist                  | The description                      | The catalogue or the prompt                                  |
| The tool timed out and never said why                        | Gofer                                | The tool                                                     |
| The tool succeeded and the result was wrong                  | Gofer                                | The tool                                                     |
| The tool failed for a real reason the model could not act on | Gofer                                | The message                                                  |
| A tool waited its full timeout on something already dead     | Gofer                                | The tool. Check liveness first                               |
| The game crashed and the model kept working elsewhere        | Gofer                                | The runtime error path                                       |

**Once is the model. Twice is a regression.** The same failure code, from the same tool, twice in
one run means the message did not teach. That is Gofer's defect even if the parameters were wrong
both times.

## The regression test comes first. MANDATORY.

Found an issue, a problem, a bug? **Write the regression test before you write anything else.**

No exceptions. Not for a one-line fix. Not for an obvious typo. Not when the fix is already clear in
your head. The test is written, run, and seen to fail, before a single line of the fix exists.

The order is fixed:

1. Reproduce the finding as a test. Nothing else changes yet.
2. Run it. **Watch it fail.** A test that has never failed proves nothing.
3. Check the failure message names the real defect, not a setup mistake.
4. Only now write the fix.
5. Run the test again. It passes.
6. Run the full gate.

A test written after the fix is not a regression test. It is a description of code you already
wrote, and it would have passed on the broken build too.

If the finding cannot be reproduced in a test, that is a finding of its own. The seam is untestable.
Say so, and fix the seam before the bug.

**No fix lands without its failing-first test in the same commit.**

## Runtime errors

A crashed game must reach the model immediately.

Not through a channel the model has to remember to ask about. A side channel is what got ignored.
The rule: **once the game has failed, the next tool result the model receives carries that
failure**, whatever tool it was.

### The worked example

This was observed. It is the shape to look for.

The game crashed on a script error. The model then called `godot_runtime input` twelve times in a
row. Every one of them answered:

```
runtime_timeout: The game did not answer in time
```

Twelve waits, twelve full timeouts, nothing learned. The model went looking for the bug in the wrong
place, because nothing it was told pointed at the right one.

Three separate defects are in that picture. Fix all three.

**The message is mute.** "Did not answer in time" describes the socket, not the world. The game was
not slow. The game was gone. A dead game and a busy game must not produce the same sentence.

**It did not fail fast.** A process that has exited cannot answer, and that is knowable before the
wait starts. Waiting the full timeout to discover it is pure waste, twelve times over.

**The crash never travelled.** Godot printed a script error and a stack trace. That text existed on
the debugger bridge, or on the game's stderr, or both. It reached nobody.

### The rules that follow

- **Check liveness before waiting.** If the game process is gone, answer now, and say it is gone.
- **Name the cause, not the symptom.** `runtime_crashed:` with the script error and the line it came
  from. `runtime_exited:` with the exit code. `runtime_timeout:` only when the game is genuinely
  alive and genuinely slow.
- **Say what to do next.** A dead game means the model must run it again, not retry the input.
- **Keep the last failure.** Hold the crash text after the game dies. Every runtime tool answers
  with it until the game is started again.
- **Repeats are the alarm.** The same runtime failure twice in a row means the first message failed.
  Twelve times means it failed completely.

## The cycle

1. Make a blank project. Wipe the application data directory.
2. Launch the release build against it.
3. Send the prompt. Once.
4. Watch. Do not touch the application.
5. The model says done, or the model gives up, or it goes in circles.
6. Read every tool call the run made. Aggregate the failures.
7. Pick the worst finding. Classify it. Triage it.
8. Write a regression test that fails for the reason the run failed. Run it. Watch it fail.
9. Only then fix it. Make the test pass.
10. Run the full gate. Commit the test and the fix together.
11. Go to 1.

Never skip 8. A fix without a failing test first is a guess. Step 9 does not start until step 8 has
produced a red test.

Never skip 11. Not when tired of it, not when the last run was green, not when there is nothing
obvious left. A green run with no findings still teaches: raise the bar on what counts as done and
run again.

## Watching a run

The spec reporter buffers until the file ends, so it is not a live signal. These are.

The model's own turns:

```
sqlite3 /tmp/gofer-live-run/data/projects/*/project.sqlite \
  "select sequence, sender, text from messages order by sequence"
```

Every tool call with its result — the richest diagnostic in the repo. `payload_json` carries a
`tools` array per assistant message: name, target, status, full output.

```
sqlite3 /tmp/gofer-live-run/data/projects/*/project.sqlite \
  "select payload_json from messages where sender='assistant'" \
| python3 -c "import sys,json,collections
c=collections.Counter()
for l in sys.stdin:
    for t in (json.loads(l).get('tools') or []):
        if t.get('status')=='error':
            c[(t['name'],t.get('target'),(t.get('output') or '').split(':')[0])]+=1
[print(n,k) for k,n in c.most_common()]"
```

Which project the editor is on: `pgrep -af '^godot --editor'` names it in `--path`. Which task, is
`git -C <project> branch --show-current`.

Launch the runner detached — `setsid nohup … &` — or stopping an unrelated background job can SIGINT
the runner mid-run.

## Rules that are not negotiable

- Work directly on `master`. No branches. No pull requests.
- `.githooks/pre-commit` runs the full `npm run check`. Anything that breaks the gate blocks the
  commit, so the gate is the definition of done for a fix.
- After touching the command surface: `npm run generate`, then `npm run check`.
- Never change a test so a run passes. The test is the thing that was right.
- Every finding gets a regression test first. Red before green. No fix commits without one.
- Never help the model mid-run to get a better level. The level is not the point.

## What in this file is a guess

Written by the author of this file, not validated. Check each one on the first run and replace it
with what you actually found. A guess left standing after it has been checked is worse than the
guess.

1. **The prompt wording.** Invented, not given by the human. If it is a bad prompt the run will show
   it. Keep it identical between runs regardless, or two runs are not comparable.
2. **The blank project shape.** `project.godot`, `git init`, one commit was inferred from the
   fixture, never tried. A project with no scene at all may break something at startup that the
   fixture hides.
3. **The model endpoint.** `http://127.0.0.1:8080/v1` is the code's default in
   `src-tauri/src/settings.rs`. Nobody confirmed the Docker container listens there.
4. **Where the crash text lives.** "The debugger bridge or stderr" was written without reading
   `src-tauri/src/godot_dap.rs`, `src-tauri/src/godot_bridge.rs` or `src-tauri/addon/runtime.gd`.
   Read them before designing the fix.
5. **The SQL under "Watching a run".** Carried over from an earlier session. Not run against a
   current database.
6. **"Twice is a regression."** The idea is agreed. The number two is not. Adjust it once there are
   real runs to count.

## Never stop

**A run in flight is not a reason to stop working. It is the reason there is work.**

A run takes half an hour or more. Waiting it out is the single most expensive mistake in this loop,
and it is the easy one to make: the run looks like the task, so watching it feels like doing it. It
is not. The run is a data source. Reading it is the work, and the previous run's findings are
already sitting there.

Never sleep, poll on a timer, or say "waiting for the run to finish" as a turn of its own. While a
run is in flight there is always one of these to do, in this order:

1. **Work the open finding.** Write its failing test. Watch it fail. Write the fix. Source edits do
   not touch the binary a run is already using, so this is always safe.
2. **Take the next finding off the queue.** Every run leaves more than one. Rank them, pick the
   worst, and start it. The queue is only empty if the last run was perfect.
3. **Read the run so far.** The tool calls are in the database as they land. Aggregate them now
   rather than at the end.
4. **Fix the harness.** A limit that cut a run short, a stale process, an assertion that lied.

Only two things genuinely wait for a run to end: the full gate, because it needs the same Godot the
run is holding, and the next run. Everything else proceeds.

If a turn of yours would say only that something is still running, do not send it. Do the next thing
on the list and report that instead.

If something blocks a run and cannot be unblocked — the endpoint is down, the editor will not start
— say so, then take the next open finding and work on it while it stays blocked.
