import {useCallback, useEffect, useMemo, useReducer, useRef} from 'react'
import {repeat, wait} from '../services/clock'
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
import {isSessionReadable} from '../models/godot'
import type {EditorSession} from './useEditorSession'

type GodotSessionOptions = Readonly<{
    onError: (message: string) => void
}>

/** How long a Run waits for a starting editor before giving up on it. */
const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 250
/** How often the renderer re-reads the backend's own view of the session. */
export const RECONCILE_MS = 1_000

export type {EditedScene} from '../models/godot-session-state'

/**
 * The renderer's view of the one Gofer-managed editor session: its lifecycle state, the scene the
 * editor currently has open, and the revision every scene mutation has to quote.
 *
 * Panels do not poll. Two epochs are bumped from the addon's own events — one when the edited scene
 * changes, one when the game starts or stops — and a panel refetches when the epoch it depends on
 * moves, so an editor-side change and a Gofer-side change refresh the same way.
 */
export function useGodotSession({onError}: GodotSessionOptions): EditorSession {
    const [view, dispatch] = useReducer(reduceSession, INITIAL_SESSION_VIEW)
    /** The session the addon stream is attached to, or nothing while it is attached to none. */
    const subscribedTo = useRef<string | undefined>(undefined)
    // Read by the reconcile tick, which must not be rebuilt every time the view changes.
    const latest = useRef(view)
    useEffect(() => {
        latest.current = view
    }, [view])

    const report = useCallback(
        (error: unknown, action: string) => {
            onError(`${action}: ${toGodotError(error).message}`)
        },
        [onError]
    )

    /**
     * Attaches to the addon's event stream, once per session.
     *
     * A subscription belongs to the editor it was made for, so it is keyed by that editor's id: the
     * same session never resubscribes, and a new one always does. Rust refuses the subscription
     * while the editor has no RPC channel yet, which is the ordinary state of a session that is
     * still starting rather than a failure worth interrupting the user for — the refusal clears the
     * key, and the reconcile tick asks again a moment later.
     */
    const subscribe = useCallback((sessionId: string) => {
        if (subscribedTo.current === sessionId) return
        subscribedTo.current = sessionId
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
            if (subscribedTo.current === sessionId) subscribedTo.current = undefined
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
            // The key is cleared rather than compared: a start is the one moment the editor behind
            // a session is known to be new, whatever the backend calls it.
            subscribedTo.current = undefined
            subscribe(started.sessionId)
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
            if (current && isSessionReadable(current.state)) {
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
            subscribedTo.current = undefined
            void unsubscribeGodotEvents().catch(() => undefined)
        }
    }, [report])

    /*
     * Reconciles the renderer's copy against the backend, which is the only thing that knows
     * whether an editor exists.
     *
     * The copy used to be read once on mount and then written only by this window's own Start and
     * Stop and by the addon's event stream. Everything else that moves the session — an agent turn
     * starting the editor, a task switch releasing the worktree, a subscription that was refused
     * because the editor was still coming up, so no event ever arrived at all — moved it behind the
     * window's back, and the copy said offline over a running editor until the renderer reloaded.
     * Asking on a tick is also how an editor that exited on its own is noticed: `get_session` is
     * where Rust looks for that, and it only looks when it is called.
     *
     * The tick comes from the shared clock rather than from `setInterval`, like every other delay
     * in Gofer. It was the one poll that did not, and a real one-second timer inside a test is a
     * race the test cannot see: a panel that had been offline for a whole second by the time a
     * click landed disabled the control the click was aimed at, and the test failed on how busy
     * the machine was. The first reconcile is called here rather than left to the tick, so a test
     * still discovers the session it starts without asking for a poll at all.
     */
    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let isReading = false

        const reconcile = async () => {
            // A start or a stop the user pressed owns the state until the command answers.
            if (isReading || latest.current.isBusy) return
            isReading = true
            const current = await getGodotSession().catch(() => undefined)
            isReading = false
            if (isCancelled) return
            if (current) {
                dispatch({type: 'found', session: current})
                subscribe(current.sessionId)
                return
            }
            if (subscribedTo.current !== undefined) {
                subscribedTo.current = undefined
                void unsubscribeGodotEvents().catch(() => undefined)
            }
            dispatch({type: 'stopped'})
        }

        void reconcile()
        const stopReconciling = repeat(() => void reconcile(), RECONCILE_MS)
        return () => {
            isCancelled = true
            stopReconciling()
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

    /*
     * Asks the editor what it is editing, once, when nothing has told us.
     *
     * `scene` is filled by the addon's `scene.changed` event, and an editor that was already
     * editing something when Gofer attached never raises one — so the session knew its state, its
     * ports and its worktree, and not the one fact every panel needs. The frame repaired it for
     * itself with a `session.get_state` reading and a `??` chain, which meant the inspector could
     * be handed a scene assembled beside the session rather than one belonging to it.
     */
    useEffect(() => {
        if (!isTauri()) return
        if (!isSessionReadable(view.state) || view.scene !== undefined) return
        let isCancelled = false
        void callGodot('session.get_state', {})
            .then(status => {
                if (isCancelled || status.scene === '') return
                dispatch({
                    type: 'scene-observed',
                    scene: {
                        path: status.scene,
                        revision: status.revision,
                        dirty: status.dirty
                    }
                })
            })
            .catch(() => undefined)
        return () => {
            isCancelled = true
        }
    }, [view.scene, view.state])

    useEffect(
        () => () => {
            if (subscribedTo.current !== undefined)
                void unsubscribeGodotEvents().catch(() => undefined)
        },
        []
    )

    // `callGodot` is handed on as it stands. Wrapping it in a `useCallback` only to supply the
    // defaults it already has would cost a second name for the same function and lose the generic
    // command parameter on the way through, which is the whole point of the map.
    return useMemo(
        () => ({
            ...view,
            // The one fact every panel needs, as one field. Derived here so nothing below has to
            // know that "no scene" and "no reading of the scene" are the same empty string.
            scenePath: view.scene?.path ?? '',
            call: callGodot,
            ensureReady,
            start,
            stop
        }),
        [ensureReady, start, stop, view]
    )
}
