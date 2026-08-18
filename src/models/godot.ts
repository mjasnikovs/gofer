/**
 * The wire shapes the Godot session commands exchange with Rust and, through it, with the staged
 * addon. They mirror `src-tauri/src/godot_session_api.rs`, `src-tauri/src/debug.rs`,
 * `src-tauri/src/godot_session.rs`, and `src-tauri/addon/protocol.gd`.
 */

import type {CommandError} from './errors'

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

/**
 * Whether a session in this state can answer a panel's read.
 *
 * `offline` and `error` have no editor at all. `staging`, `starting`, and `importing` have one that
 * is still coming up: it answers, but it answers with nothing, because the editor has not opened the
 * scene it opens for itself yet. That empty answer would then be kept — nothing refetches on a state
 * change, only on the scene's own events — and a panel would go on reporting "No scene is open" over
 * a project that has one. Waiting until the session can answer is what makes an empty panel mean the
 * project rather than the clock.
 */
export function isSessionReadable(state: GodotSessionState) {
    return state === 'ready' || state === 'playing' || state === 'debugPaused'
}

/**
 * Whether there is no editor at all, as opposed to one that cannot answer yet.
 *
 * The difference is what a panel draws: offline is a workspace with nothing running and an offer to
 * start it, while staging, starting, and importing are a workspace that is on its way and should
 * say so rather than offer to start a second one.
 */
export function isSessionOffline(state: GodotSessionState) {
    return state === 'offline' || state === 'error'
}

/**
 * Whether the editor is running a game, taken from the editor rather than from what Gofer launched.
 *
 * A game stopped on a breakpoint is still a game the editor is running, which is why this is not
 * `state === 'playing'`. Godot reports the transition itself, so a game that crashed, ended on its
 * own, or was closed from its own window stops counting here without anything being told.
 */
export function isSessionPlaying(state: GodotSessionState) {
    return state === 'playing' || state === 'debugPaused'
}

export type GodotSessionSummary = Readonly<{
    /** Names the editor session; stored run logging is keyed by it. */
    sessionId: string
    state: GodotSessionState
    rpcAddress: string
    lspPort: number
    dapPort: number
    godotVersion: string | undefined
    worktree: string
}>

// The backend reserves a request body for future start options; today it carries no fields.
export type StartGodotSessionRequest = Readonly<Record<string, never>>

/** The optimistic-concurrency and deadline options every addon call may carry. */
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

/**
 * A value the addon tagged on its way out. Everything the editor can rebuild round-trips; a live
 * object reference and anything else become read-only descriptions.
 */
export type GodotValue = Readonly<{
    type: string
    value: unknown
}>

/** One node of an edited or a running scene tree. Both halves encode the same summary. */
export type GodotNode = Readonly<{
    name: string
    type: string
    /**
     * The class whose editor icon this node is drawn with — its own script class where it has one,
     * its engine class otherwise. Older addons do not send it; the type stands in then.
     */
    icon?: string | undefined
    path: string
    children: readonly GodotNode[]
}>

/**
 * Editor icons for the classes a tree asked about, PNG, base64, keyed by class name. A class the
 * editor theme has no artwork for is absent rather than empty, and an addon too old to know the
 * command answers without the map at all.
 */
export type GodotClassIcons = Readonly<{
    encoding: 'png-base64'
    icons?: Readonly<Record<string, string>> | undefined
}>

export type GodotSceneTree = Readonly<{
    root: GodotNode | null
    /** The edited scene's revision, which every mutation has to send back as `expectedRevision`. */
    revision?: number | undefined
    /** Only the runtime half truncates: a remote dump stops at 2048 nodes or 32 levels. */
    truncated?: boolean | undefined
}>

/**
 * One connection the edited scene keeps, from a node's signal to a method on another node.
 *
 * Only the scene's own wiring is reported. The editor is itself connected to every node it is
 * showing, and those connections belong to the dock drawing the tree rather than to the game.
 */
export type GodotNodeConnection = Readonly<{
    signal: string
    /** The node carrying the method, as the scene names it. */
    target: string
    method: string
    /** Extra arguments passed after the signal's own, tagged the way every protocol value is. */
    binds?: readonly GodotValue[] | undefined
    deferred?: boolean | undefined
    oneShot?: boolean | undefined
    persistent?: boolean | undefined
}>

export type GodotNodeDetails = Readonly<{
    name: string
    type: string
    path: string
    groups?: readonly string[] | undefined
    /** Every signal the node can emit. The running game's half of an inspection carries none. */
    signals?: readonly string[] | undefined
    connections?: readonly GodotNodeConnection[] | undefined
    properties?: Readonly<Record<string, GodotValue>> | undefined
}>

export type GodotSetting = Readonly<{
    name: string
    value: GodotValue
    /** Project settings only; the editor's own settings apply immediately. */
    restartRequired?: boolean | undefined
}>

export type GodotSettingsPage = Readonly<{
    settings: readonly GodotSetting[]
    totalMatches: number
    truncated: boolean
}>

/** What `project.get_settings` answers: the project's identity and the scene it runs. */
export type GodotProjectSettings = Readonly<{
    projectName: string
    mainScene: string
    renderingMethod: string
}>

/** A captured viewport frame: PNG, base64, at most 1920 px on the longest edge. */
export type GodotFrame = Readonly<{
    encoding: string
    width: number
    height: number
    data: string
}>

/**
 * A question the editor has put to a person and is waiting on: its title bar, its text, and the
 * buttons it is offering. Reported because nothing else says it — commands are still answered
 * while one is up, and on a desktop the dialog is a native window a screenshot of the editor need
 * not contain.
 */
export type GodotEditorDialog = Readonly<{
    title: string
    text: string
    buttons: readonly string[]
}>

export type GodotSessionStatus = Readonly<{
    state: string
    scene: string
    revision: number
    dirty: boolean
    canUndo: boolean
    canRedo: boolean
    dialog?: GodotEditorDialog | null
}>

/**
 * The structured failure every Godot session command rejects with — the same shape every other
 * command now uses, kept under this name where the code being read is a session code.
 */
export type GodotError = CommandError

export type GodotLogSeverity = 'info' | 'warning' | 'error'

/** The editor's two pipes. The game the editor launched inherits them. */
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
    /** Lines the ring buffer discarded. A cursor older than the oldest line resumes silently. */
    dropped: number
}>

/** A full-text query over the stored warning and error history of every recorded run. */
export type GodotLogSearchRequest = Readonly<{
    query: string
    limit?: number | undefined
}>

/**
 * One archived log event. `sessionId` is absent for runs recorded before Gofer managed the editor
 * session itself, which is how history predating that change stays readable.
 */
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
    | Readonly<{op: 'breakpoints'; breakpoints: readonly DebugVerifiedBreakpoint[]}>
    | Readonly<{op: 'launched'; breakpoints: readonly DebugVerifiedBreakpoint[]}>
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

/** One ranked documentation passage. `retrieve()` exposes no URL, so a citation names a chapter. */
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
