import type {GodotSessionState, GodotSessionSummary} from './godot'

export type EditedScene = Readonly<{
    path: string
    revision: number
    dirty: boolean
}>

export type SessionView = Readonly<{
    session?: GodotSessionSummary | undefined
    state: GodotSessionState
    scene?: EditedScene | undefined
    isBusy: boolean
    sceneEpoch: number
    runtimeEpoch: number
}>

export type SessionAction =
    | Readonly<{type: 'working'}>
    | Readonly<{type: 'started'; session: GodotSessionSummary}>
    | Readonly<{type: 'start-failed'}>
    | Readonly<{type: 'settled'}>
    | Readonly<{type: 'stopped'}>
    | Readonly<{type: 'found'; session: GodotSessionSummary}>
    | Readonly<{type: 'state-changed'; state: GodotSessionState}>
    | Readonly<{type: 'scene-changed'; scene: EditedScene}>
    | Readonly<{type: 'scene-observed'; scene: EditedScene}>
    | Readonly<{type: 'runtime-changed'}>

export const INITIAL_SESSION_VIEW: SessionView = {
    state: 'offline',
    isBusy: false,
    sceneEpoch: 0,
    runtimeEpoch: 0
}

const RUNTIME_STATES: ReadonlySet<GodotSessionState> = new Set<GodotSessionState>([
    'playing',
    'ready'
])

function isOffline(state: SessionView): boolean {
    return (
        state.session === undefined
        && state.state === 'offline'
        && state.scene === undefined
        && !state.isBusy
    )
}

export function reduceSession(state: SessionView, action: SessionAction): SessionView {
    switch (action.type) {
        case 'working':
            return {...state, isBusy: true}

        case 'started':
            return {
                ...state,
                session: action.session,
                state: action.session.state,
                isBusy: false
            }

        case 'start-failed':
            return {...state, state: 'error', isBusy: false}

        case 'settled':
            return state.isBusy ? {...state, isBusy: false} : state

        case 'stopped':
            return isOffline(state) ? state : (
                    {
                        ...state,
                        session: undefined,
                        state: 'offline',
                        scene: undefined,
                        isBusy: false
                    }
                )

        case 'found':
            return (
                    state.session?.sessionId === action.session.sessionId
                        && state.state === action.session.state
                ) ?
                    state
                :   {...state, session: action.session, state: action.session.state}

        case 'state-changed':
            return {
                ...state,
                state: action.state,
                runtimeEpoch:
                    RUNTIME_STATES.has(action.state) ? state.runtimeEpoch + 1 : state.runtimeEpoch
            }

        case 'scene-changed':
            return {...state, scene: action.scene, sceneEpoch: state.sceneEpoch + 1}

        case 'scene-observed':
            return state.scene ? state : {...state, scene: action.scene}

        case 'runtime-changed':
            return {...state, runtimeEpoch: state.runtimeEpoch + 1}
    }
}
