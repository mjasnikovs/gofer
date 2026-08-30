function declare(lists, name, build) {
    for (const list of lists) {
        if (list.includes(name)) throw new Error(`The AI event ${name} is declared twice`)
        list.push(name)
    }
    return (...args) => ({type: name, ...build(...args)})
}

export const TURN_EVENTS = []

export const BRIEF_EVENTS = []

export const JUDGE_EVENTS = []

export const COMPLETION_EVENTS = []

export const textDelta = declare([TURN_EVENTS], 'text-delta', delta => ({delta}))

export const thinkingDelta = declare([TURN_EVENTS], 'thinking-delta', delta => ({delta}))

export const toolStart = declare([TURN_EVENTS], 'tool-start', ({id, name, target, startedAt}) => ({
    id,
    name,
    target,
    startedAt
}))

export const toolUpdate = declare([TURN_EVENTS], 'tool-update', ({id, output, step}) => ({
    id,
    output,
    step
}))

export const toolEnd = declare([TURN_EVENTS], 'tool-end', ({id, output, isError, endedAt}) => ({
    id,
    output,
    isError,
    endedAt
}))

export const usageReport = declare([TURN_EVENTS], 'usage', (usage, model) => ({usage, model}))

export const toolCost = declare([TURN_EVENTS], 'tool-cost', (ids, tokens) => ({ids, tokens}))

export const compactionStart = declare(
    [TURN_EVENTS],
    'compaction-start',
    (tokens, contextWindow) => ({tokens, contextWindow})
)

export const compactionEnd = declare([TURN_EVENTS], 'compaction-end', () => ({}))

export const turnState = declare([TURN_EVENTS], 'turn-state', agentMessages => ({agentMessages}))

export const contextRebuilt = declare([TURN_EVENTS], 'context-rebuilt', messages => ({messages}))

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

export const retryStart = declare([TURN_EVENTS], 'retry-start', (attempt, maxAttempts) => ({
    attempt,
    maxAttempts
}))

export const verifyPoint = declare(
    [TURN_EVENTS],
    'verify-point',
    ({name, command, status, index, of, output}) => ({name, command, status, index, of, output})
)

export const steered = declare([TURN_EVENTS], 'steered', id => ({id}))

export const aborted = declare([TURN_EVENTS], 'aborted', () => ({}))

export const turnDone = declare(
    [TURN_EVENTS, COMPLETION_EVENTS],
    'done',
    ({text, thinking, stopReason, usage, model, agentMessages, verify}) => ({
        text,
        thinking,
        stopReason: stopReason ?? 'stop',
        usage,
        model,
        agentMessages,
        verify
    })
)

export const briefStarted = declare([BRIEF_EVENTS], 'brief-started', () => ({}))

export const briefPhaseStart = declare([BRIEF_EVENTS], 'brief-phase-start', phase => ({phase}))

export const briefPhase = declare([BRIEF_EVENTS], 'brief-phase', (phase, field, value) => ({
    phase,
    field,
    value
}))

export const briefWorker = declare([BRIEF_EVENTS], 'brief-worker', label => ({label}))

export const briefWorkerStep = declare(
    [BRIEF_EVENTS],
    'brief-worker-step',
    ({label, line, steps}) => ({
        label,
        line,
        steps
    })
)

export const briefWorkerDone = declare([BRIEF_EVENTS], 'brief-worker-done', (section, kind) => ({
    section,
    kind
}))

export const briefQuestionSettled = declare(
    [BRIEF_EVENTS],
    'brief-question-settled',
    (question, outcome) => ({question, outcome})
)

export const briefCost = declare([BRIEF_EVENTS], 'brief-cost', ({input, output}) => ({
    input,
    output
}))

export const briefLog = declare([BRIEF_EVENTS], 'brief-log', message => ({message}))

export const briefStopped = declare([BRIEF_EVENTS], 'brief-stopped', phase => ({phase}))

export const briefFailed = declare([BRIEF_EVENTS], 'brief-failed', (phase, reason) => ({
    phase,
    reason
}))

export const briefDone = declare([COMPLETION_EVENTS], 'brief-done', spec => ({spec}))

export const judgeStarted = declare([JUDGE_EVENTS], 'judge-started', () => ({}))

export const judgeStep = declare([JUDGE_EVENTS], 'judge-step', ({memoryId, line, steps}) => ({
    memoryId,
    line,
    steps
}))

export const judgeVerdict = declare(
    [JUDGE_EVENTS],
    'judge-verdict',
    ({verdict, reason, model, input, output}) => ({verdict, reason, model, input, output})
)

export const judgeStopped = declare([JUDGE_EVENTS], 'judge-stopped', () => ({}))

export const judgeFailed = declare([JUDGE_EVENTS], 'judge-failed', reason => ({reason}))

export const judgeDone = declare([COMPLETION_EVENTS], 'judge-done', verdict => ({verdict}))
