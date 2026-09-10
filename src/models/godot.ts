import type {CommandError} from './errors'

// The protocol's own shapes, generated from `protocol/schemas/v2/params.json` beside the answers
// that carry them. Re-exported here so a renderer keeps importing Godot's model from one place.
export type {GodotFrame, GodotNode, GodotNodeConnection, GodotValue} from './godot-commands'

export type GodotSessionState =
    | 'offline'
    | 'staging'
    | 'starting'
    | 'importing'
    | 'ready'
    | 'playing'
    | 'debugPaused'
    | 'stopping'
    | 'error'

export function isSessionReadable(state: GodotSessionState) {
    return state === 'ready' || state === 'playing' || state === 'debugPaused'
}

export function isSessionOffline(state: GodotSessionState) {
    return state === 'offline' || state === 'error'
}

export function isSessionPlaying(state: GodotSessionState) {
    return state === 'playing' || state === 'debugPaused'
}

export type GodotSessionSummary = Readonly<{
    sessionId: string
    state: GodotSessionState
    rpcAddress: string
    lspPort: number
    dapPort: number
    godotVersion: string | undefined
    worktree: string
}>

export type StartGodotSessionRequest = Readonly<Record<string, never>>

export type GodotCallOptions = Readonly<{
    expectedRevision?: number | undefined
    timeoutMs?: number | undefined
}>

export type CallGodotRequest = Readonly<{
    command: string
    params: Readonly<Record<string, unknown>>
    expectedRevision?: number | undefined
    timeoutMs?: number | undefined
}>

export type CallGodotResponse = Readonly<{
    id: string
    result: Readonly<Record<string, unknown>>
    revision?: number | undefined
}>

export type GodotSessionEvent =
    | Readonly<{type: 'stateChanged'; state: GodotSessionState}>
    | Readonly<{
          type: 'rpcEvent'
          sequence: number
          event: string
          data: Readonly<Record<string, unknown>>
      }>

export type GodotError = CommandError

export type GodotLogSeverity = 'info' | 'warning' | 'error'

export type GodotLogSource = 'editor' | 'editorError'

export type GodotLogEntry = Readonly<{
    sequence: number
    source: GodotLogSource
    severity: GodotLogSeverity
    message: string
    timestamp: number
}>

export type GodotLogQuery = Readonly<{
    after?: number | undefined
    minSeverity?: GodotLogSeverity | undefined
    source?: GodotLogSource | undefined
    contains?: string | undefined
    limit?: number | undefined
}>

export type GodotLogPage = Readonly<{
    entries: readonly GodotLogEntry[]
    cursor: number
    dropped: number
}>

export type GodotLogSearchRequest = Readonly<{
    query: string
    limit?: number | undefined
}>

export type GodotLogSearchHit = Readonly<{
    runId: string
    sessionId?: string | undefined
    taskId?: string | undefined
    timestamp: number
    level: string
    source?: string | undefined
    message: string
}>

export type DebugStopped = Readonly<{
    reason: string
    threadId?: number | undefined
    description?: string | undefined
    text?: string | undefined
    allThreadsStopped: boolean
}>

export type DebugStackFrame = Readonly<{
    id: number
    name: string
    line: number
    column: number
    path?: string | undefined
}>

export type DebugScope = Readonly<{
    name: string
    presentationHint?: string | undefined
    variablesReference: number
    expensive: boolean
}>

export type DebugVariable = Readonly<{
    name: string
    value: string
    type?: string | undefined
    variablesReference: number
}>

export type DebugVerifiedBreakpoint = Readonly<{
    path: string
    line?: number | undefined
    verified: boolean
    message?: string | undefined
}>

export type DebugSourceBreakpoints = Readonly<{
    path: string
    lines: readonly number[]
}>

export type DebugStepOutcome =
    | Readonly<{kind: 'steppedOut'; stop: DebugStopped}>
    | Readonly<{kind: 'interrupted'; stop: DebugStopped}>
    | Readonly<{kind: 'resumed'}>
    | Readonly<{kind: 'terminated'}>

export type DebugRequest =
    | Readonly<{op: 'status'}>
    | Readonly<{op: 'setBreakpoints'; path: string; lines: readonly number[]}>
    | Readonly<{
          op: 'launch'
          playArgs?: readonly string[]
          breakpoints: readonly DebugSourceBreakpoints[]
      }>
    | Readonly<{op: 'attach'}>
    | Readonly<{op: 'stackTrace'; threadId?: number | undefined}>
    | Readonly<{op: 'scopes'; frameId: number}>
    | Readonly<{op: 'variables'; variablesReference: number}>
    | Readonly<{op: 'evaluate'; expression: string; frameId?: number | undefined}>
    | Readonly<{op: 'continue'; threadId?: number | undefined}>
    | Readonly<{op: 'pause'; threadId?: number | undefined}>
    | Readonly<{op: 'stepOver'; threadId?: number | undefined}>
    | Readonly<{op: 'stepIn'; threadId?: number | undefined}>
    | Readonly<{op: 'stepOut'; threadId?: number | undefined}>
    | Readonly<{op: 'awaitStop'; timeoutMs?: number | undefined}>
    | Readonly<{op: 'restart'}>
    | Readonly<{op: 'terminate'}>

export type DebugResponse =
    | Readonly<{op: 'status'; capabilities: Readonly<Record<string, unknown>>}>
    | Readonly<{
          op: 'breakpoints'
          breakpoints: readonly DebugVerifiedBreakpoint[]
          /** Every breakpoint the session still holds, across every file. Absent when none do. */
          armed?: readonly string[] | undefined
      }>
    | Readonly<{
          op: 'launched'
          breakpoints: readonly DebugVerifiedBreakpoint[]
          /** Every breakpoint the session still holds, across every file. Absent when none do. */
          armed?: readonly string[] | undefined
      }>
    | Readonly<{op: 'attached'}>
    | Readonly<{op: 'threads'; threads: readonly Readonly<{id: number; name: string}>[]}>
    | Readonly<{op: 'stackTrace'; frames: readonly DebugStackFrame[]}>
    | Readonly<{op: 'scopes'; scopes: readonly DebugScope[]}>
    | Readonly<{op: 'variables'; variables: readonly DebugVariable[]}>
    | Readonly<{
          op: 'evaluate'
          result: string
          type?: string | undefined
          variablesReference: number
      }>
    | Readonly<{op: 'continued'; allThreads: boolean}>
    | Readonly<{op: 'acknowledged'}>
    | Readonly<{op: 'stepped'; outcome: DebugStepOutcome}>
    | Readonly<{op: 'stopped'; stopped: DebugStopped | null}>

export type DocsPassage = Readonly<{
    text: string
    chapter: string
    order: number
    score: number
}>

export type DocsQuery = Readonly<{
    question: string
    maxPassages?: number | undefined
    maxTextChars?: number | undefined
}>

export type DocsResponse = Readonly<{passages: readonly DocsPassage[]}>
