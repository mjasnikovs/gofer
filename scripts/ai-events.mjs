/**
 * Every event the AI worker writes, and the only way to write one.
 *
 * About forty `emit({type: ...})` sites across five files, and no list of them anywhere. Rust routed
 * them by string prefix, the renderer re-declared the same vocabulary as a union and a hand-written
 * guard, and `src/services/turn.ts` drops whatever the guard rejects in silence, by design. That
 * silence has already cost a defect, written down in `scripts/ai-provider.mjs`: a completion missing
 * its usage or its model is rejected, and a rejected completion is dropped without a word — so the
 * stopped turn it belonged to was never recorded as having ended.
 *
 * A constructor per event is what makes the set enumerable. `declare` is the only way a name gets
 * onto one of the lists below, so the lists cannot fall behind the constructors, and
 * `scripts/check-command-surface.mjs` holds the lists to the renderer's `AiStreamEvent` union, to
 * its `isAiStreamEvent` guard, to the brief catalogue, and to the judge's own event type.
 *
 * Three completions rather than one. `done` used to be emitted by all three job modes with three
 * different payloads — `{text, usage, model, agentMessages}` from a turn, `{spec}` from a brief,
 * `{verdict}` from a judgement — and Rust read all three as "the turn completed" and reached for a
 * `text` that two of them never carried. A brief and a judgement say so by name now.
 *
 * Data and shape only. Nothing here imports anything that runs, because a checker reads it and a
 * checker that has to start a provider to find out what an event is called is not a checker.
 */

/**
 * Declares one event: its name goes on every list it belongs to, and what comes back is the only
 * way to build one.
 *
 * The lists cannot drift from the constructors because a constructor is how a name reaches a list.
 * A duplicate throws at import rather than on the wire, where two events of one name are two
 * different shapes the renderer folds through one arm.
 */
function declare(lists, name, build) {
    for (const list of lists) {
        if (list.includes(name)) throw new Error(`The AI event ${name} is declared twice`)
        list.push(name)
    }
    return (...args) => ({type: name, ...build(...args)})
}

/**
 * The events that reach the conversation: what `src/services/turn.ts` folds into the reply on
 * screen, one arm of `AiStreamEvent` each.
 *
 * Rust forwards these opaquely down the turn's stream channel. Anything not on this list that the
 * renderer's guard does not know is dropped without being drawn, which is why the two lists are
 * checked against each other rather than trusted.
 */
export const TURN_EVENTS = []

/** The events a running brief reports itself on. The panel drawing it reads these and no others. */
export const BRIEF_EVENTS = []

/** The events one memory judgement reports itself on. */
export const JUDGE_EVENTS = []

/**
 * How each job mode says it is finished.
 *
 * One per mode, because Rust ends the worker on this event and takes the answer off it: a name that
 * means three things left it reading a field that only one of the three had.
 */
export const COMPLETION_EVENTS = []

// --- The turn's stream.

/** One piece of the answer as the model writes it. */
export const textDelta = declare([TURN_EVENTS], 'text-delta', delta => ({delta}))

/** One piece of the model's reasoning, kept apart from the answer it is reasoning towards. */
export const thinkingDelta = declare([TURN_EVENTS], 'thinking-delta', delta => ({delta}))

/** A tool call beginning. `target` is what the row says it is being done to, where a tool has one. */
export const toolStart = declare([TURN_EVENTS], 'tool-start', ({id, name, target, startedAt}) => ({
    id,
    name,
    target,
    startedAt
}))

/** What a call is doing right now, for the few tools that have an inside to report. */
export const toolUpdate = declare([TURN_EVENTS], 'tool-update', ({id, output, step}) => ({
    id,
    output,
    step
}))

/** A tool call answering, however it answered. */
export const toolEnd = declare([TURN_EVENTS], 'tool-end', ({id, output, isError, endedAt}) => ({
    id,
    output,
    isError,
    endedAt
}))

/** The turn's running total, as the provider reports it. Overwritten by each report after it. */
export const usageReport = declare([TURN_EVENTS], 'usage', (usage, model) => ({usage, model}))

/** What one ask cost, addressed to the calls that ask issued. Nothing overwrites one of these. */
export const toolCost = declare([TURN_EVENTS], 'tool-cost', (ids, tokens) => ({ids, tokens}))

/** The transcript is being summarised, which is one or two model requests with nothing to show. */
export const compactionStart = declare(
    [TURN_EVENTS],
    'compaction-start',
    (tokens, contextWindow) => ({tokens, contextWindow})
)

/** The summary is in and the turn is carrying on. */
export const compactionEnd = declare([TURN_EVENTS], 'compaction-end', () => ({}))

/**
 * What the model remembers, as it stands part-way through a turn.
 *
 * Emitted at every step rather than only at the end, so a turn that crashed, was stopped, or lost
 * its worker still leaves behind what it did.
 */
export const turnState = declare([TURN_EVENTS], 'turn-state', agentMessages => ({agentMessages}))

/** The model had no memory of this task, so the conversation on screen was sent in its place. */
export const contextRebuilt = declare([TURN_EVENTS], 'context-rebuilt', messages => ({messages}))

/** The turn failed for a reason that may pass, and is waiting before asking again. */
export const retryScheduled = declare(
    [TURN_EVENTS],
    'retry-scheduled',
    ({attempt, maxAttempts, delayMs, errorMessage}) => ({
        attempt,
        maxAttempts,
        delayMs,
        errorMessage
    })
)

/** The wait is over and the model is being asked again. */
export const retryStart = declare([TURN_EVENTS], 'retry-start', (attempt, maxAttempts) => ({
    attempt,
    maxAttempts
}))

/** One verification point starting, or answering. Sent per point, because the run is the part worth watching. */
export const verifyPoint = declare(
    [TURN_EVENTS],
    'verify-point',
    ({name, command, status, index, of, output}) => ({name, command, status, index, of, output})
)

/**
 * The turn was stopped and nothing more is coming.
 *
 * Minted in `src-tauri/src/ai_turn.rs` rather than here: it is what a cancellation says when it has
 * had to kill a worker that would not answer the cancel line, and a killed worker says nothing for
 * itself. Declared anyway, because the renderer draws it and the set has to be the same set.
 */
export const aborted = declare([TURN_EVENTS], 'aborted', () => ({}))

/**
 * A chat turn finished, with everything the turn produced.
 *
 * Spelled `done` on the wire while `brief-done` and `judge-done` are spelled out, and that is not
 * an oversight: the turn's completion is the one that was always this event, and the other two were
 * the impostors sharing its name. Renaming this one is a change to `scripts/ai-provider.mjs`, which
 * is the file that emits it.
 *
 * `verify` rides along for the record and nothing reads it in the renderer; every other field is
 * folded into the reply on screen.
 */
export const turnDone = declare(
    [TURN_EVENTS, COMPLETION_EVENTS],
    'done',
    ({text, thinking, stopReason, usage, model, agentMessages, verify}) => ({
        text,
        thinking,
        stopReason,
        usage,
        model,
        agentMessages,
        verify
    })
)

// --- A brief's own progress. Reconciled with `scripts/brief/catalogue.mjs`, which owns the words.

/** Said before anything slow happens, so a task with an empty chat has something saying why. */
export const briefStarted = declare([BRIEF_EVENTS], 'brief-started', () => ({}))

/** A phase beginning. The panel reads its `phase`, so an unknown one is dropped rather than drawn. */
export const briefPhaseStart = declare([BRIEF_EVENTS], 'brief-phase-start', phase => ({phase}))

/** A phase finishing, and the column its output fills. */
export const briefPhase = declare([BRIEF_EVENTS], 'brief-phase', (phase, field, value) => ({
    phase,
    field,
    value
}))

/** One worker starting, named the way the panel lists it. */
export const briefWorker = declare([BRIEF_EVENTS], 'brief-worker', label => ({label}))

/** What a worker is reading right now. Emitted by the delegation itself, not by the host loop. */
export const briefWorkerStep = declare(
    [BRIEF_EVENTS],
    'brief-worker-step',
    ({label, line, steps}) => ({
        label,
        line,
        steps
    })
)

/** One research worker ending, and how. */
export const briefWorkerDone = declare([BRIEF_EVENTS], 'brief-worker-done', (section, kind) => ({
    section,
    kind
}))

/** A question the run put to the user, and what came back. */
export const briefQuestionSettled = declare(
    [BRIEF_EVENTS],
    'brief-question-settled',
    (question, outcome) => ({question, outcome})
)

/** What the run has spent so far. */
export const briefCost = declare([BRIEF_EVENTS], 'brief-cost', ({input, output}) => ({
    input,
    output
}))

/** Something worth saying that is not a phase — a dropped image, a search that was not configured. */
export const briefLog = declare([BRIEF_EVENTS], 'brief-log', message => ({message}))

/** Stop was pressed, and where it happened. */
export const briefStopped = declare([BRIEF_EVENTS], 'brief-stopped', phase => ({phase}))

/** It broke, where it broke, and why. */
export const briefFailed = declare([BRIEF_EVENTS], 'brief-failed', (phase, reason) => ({
    phase,
    reason
}))

/** The brief finished and this is the specification. Rust ends the worker on it. */
export const briefDone = declare([COMPLETION_EVENTS], 'brief-done', spec => ({spec}))

// --- A memory judgement. Reconciled with `MemoryJudgeEvent` in `src/models/memory.ts`.

/** Said before the probes, which are slow, so the row has something to draw. */
export const judgeStarted = declare([JUDGE_EVENTS], 'judge-started', () => ({}))

/** What the child is reading right now. Emitted by the delegation itself. */
export const judgeStep = declare([JUDGE_EVENTS], 'judge-step', ({memoryId, line, steps}) => ({
    memoryId,
    line,
    steps
}))

/**
 * The answer, and what it cost.
 *
 * `model` is the child's, not the parent's: the same sentence is worth different things from a
 * local 27B and from the model the user is paying for, and a verdict filed under the wrong name
 * cannot be weighed.
 */
export const judgeVerdict = declare(
    [JUDGE_EVENTS],
    'judge-verdict',
    ({verdict, reason, model, input, output}) => ({verdict, reason, model, input, output})
)

/** Stop was pressed. */
export const judgeStopped = declare([JUDGE_EVENTS], 'judge-stopped', () => ({}))

/** A probe that refused, a child that could not be built, a fault in the judge itself. */
export const judgeFailed = declare([JUDGE_EVENTS], 'judge-failed', reason => ({reason}))

/** The judgement finished and this is what it decided. Rust ends the worker on it. */
export const judgeDone = declare([COMPLETION_EVENTS], 'judge-done', verdict => ({verdict}))
