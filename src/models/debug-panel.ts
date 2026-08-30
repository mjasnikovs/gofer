import type {DebugScope, DebugStackFrame, DebugStopped, DebugVariable, GodotError} from './godot'

export type ScopeVariables = Readonly<{
    scope: DebugScope
    variables: readonly DebugVariable[]
}>

export type DebugPanel = Readonly<{
    stopped?: DebugStopped | undefined
    frames: readonly DebugStackFrame[]
    frameId?: number | undefined
    scopes: readonly ScopeVariables[]
    isLaunched: boolean
    running: number
    error?: GodotError | undefined
}>

export type DebugAction =
    | Readonly<{type: 'began'}>
    | Readonly<{type: 'ended'}>
    | Readonly<{type: 'succeeded'}>
    | Readonly<{type: 'failed'; error: GodotError}>
    | Readonly<{type: 'launched'}>
    | Readonly<{type: 'stopped'; stop: DebugStopped}>
    | Readonly<{type: 'stack-read'; frames: readonly DebugStackFrame[]}>
    | Readonly<{type: 'scopes-read'; scopes: readonly ScopeVariables[]}>
    | Readonly<{type: 'frame-chosen'; frameId: number}>
    | Readonly<{type: 'resuming'}>
    | Readonly<{type: 'finished'}>

export const INITIAL_DEBUG_PANEL: DebugPanel = {
    frames: [],
    scopes: [],
    isLaunched: false,
    running: 0
}

export function isDebugBusy(state: DebugPanel) {
    return state.running > 0
}

export function whileTheGameRuns(state: DebugPanel, isPlaying: boolean): DebugPanel {
    if (isPlaying || !state.isLaunched) return state
    return {...state, ...AT_NO_STOP, isLaunched: false}
}

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
