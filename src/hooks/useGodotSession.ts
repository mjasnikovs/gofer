import {useCallback, useEffect, useMemo, useReducer, useRef} from 'react'
import {wait} from '../services/clock'
import {isTauri, listen} from '../services/desktop'
import {
    callGodot,
    getGodotSession,
    startGodotSession,
    stopGodotSession,
    subscribeGodotEvents,
    toGodotError,
    unsubscribeGodotEvents
} from '../services/godot-session'
import {INITIAL_SESSION_VIEW, reduceSession} from '../models/godot-session-state'
import type {GodotCallOptions, GodotSessionState} from '../models/godot'

type GodotSessionOptions = Readonly<{
    onError: (message: string) => void
}>

/** How long a Run waits for a starting editor before giving up on it. */
const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 250
/** The states in which the editor can answer an addon or debug-adapter request. */
const READY_STATES: ReadonlySet<GodotSessionState> = new Set<GodotSessionState>([
    'ready',
    'playing',
    'debugPaused'
])

export type {EditedScene} from '../models/godot-session-state'

/**
 * The renderer's view of the one Gofer-managed editor session: its lifecycle state, the scene the
 * editor currently has open, and the revision every scene mutation has to quote.
 *
 * Panels do not poll. Two epochs are bumped from the addon's own events — one when the edited scene
 * changes, one when the game starts or stops — and a panel refetches when the epoch it depends on
 * moves, so an editor-side change and a Gofer-side change refresh the same way.
 */
export function useGodotSession({onError}: GodotSessionOptions) {
    const [view, dispatch] = useReducer(reduceSession, INITIAL_SESSION_VIEW)
    const subscribed = useRef(false)

    const report = useCallback(
        (error: unknown, action: string) => {
            onError(`${action}: ${toGodotError(error).message}`)
        },
        [onError]
    )

    const call = useCallback(
        (
            command: string,
            params: Readonly<Record<string, unknown>> = {},
            options: GodotCallOptions = {}
        ) => callGodot(command, params, options),
        []
    )

    /**
     * Attaches to the addon's event stream. Rust refuses the subscription while no session is
     * running, which is the ordinary state before the editor starts rather than a failure worth
     * interrupting the user for.
     */
    const subscribe = useCallback(() => {
        if (subscribed.current) return
        subscribed.current = true
        void subscribeGodotEvents(event => {
            if (event.type !== 'rpcEvent') return
            if (event.event === 'scene.changed') {
                const data = event.data
                dispatch({
                    type: 'scene-changed',
                    scene: {
                        path: typeof data['scene'] === 'string' ? data['scene'] : '',
                        revision: Number(data['revision'] ?? 0),
                        dirty: data['dirty'] === true
                    }
                })
            }
            if (event.event === 'runtime.ready' || event.event === 'runtime.stopped')
                dispatch({type: 'runtime-changed'})
        }).catch(() => {
            subscribed.current = false
        })
    }, [])

    const start = useCallback(async () => {
        if (!isTauri()) return
        dispatch({type: 'working'})
        try {
            const started = await startGodotSession()
            dispatch({type: 'started', session: started})
            // Every start subscribes again, because a subscription belongs to the editor it was
            // made for. The stream of the editor that came before is closed with it, and the
            // worker behind it has already stopped; leaving the old one in place meant nothing
            // drained the new editor's events, so nothing ever moved the session past `starting`
            // and the window sat on "Loading the scene tree…" over a perfectly healthy editor.
            subscribed.current = false
            subscribe()
        } catch (error) {
            dispatch({type: 'start-failed'})
            report(error, 'The Godot session could not be started')
        }
    }, [report, subscribe])

    /**
     * Guarantees an editor that can answer, starting one if none is running.
     *
     * The Run control needs this: `start` returns as soon as the process is spawned, but the debug
     * adapter only exists once the editor has finished loading and the addon has reported itself
     * ready. The backend's own view of the session is polled rather than the local state, because
     * readiness arrives on an event this call cannot wait for from inside a render.
     */
    const ensureReady = useCallback(async () => {
        if (!isTauri()) return false
        const running = await getGodotSession().catch(() => undefined)
        if (!running) await start()
        const deadline = Date.now() + READY_TIMEOUT_MS
        while (Date.now() < deadline) {
            const current = await getGodotSession().catch(() => undefined)
            if (current && READY_STATES.has(current.state)) {
                dispatch({type: 'found', session: current})
                return true
            }
            if (!current) break
            await wait(READY_POLL_MS)
        }
        onError('The Godot editor did not become ready, so the game was not launched.')
        return false
    }, [onError, start])

    const stop = useCallback(async () => {
        if (!isTauri()) return
        dispatch({type: 'working'})
        try {
            await stopGodotSession()
            dispatch({type: 'stopped'})
        } catch (error) {
            // A stop that would not go through leaves the session as it was: saying it is offline
            // when it is still running is worse than saying nothing.
            dispatch({type: 'settled'})
            report(error, 'The Godot session could not be stopped')
        } finally {
            subscribed.current = false
            void unsubscribeGodotEvents().catch(() => undefined)
        }
    }, [report])

    // A renderer reload finds whatever session the backend still supervises.
    useEffect(() => {
        if (!isTauri()) return
        let cancelled = false
        void getGodotSession()
            .then(current => {
                if (cancelled || !current) return
                dispatch({type: 'found', session: current})
                subscribe()
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [subscribe])

    // Lifecycle transitions ride a global event rather than the channel: they are rare, and the
    // renderer needs them even before it has subscribed to the addon's own stream.
    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let unlisten: (() => void) | undefined
        void listen('godot-session-event', received => {
            if (isCancelled) return
            if (received.payload.type !== 'stateChanged') return
            dispatch({type: 'state-changed', state: received.payload.state})
        }).then(cancel => {
            // The disposer can arrive after the effect has already torn down — StrictMode
            // guarantees it on every development mount — so a late one is disposed on arrival.
            if (isCancelled) cancel()
            else unlisten = cancel
        })
        return () => {
            isCancelled = true
            unlisten?.()
        }
    }, [])

    useEffect(
        () => () => {
            if (subscribed.current) void unsubscribeGodotEvents().catch(() => undefined)
        },
        []
    )

    return useMemo(
        () => ({...view, call, ensureReady, start, stop}),
        [call, ensureReady, start, stop, view]
    )
}
