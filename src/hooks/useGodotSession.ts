import {useCallback, useEffect, useRef, useState} from 'react'
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
import type {GodotCallOptions, GodotSessionState, GodotSessionSummary} from '../models/godot'

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

/** What the edited scene is, as the addon's own events report it. */
export type EditedScene = Readonly<{
    path: string
    revision: number
    dirty: boolean
}>

/**
 * The renderer's view of the one Gofer-managed editor session: its lifecycle state, the scene the
 * editor currently has open, and the revision every scene mutation has to quote.
 *
 * Panels do not poll. Two epochs are bumped from the addon's own events — one when the edited scene
 * changes, one when the game starts or stops — and a panel refetches when the epoch it depends on
 * moves, so an editor-side change and a Gofer-side change refresh the same way.
 */
export function useGodotSession({onError}: GodotSessionOptions) {
    const [session, setSession] = useState<GodotSessionSummary>()
    const [state, setState] = useState<GodotSessionState>('offline')
    const [scene, setScene] = useState<EditedScene>()
    const [isBusy, setIsBusy] = useState(false)
    const [sceneEpoch, setSceneEpoch] = useState(0)
    const [runtimeEpoch, setRuntimeEpoch] = useState(0)
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
                setScene({
                    path: typeof data['scene'] === 'string' ? data['scene'] : '',
                    revision: Number(data['revision'] ?? 0),
                    dirty: data['dirty'] === true
                })
                setSceneEpoch(previous => previous + 1)
            }
            if (event.event === 'runtime.ready' || event.event === 'runtime.stopped')
                setRuntimeEpoch(previous => previous + 1)
        }).catch(() => {
            subscribed.current = false
        })
    }, [])

    const start = useCallback(async () => {
        if (!isTauri()) return
        setIsBusy(true)
        try {
            const started = await startGodotSession()
            setSession(started)
            setState(started.state)
            subscribe()
        } catch (error) {
            setState('error')
            report(error, 'The Godot session could not be started')
        } finally {
            setIsBusy(false)
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
                setSession(current)
                setState(current.state)
                return true
            }
            if (!current) break
            await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
        }
        onError('The Godot editor did not become ready, so the game was not launched.')
        return false
    }, [onError, start])

    const stop = useCallback(async () => {
        if (!isTauri()) return
        setIsBusy(true)
        try {
            await stopGodotSession()
            setSession(undefined)
            setState('offline')
            setScene(undefined)
        } catch (error) {
            report(error, 'The Godot session could not be stopped')
        } finally {
            subscribed.current = false
            void unsubscribeGodotEvents().catch(() => undefined)
            setIsBusy(false)
        }
    }, [report])

    // A renderer reload finds whatever session the backend still supervises.
    useEffect(() => {
        if (!isTauri()) return
        let cancelled = false
        void getGodotSession()
            .then(current => {
                if (cancelled || !current) return
                setSession(current)
                setState(current.state)
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
        let unlisten: (() => void) | undefined
        void listen('godot-session-event', received => {
            if (received.payload.type !== 'stateChanged') return
            setState(received.payload.state)
            if (received.payload.state === 'playing' || received.payload.state === 'ready')
                setRuntimeEpoch(previous => previous + 1)
        }).then(cancel => {
            unlisten = cancel
        })
        return () => {
            unlisten?.()
        }
    }, [])

    useEffect(
        () => () => {
            if (subscribed.current) void unsubscribeGodotEvents().catch(() => undefined)
        },
        []
    )

    return {
        call,
        ensureReady,
        isBusy,
        runtimeEpoch,
        scene,
        sceneEpoch,
        session,
        start,
        state,
        stop
    }
}
