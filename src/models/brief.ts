import type {Sketch} from './sketch'

export const BRIEF_PHASES = ['refine', 'research', 'grill', 'compose'] as const

export type BriefPhase = (typeof BRIEF_PHASES)[number]

const PHASES = new Set<string>(BRIEF_PHASES)

export const BRIEF_PHASE_FIELDS: Readonly<Record<BriefPhase, string>> = {
    refine: 'refined',
    research: 'research',
    grill: 'qa',
    compose: 'spec'
}

type LastPhase =
    typeof BRIEF_PHASES extends readonly [...unknown[], infer Last extends BriefPhase] ? Last
    :   never

export const SPECIFICATION_FIELD =
    BRIEF_PHASE_FIELDS[BRIEF_PHASES[BRIEF_PHASES.length - 1] as LastPhase]

export const BRIEF_PHASE_LABELS: Readonly<Record<BriefPhase, string>> = {
    refine: 'Sharpening the ask',
    research: 'Reading the project',
    grill: 'Settling the questions',
    compose: 'Writing the spec'
}

export const RESEARCH_SECTIONS = ['FILES', 'APIS', 'CONTEXT', 'TOOLING'] as const

export const BRIEF_STATUSES = ['running', 'done', 'failed', 'stopped'] as const

export type BriefStatus = (typeof BRIEF_STATUSES)[number]

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

export type BriefAnswer = Readonly<{
    question: string
    answer: string
    from: 'research' | 'user' | 'skipped' | 'open'
}>

export type BriefEvent =
    | Readonly<{type: 'brief-started'}>
    | Readonly<{type: 'brief-phase-start'; phase: BriefPhase}>
    | Readonly<{type: 'brief-phase'; phase: BriefPhase; field: string; value: string}>
    | Readonly<{type: 'brief-worker'; label: string}>
    | Readonly<{type: 'brief-worker-step'; label: string; line: string; steps: number}>
    | Readonly<{type: 'brief-worker-done'; section: string; kind: string}>
    | Readonly<{type: 'brief-question-settled'; question: string; outcome: string}>
    | Readonly<{type: 'brief-cost'; input: number; output: number}>
    | Readonly<{type: 'brief-log'; message: string}>
    | Readonly<{type: 'brief-stopped'; phase: string}>
    | Readonly<{type: 'brief-failed'; phase: string; reason: string}>

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

export function isBriefEvent(value: unknown): value is BriefEvent {
    if (typeof value !== 'object' || value === null) return false
    const {type, phase} = value as {type?: unknown; phase?: unknown}
    if (typeof type !== 'string' || !EVENT_TYPES.has(type)) return false
    if (type !== 'brief-phase' && type !== 'brief-phase-start') return true
    return typeof phase === 'string' && PHASES.has(phase)
}

export type UserQuestionPrompt = Readonly<{
    questionId: string
    question: string
    options: readonly string[]
    sketches: readonly Sketch[]
    why: string
    revision: number
    ownerCallId?: string
    isDelegated: boolean
}>

export type UserQuestionResponse = Readonly<{
    questionId: string
    answer?: string
    picked?: number
    blocked?: readonly string[]
    skipped?: boolean
    approved?: boolean
    again?: boolean
}>

export type UserQuestionSettled = Readonly<{
    questionId: string
    answered: boolean
}>

export type ResearchWorker = Readonly<{
    section: string
    kind: string
}>

export const WORKER_KINDS = ['ok', 'empty', 'runaway'] as const

export const WORKER_OUTCOME_LABELS: Readonly<Record<string, string>> = {
    empty: 'nothing to report',
    runaway: 'cut short'
}

export function sectionOfWorker(label: string): string | undefined {
    return label.startsWith('worker:') ? label.slice('worker:'.length).toUpperCase() : undefined
}

export type BriefState = Readonly<{
    isRunning: boolean
    phase: BriefPhase | undefined
    running: string | undefined
    step: string | undefined
    research: readonly ResearchWorker[]
    cost: Readonly<{input: number; output: number}> | undefined
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

export function endBriefRun(state: BriefState): BriefState {
    if (state.ended || !state.isRunning) return state
    return {...state, isRunning: false, running: undefined, step: undefined}
}

export function applyBriefEvent(state: BriefState, event: BriefEvent): BriefState {
    switch (event.type) {
        case 'brief-started':
            return {...EMPTY_BRIEF_STATE, isRunning: true}
        case 'brief-cost':
            return {...state, cost: {input: event.input, output: event.output}}
        case 'brief-phase-start':
            return {...state, phase: event.phase, running: undefined, step: undefined}
        case 'brief-worker':
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
