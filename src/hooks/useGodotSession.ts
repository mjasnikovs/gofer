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

const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 250
export const RECONCILE_MS = 1_000

export type {EditedScene} from '../models/godot-session-state'

export function useGodotSession({onError}: GodotSessionOptions): EditorSession {
    const [view, dispatch] = useReducer(reduceSession, INITIAL_SESSION_VIEW)
    const subscribedTo = useRef<string | undefined>(undefined)
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
            subscribedTo.current = undefined
            subscribe(started.sessionId)
        } catch (error) {
            dispatch({type: 'start-failed'})
            report(error, 'The Godot session could not be started')
        }
    }, [report, subscribe])

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
            dispatch({type: 'settled'})
            report(error, 'The Godot session could not be stopped')
        } finally {
            subscribedTo.current = undefined
            void unsubscribeGodotEvents().catch(() => undefined)
        }
    }, [report])

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let isReading = false

        const reconcile = async () => {
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

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let unlisten: (() => void) | undefined
        void listen('godot-session-event', received => {
            if (isCancelled) return
            if (received.payload.type !== 'stateChanged') return
            dispatch({type: 'state-changed', state: received.payload.state})
        }).then(cancel => {
            if (isCancelled) cancel()
            else unlisten = cancel
        })
        return () => {
            isCancelled = true
            unlisten?.()
        }
    }, [])

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

    return useMemo(
        () => ({
            ...view,
            scenePath: view.scene?.path ?? '',
            call: callGodot,
            ensureReady,
            start,
            stop
        }),
        [ensureReady, start, stop, view]
    )
}
