/**
 * What a project remembers, and what checking it against the workspace found.
 *
 * These rows are not a log. Six of them are read into the front of every turn's prompt, so a row
 * that has stopped matching the project is not stale trivia — it is something the model is told
 * before it starts. That is what the window is for.
 */

/** What a memory is, in the words its own table uses. */
export type MemoryKind = 'decision' | 'preference' | 'fact' | 'issue' | 'summary'

/**
 * Whether the model is given this memory.
 *
 * Retrieval reads `confirmed` and nothing else, so `candidate` is a mute rather than a draft: the
 * row keeps every word it has and stops reaching the prompt. `superseded` is the same silence with
 * a reason — something later replaced it.
 */
export type MemoryState = 'candidate' | 'confirmed' | 'superseded'

/**
 * What checking a memory's paths found.
 *
 * `stale` says a file the memory names is not in the workspace. It does not say the memory is
 * wrong: a memory whose whole subject is a deletion names a file that is correctly gone. The check
 * knows where files are and nothing else, and the wording on screen has to keep saying only that.
 */
export type MemoryCheck = 'unchecked' | 'unanchored' | 'intact' | 'stale'

/** One path a memory names, and where — if anywhere — the workspace keeps it. */
export type MemoryAnchor = Readonly<{
    named: string
    resolved?: string | undefined
}>

/**
 * What a model judge said, and whether it is still about this memory.
 *
 * Stored, where the path check is recomputed on every read. The difference is cost: a directory
 * walk can be redone whenever the panel opens, a model request and a minute cannot. So the two
 * facts that let a reader discount an old verdict travel with it — when it was made, and whether
 * the text it was made about is the text stored now.
 */
export type MemoryJudgement = Readonly<{
    verdict: MemoryVerdict
    reason: string
    at: number
    /** The model that said it. A verdict with no model against it cannot be weighed. */
    model: string
    /** False once the memory has been edited since. The verdict is kept, and marked. */
    isCurrent: boolean
}>

/** The three answers a judge may give. An answer that carries no verdict is `unclear`. */
export type MemoryVerdict = 'holds' | 'broken' | 'unclear'

/**
 * What a running judgement says about itself, on the window event it rides.
 *
 * Every judgement ends on exactly one of `judge-verdict`, `judge-failed` or `judge-stopped`. A
 * worker that was killed emits none of them, so the backend says the ending again on its way out —
 * a row left spinning with no ending is what this contract exists to stop.
 */
export type MemoryJudgeEvent = Readonly<{
    type: 'judge-started' | 'judge-step' | 'judge-verdict' | 'judge-failed' | 'judge-stopped'
    memoryId: string
    /** The live line, on `judge-step`: what the child is reading right now. */
    line?: string | undefined
    verdict?: MemoryVerdict | undefined
    reason?: string | undefined
}>

/**
 * What a sweep says about itself, on the window event it rides.
 *
 * Separate from [[MemoryJudgeEvent]], which stays per-memory: a row drawing a spinner and a header
 * drawing "31 of 84" are asking different questions. Every sweep ends on `sweep-finished` or
 * `sweep-stopped`, and the counts on the ending are the run's own, not the panel's arithmetic.
 */
export type MemorySweepEvent = Readonly<{
    type: 'sweep-progress' | 'sweep-finished' | 'sweep-stopped'
    /** The memory being judged right now. Absent on either ending — there is none. */
    memoryId?: string | undefined
    done: number
    total: number
}>

export type ProjectMemory = Readonly<{
    id: string
    taskId?: string | undefined
    kind: MemoryKind
    state: MemoryState
    content: string
    provenance: Readonly<Record<string, unknown>>
    supersededBy?: string | undefined
    createdAt: number
    updatedAt: number
    /** Computed on every read, never stored: a verdict on disk is a second thing that goes stale. */
    check: MemoryCheck
    anchors: readonly MemoryAnchor[]
    /** Absent until somebody pays for one. See [[MemoryJudgement]]. */
    judgement?: MemoryJudgement | undefined
}>

/** The three fields the window may change. Everything else about a row is not its business. */
export type MemoryEdit = Readonly<{
    id?: string | undefined
    kind: MemoryKind
    state: MemoryState
    content: string
}>

export const MEMORY_KINDS: readonly MemoryKind[] = [
    'decision',
    'preference',
    'fact',
    'issue',
    'summary'
]

export const MEMORY_STATES: readonly MemoryState[] = ['candidate', 'confirmed', 'superseded']

/** The paths a check looked for and did not find. Empty for every verdict but `stale`. */
export function missingAnchors(memory: ProjectMemory): readonly string[] {
    return memory.anchors
        .filter(anchor => anchor.resolved === undefined)
        .map(anchor => anchor.named)
}

/**
 * What a verdict is worth saying about one memory, in the words the check can stand behind.
 *
 * Every sentence here names the measurement rather than a judgement, because the measurement is all
 * there is: the check opened the workspace and looked for the files this row spells out.
 */
export function checkSummary(memory: ProjectMemory): string {
    const missing = missingAnchors(memory)
    const named = memory.anchors.length
    if (memory.check === 'unchecked') return 'No workspace to check against'
    if (memory.check === 'unanchored') return 'Names no file'
    if (memory.check === 'intact')
        return named === 1 ?
                'Names 1 file, and it is there'
            :   `Names ${String(named)} files, all there`
    return missing.length === 1 ?
            `Names ${String(missing[0])}, which is not in the workspace`
        :   `Names ${String(missing.length)} files that are not in the workspace`
}

/** Whether the model is given this memory at the start of a turn. */
export function isRetrievable(memory: ProjectMemory): boolean {
    return memory.state === 'confirmed'
}

/**
 * Whether the model has read this row against the code as it stands and said it no longer holds.
 *
 * `isCurrent` is half the question. A verdict made before the memory was edited is kept and shown,
 * because it is still worth reading — but it is not something to act on in bulk, since the sentence
 * it was about is not the sentence stored now.
 */
export function isBroken(memory: ProjectMemory): boolean {
    return memory.judgement?.verdict === 'broken' && memory.judgement.isCurrent
}

/** Whether anyone has yet paid for a verdict about the row as it reads now. */
export function isUnjudged(memory: ProjectMemory): boolean {
    return memory.judgement?.isCurrent !== true
}

/** What a judge's verdict is worth saying, in words that keep it a judgement rather than a fact. */
export function verdictSummary(judgement: MemoryJudgement): string {
    const judged =
        judgement.verdict === 'holds' ? 'The model read the code and says this still holds'
        : judgement.verdict === 'broken' ? 'The model read the code and says this no longer holds'
        : 'The model read the code and could not tell'
    return judgement.isCurrent ? judged : `${judged}, before this memory was edited`
}

const JUDGE_EVENTS: readonly MemoryJudgeEvent['type'][] = [
    'judge-started',
    'judge-step',
    'judge-verdict',
    'judge-failed',
    'judge-stopped'
]

const SWEEP_EVENTS: readonly MemorySweepEvent['type'][] = [
    'sweep-progress',
    'sweep-finished',
    'sweep-stopped'
]

/** Whether the backend really sent this, so the header never draws a guess as a count. */
export function isMemorySweepEvent(value: unknown): value is MemorySweepEvent {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Partial<MemorySweepEvent>
    if (typeof candidate.done !== 'number' || typeof candidate.total !== 'number') return false
    return SWEEP_EVENTS.some(name => name === candidate.type)
}

/** Whether the backend really sent this, so the panel never draws a guess as a verdict. */
export function isMemoryJudgeEvent(value: unknown): value is MemoryJudgeEvent {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Partial<MemoryJudgeEvent>
    if (typeof candidate.memoryId !== 'string') return false
    return JUDGE_EVENTS.some(name => name === candidate.type)
}
