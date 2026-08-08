import type {GodotSessionState, GodotSessionSummary} from './godot'

/** What the edited scene is, as the addon's own events report it. */
export type EditedScene = Readonly<{
    path: string
    revision: number
    dirty: boolean
}>

/**
 * The renderer's whole view of the one Gofer-managed editor session.
 *
 * The two epochs are what keep the panels from polling. Each is a counter the panels depend on
 * rather than a copy of the thing that changed: a panel refetches when its epoch moves, so an
 * editor-side change and a Gofer-side change refresh the same way and neither has to be described
 * to the panel that cares.
 */
export type SessionView = Readonly<{
    session?: GodotSessionSummary | undefined
    state: GodotSessionState
    scene?: EditedScene | undefined
    /** Whether something the user pressed is still in flight. */
    isBusy: boolean
    /** Bumped when the editor's edited scene changes. */
    sceneEpoch: number
    /** Bumped when the game starts or stops. */
    runtimeEpoch: number
}>

export type SessionAction =
    /** A start or a stop the user pressed has begun. */
    | Readonly<{type: 'working'}>
    | Readonly<{type: 'started'; session: GodotSessionSummary}>
    | Readonly<{type: 'start-failed'}>
    /** Work finished without changing anything: a stop that would not go through. */
    | Readonly<{type: 'settled'}>
    | Readonly<{type: 'stopped'}>
    /** A session the backend was already supervising, found on a renderer reload or by a wait. */
    | Readonly<{type: 'found'; session: GodotSessionSummary}>
    /** The lifecycle event Rust raises. It carries no summary — only where the session got to. */
    | Readonly<{type: 'state-changed'; state: GodotSessionState}>
    | Readonly<{type: 'scene-changed'; scene: EditedScene}>
    | Readonly<{type: 'runtime-changed'}>

export const INITIAL_SESSION_VIEW: SessionView = {
    state: 'offline',
    isBusy: false,
    sceneEpoch: 0,
    runtimeEpoch: 0
}

/** The states in which the game is running, and so the states a runtime panel must refetch in. */
const RUNTIME_STATES: ReadonlySet<GodotSessionState> = new Set<GodotSessionState>([
    'playing',
    'ready'
])

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

        /*
         * The scene goes with the session. An editor that has stopped is not editing anything, and
         * a scene path left behind would have the inspector reading a scene against an editor that
         * no longer exists — which the addon answers, correctly, with "not found in the edited
         * scene".
         */
        case 'stopped':
            return {
                ...state,
                session: undefined,
                state: 'offline',
                scene: undefined,
                isBusy: false
            }

        case 'found':
            return {...state, session: action.session, state: action.session.state}

        // Bumped on every arrival at a running state rather than on a change into one: a restart
        // passes through the same state again, and a runtime panel still holding the last game's
        // readings has to go and ask.
        case 'state-changed':
            return {
                ...state,
                state: action.state,
                runtimeEpoch:
                    RUNTIME_STATES.has(action.state) ? state.runtimeEpoch + 1 : state.runtimeEpoch
            }

        case 'scene-changed':
            return {...state, scene: action.scene, sceneEpoch: state.sceneEpoch + 1}

        case 'runtime-changed':
            return {...state, runtimeEpoch: state.runtimeEpoch + 1}
    }
}
