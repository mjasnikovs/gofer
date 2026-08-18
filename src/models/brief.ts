/**
 * A planned task's brief: the four phases it runs before the first chat turn, and what each produced.
 *
 * The types here describe two different things and it is worth saying which is which. `BriefRun` is
 * the stored row — what a task's brief IS, read back at any time. `BriefEvent` is what arrives while
 * one is running. They overlap because the events are what fills the row in, but a screen showing
 * progress reads the events and a screen showing a finished brief reads the row.
 */

/**
 * The phases, in the order they run.
 *
 * Hand-written here and reconciled against `scripts/brief/catalogue.mjs` by
 * `npm run check:command-surface`. The catalogue is the owner; this is the shape, written next to
 * what reads it — the same split ADR-0002 makes for the Godot commands.
 */
export const BRIEF_PHASES = ['refine', 'research', 'grill', 'compose'] as const

export type BriefPhase = (typeof BRIEF_PHASES)[number]

const PHASES = new Set<string>(BRIEF_PHASES)

/** The field each phase fills. Reconciled against the catalogue with the phase names above. */
export const BRIEF_PHASE_FIELDS: Readonly<Record<BriefPhase, string>> = {
    refine: 'refined',
    research: 'research',
    grill: 'qa',
    compose: 'spec'
}

/** The last phase, whose output the specification is. Typed from the tuple, not counted. */
type LastPhase =
    typeof BRIEF_PHASES extends readonly [...unknown[], infer Last extends BriefPhase] ? Last
    :   never

/**
 * The field holding the specification, which is a planned task's first message.
 *
 * Derived rather than typed out, because what makes it the specification is that it is the LAST
 * phase's output — every phase announces one, and only this one is the thing the agent works from.
 */
export const SPECIFICATION_FIELD =
    BRIEF_PHASE_FIELDS[BRIEF_PHASES[BRIEF_PHASES.length - 1] as LastPhase]

/** What a phase is called on screen. Short, because it sits in a row of four. */
export const BRIEF_PHASE_LABELS: Readonly<Record<BriefPhase, string>> = {
    refine: 'Sharpening the ask',
    research: 'Reading the project',
    grill: 'Settling the questions',
    compose: 'Writing the spec'
}

/** The four research workers, in the order their sections are assembled. */
export const RESEARCH_SECTIONS = ['FILES', 'APIS', 'CONTEXT', 'TOOLING'] as const

/**
 * How a brief ended, or that it has not.
 *
 * `stopped` and `failed` are kept apart because only one of them is worth offering to continue: a
 * user who pressed Stop knows why it stopped, and a run that broke needs to say what broke.
 */
export const BRIEF_STATUSES = ['running', 'done', 'failed', 'stopped'] as const

export type BriefStatus = (typeof BRIEF_STATUSES)[number]

/**
 * One task's brief as stored.
 *
 * Every phase output is optional, and that is the point of the row rather than an oversight: a run
 * that stopped part way through has only the phases it reached, and showing how far it got is what
 * the record is for.
 */
export type BriefRun = Readonly<{
    taskId: string
    status: BriefStatus
    phase: string
    rawPrompt: string
    refined: string | null
    research: string | null
    qa: string | null
    spec: string | null
    reason: string | null
}>

/** One question the grill phase settled, and where the answer came from. */
export type BriefAnswer = Readonly<{
    question: string
    answer: string
    from: 'research' | 'user' | 'skipped' | 'open'
}>

/**
 * What arrives while a brief runs.
 *
 * A closed union with a discriminant, read the same way the chat timeline reads its own events —
 * anything unrecognised is dropped rather than rendered as a guess.
 */
export type BriefEvent =
    /** The run exists. It arrives before the first phase, which can take a moment to start. */
    | Readonly<{type: 'brief-started'}>
    | Readonly<{type: 'brief-phase-start'; phase: BriefPhase}>
    | Readonly<{type: 'brief-phase'; phase: BriefPhase; field: string; value: string}>
    | Readonly<{type: 'brief-worker'; label: string}>
    /**
     * What the worker in flight is doing right now: one tool call, or the word for the silence
     * between two of them. Produced by the delegation itself, not by the loop running it.
     */
    | Readonly<{type: 'brief-worker-step'; label: string; line: string; steps: number}>
    | Readonly<{type: 'brief-worker-done'; section: string; kind: string}>
    | Readonly<{type: 'brief-question-settled'; question: string; outcome: string}>
    | Readonly<{type: 'brief-cost'; input: number; output: number}>
    | Readonly<{type: 'brief-log'; message: string}>
    | Readonly<{type: 'brief-stopped'; phase: string}>
    | Readonly<{type: 'brief-failed'; phase: string; reason: string}>

/** Reconciled against the catalogue by `npm run check:command-surface`. */
export const BRIEF_EVENT_TYPES = [
    'brief-started',
    'brief-phase-start',
    'brief-phase',
    'brief-worker',
    'brief-worker-step',
    'brief-worker-done',
    'brief-question-settled',
    'brief-cost',
    'brief-log',
    'brief-stopped',
    'brief-failed'
] as const

const EVENT_TYPES = new Set<string>(BRIEF_EVENT_TYPES)

/**
 * Whether this is an event the panel can draw.
 *
 * The phase is checked as well as the type, and that is the part worth stating. A phase nobody knows
 * about set `state.phase` to a name no row is drawn for, so every row read "not started" — a panel
 * that looks like a run which never began, with nothing anywhere reporting an error. Dropped here
 * instead, the panel keeps the last phase it could draw.
 */
export function isBriefEvent(value: unknown): value is BriefEvent {
    if (typeof value !== 'object' || value === null) return false
    const {type, phase} = value as {type?: unknown; phase?: unknown}
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return false
    // Only the two events the panel reads a phase FROM are held to the list. An ending names where
    // it happened, which is worth reporting even when it happened before any phase started.
    if (type !== 'brief-phase' && type !== 'brief-phase-start') return true
    return typeof phase === 'string' && PHASES.has(phase)
}

/**
 * One question the agent asked, waiting for an answer.
 *
 * `options` are shortcuts, not a closed set — the answer is free text, and a question with no
 * options at all is perfectly ordinary.
 */
export type UserQuestionPrompt = Readonly<{
    questionId: string
    question: string
    options: readonly string[]
    why: string
}>

/** Emitted when a question stops waiting, however it stopped. */
export type UserQuestionSettled = Readonly<{
    questionId: string
    answered: boolean
}>

/**
 * How one research worker ended.
 *
 * Worth showing rather than counting. "Four of four" says a phase finished; it does not say that the
 * APIS worker found nothing, or that the CONTEXT worker was cut off mid-explore and its section is
 * partial — and those are the two things that explain a thin specification afterwards.
 */
export type ResearchWorker = Readonly<{
    section: string
    /** `ok`, `empty`, or `runaway`. */
    kind: string
}>

/** Reconciled against the catalogue by `npm run check:command-surface`. */
export const WORKER_KINDS = ['ok', 'empty', 'runaway'] as const

/** What a research worker's ending is called on screen. `ok` is the ordinary case and says nothing. */
export const WORKER_OUTCOME_LABELS: Readonly<Record<string, string>> = {
    empty: 'nothing to report',
    runaway: 'cut short'
}

/** The section a worker's label names, or nothing when the label is not a research worker. */
export function sectionOfWorker(label: string): string | undefined {
    return label.startsWith('worker:') ? label.slice('worker:'.length).toUpperCase() : undefined
}

/** What a progress panel is showing: which phase is running, and what has finished. */
export type BriefState = Readonly<{
    /** Whether a run is under way. True from the moment it says so, false once it ends. */
    isRunning: boolean
    phase: BriefPhase | undefined
    /** The research worker in flight right now, or nothing between them. */
    running: string | undefined
    /**
     * What the worker in flight is doing at this moment — one tool call, or the word for the silence
     * between two of them.
     *
     * Kept apart from `running`, which says WHICH worker and changes four times in a phase. This
     * changes every few seconds and is the only thing on the panel that does, which is the whole
     * point of it: four phases against a reasoning model is minutes, and a healthy run and a hung one
     * looked identical for all of it.
     */
    step: string | undefined
    /** The research workers that have answered, in the order they did. */
    research: readonly ResearchWorker[]
    /**
     * What the phases have spent, added up.
     *
     * Shown rather than folded into the turn's usage, and the difference matters: the context bar
     * reads the LAST usage event as how full the conversation is, so a delegation deliberately
     * reports none. That leaves the spend real and invisible — seven children against a cloud model,
     * with no number anywhere — and the user is the one deciding whether planning was worth it.
     */
    cost: Readonly<{input: number; output: number}> | undefined
    /** Set when the run ended badly, so the panel says so instead of sitting on a finished phase. */
    ended: Readonly<{kind: 'stopped' | 'failed'; reason?: string}> | undefined
}>

export const EMPTY_BRIEF_STATE: BriefState = {
    isRunning: false,
    phase: undefined,
    running: undefined,
    step: undefined,
    research: [],
    cost: undefined,
    ended: undefined
}

/**
 * Closes a run whose command has answered.
 *
 * Not an event, because there is no event: the backend announces an ending only when there is one
 * worth reading, and a run that produced a specification announces nothing — the specification is
 * the report, and it is already in the chat. So the command answering is the only news that the last
 * phase was the last one.
 *
 * An ending that was reported is kept, and that is the whole of the branch. The panel is drawn on
 * "running or ended": clearing `isRunning` alone takes a finished plan off screen, which is right,
 * and would take a failed one off screen too — along with the button that is the way out of it.
 */
export function endBriefRun(state: BriefState): BriefState {
    if (state.ended || !state.isRunning) return state
    return {...state, isRunning: false, running: undefined, step: undefined}
}

/** Folds one event into that state. Pure, so what the panel shows is testable without a backend. */
export function applyBriefEvent(state: BriefState, event: BriefEvent): BriefState {
    switch (event.type) {
        case 'brief-started':
            return {...EMPTY_BRIEF_STATE, isRunning: true}
        case 'brief-cost':
            return {...state, cost: {input: event.input, output: event.output}}
        case 'brief-phase-start':
            // The workers are NOT cleared here. Only research has any, so there is nothing to reset
            // between phases — and clearing them emptied the count on a row that still shows it, so
            // a finished research phase read "0/4" beside its own done marker. A fresh run clears
            // everything through `brief-started`, which is the only boundary that matters.
            return {...state, phase: event.phase, running: undefined, step: undefined}
        case 'brief-worker':
            // Only the research workers are named on screen; the other phases are their own row.
            // The step is cleared with them: the previous worker's last line under the next one's
            // name is worse than no line at all, because it reads as this worker's progress.
            return {...state, running: sectionOfWorker(event.label), step: undefined}
        case 'brief-worker-step':
            return {...state, step: event.line || undefined}
        case 'brief-worker-done':
            return state.research.some(worker => worker.section === event.section) ?
                    state
                :   {
                        ...state,
                        running: undefined,
                        step: undefined,
                        research: [...state.research, {section: event.section, kind: event.kind}]
                    }
        // A run ends once. The backend reports an ending of its own for a worker that died without
        // one, and it cannot tell whether the worker got a word in first — so the first ending wins
        // and the safety net stays silent when it is not needed.
        case 'brief-stopped':
            return state.ended ? state : (
                    {
                        ...state,
                        isRunning: false,
                        running: undefined,
                        step: undefined,
                        ended: {kind: 'stopped'}
                    }
                )
        case 'brief-failed':
            return state.ended ? state : (
                    {
                        ...state,
                        isRunning: false,
                        running: undefined,
                        step: undefined,
                        ended: {kind: 'failed', reason: event.reason}
                    }
                )
        default:
            return state
    }
}
