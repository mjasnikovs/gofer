import type {DebugScope, DebugStackFrame, DebugStopped, DebugVariable, GodotError} from './godot'

export type ScopeVariables = Readonly<{
    scope: DebugScope
    variables: readonly DebugVariable[]
}>

/**
 * Everything the debugger panel shows, as one value.
 *
 * Kept whole and kept out of React so the panel's behaviour is a pure function of this and an
 * action. The rule the whole thing exists to keep is that stopping is an event rather than an
 * answer: the stack, the scopes and the variables are only ever read for a debuggee that has
 * actually stopped, so every resume clears them in one move rather than leaving the last stop's
 * frames on screen under a game that is running again.
 */
export type DebugPanel = Readonly<{
    /** Where the debuggee is stopped, or absent while it is running. */
    stopped?: DebugStopped | undefined
    frames: readonly DebugStackFrame[]
    frameId?: number | undefined
    scopes: readonly ScopeVariables[]
    isLaunched: boolean
    /**
     * How many requests the user is waiting on.
     *
     * A count rather than a flag because they overlap: reading a frame's scopes issues one request
     * per scope, and the controls must not come back to life between them. Waiting for the next
     * stop is deliberately not counted — that is the debugger listening, not the user waiting, and
     * counting it disabled Pause for the whole length of the wait Pause exists to end.
     */
    running: number
    error?: GodotError | undefined
}>

export type DebugAction =
    /** A request the user is waiting on has started. */
    | Readonly<{type: 'began'}>
    /** …and has finished, however it finished. */
    | Readonly<{type: 'ended'}>
    /** Any request answered, which retires whatever failure was on screen. */
    | Readonly<{type: 'succeeded'}>
    | Readonly<{type: 'failed'; error: GodotError}>
    | Readonly<{type: 'launched'}>
    | Readonly<{type: 'stopped'; stop: DebugStopped}>
    /** The stack of the current stop. The top frame is the one whose scopes are read next. */
    | Readonly<{type: 'stack-read'; frames: readonly DebugStackFrame[]}>
    | Readonly<{type: 'scopes-read'; scopes: readonly ScopeVariables[]}>
    | Readonly<{type: 'frame-chosen'; frameId: number}>
    /** The game is running again, so nothing read at the last stop is true any more. */
    | Readonly<{type: 'resuming'}>
    /** The debuggee is gone: ended on its own, or terminated from the toolbar. */
    | Readonly<{type: 'finished'}>

export const INITIAL_DEBUG_PANEL: DebugPanel = {
    frames: [],
    scopes: [],
    isLaunched: false,
    running: 0
}

/** Whether the panel's controls should be disabled: something the user asked for is in flight. */
export function isDebugBusy(state: DebugPanel) {
    return state.running > 0
}

/** Nothing read at a stop survives the game resuming. */
const AT_NO_STOP = {
    stopped: undefined,
    frames: [],
    frameId: undefined,
    scopes: []
} as const

export function reduceDebug(state: DebugPanel, action: DebugAction): DebugPanel {
    switch (action.type) {
        case 'began':
            return {...state, running: state.running + 1}

        // Never below zero: a count that can go negative leaves the controls disabled for the rest
        // of the session, with nothing on screen to say why.
        case 'ended':
            return {...state, running: Math.max(state.running - 1, 0)}

        case 'succeeded':
            return state.error === undefined ? state : {...state, error: undefined}

        case 'failed':
            return {...state, error: action.error}

        case 'launched':
            return {...state, ...AT_NO_STOP, isLaunched: true}

        case 'stopped':
            return {...state, stopped: action.stop}

        // The top frame is chosen with the stack: a stack with no frame selected shows variables
        // belonging to nothing.
        case 'stack-read': {
            const top = action.frames[0]
            return {
                ...state,
                frames: action.frames,
                frameId: top?.id,
                scopes: top ? state.scopes : []
            }
        }

        case 'scopes-read':
            return {...state, scopes: action.scopes}

        case 'frame-chosen':
            return {...state, frameId: action.frameId}

        case 'resuming':
            return {...state, ...AT_NO_STOP}

        case 'finished':
            return {...state, ...AT_NO_STOP, isLaunched: false}
    }
}
