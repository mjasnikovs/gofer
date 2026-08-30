export type MemoryKind = 'decision' | 'preference' | 'fact' | 'issue' | 'summary'

export type MemoryState = 'candidate' | 'confirmed' | 'superseded'

export type MemoryCheck = 'unchecked' | 'unanchored' | 'intact' | 'stale'

export type MemoryAnchor = Readonly<{
    named: string
    resolved?: string | undefined
}>

export type MemoryJudgement = Readonly<{
    verdict: MemoryVerdict
    reason: string
    at: number
    model: string
    isCurrent: boolean
}>

export type MemoryVerdict = 'holds' | 'broken' | 'unclear'

export type MemoryJudgeEvent = Readonly<{
    type: 'judge-started' | 'judge-step' | 'judge-verdict' | 'judge-failed' | 'judge-stopped'
    memoryId: string
    line?: string | undefined
    verdict?: MemoryVerdict | undefined
    reason?: string | undefined
}>

export type MemorySweepEvent = Readonly<{
    type: 'sweep-progress' | 'sweep-finished' | 'sweep-stopped'
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
    check: MemoryCheck
    anchors: readonly MemoryAnchor[]
    judgement?: MemoryJudgement | undefined
}>

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

export function missingAnchors(memory: ProjectMemory): readonly string[] {
    return memory.anchors
        .filter(anchor => anchor.resolved === undefined)
        .map(anchor => anchor.named)
}

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

export function isRetrievable(memory: ProjectMemory): boolean {
    return memory.state === 'confirmed'
}

export function isBroken(memory: ProjectMemory): boolean {
    return memory.judgement?.verdict === 'broken' && memory.judgement.isCurrent
}

export function isUnjudged(memory: ProjectMemory): boolean {
    return memory.judgement?.isCurrent !== true
}

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

export function isMemorySweepEvent(value: unknown): value is MemorySweepEvent {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Partial<MemorySweepEvent>
    if (typeof candidate.done !== 'number' || typeof candidate.total !== 'number') return false
    return SWEEP_EVENTS.some(name => name === candidate.type)
}

export function isMemoryJudgeEvent(value: unknown): value is MemoryJudgeEvent {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Partial<MemoryJudgeEvent>
    if (typeof candidate.memoryId !== 'string') return false
    return JUDGE_EVENTS.some(name => name === candidate.type)
}
