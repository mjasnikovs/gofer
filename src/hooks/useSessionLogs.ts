import {useCallback, useEffect, useReducer} from 'react'
import {repeat} from '../services/clock'
import {isTauri} from '../services/desktop'
import {readGodotLogs, toGodotError} from '../services/godot-session'
import {INITIAL_SESSION_LOGS, reduceSessionLogs} from '../models/session-logs'
import type {GodotLogSeverity} from '../models/godot'

type SessionLogOptions = Readonly<{
    enabled: boolean
    minSeverity: GodotLogSeverity
    contains: string
}>

const POLL_INTERVAL_MS = 1_000
const PAGE_LIMIT = 200

/**
 * Follows the editor's captured output. One cursor advances across polls, so a line that arrives
 * between two reads cannot be skipped, and `dropped` reports what the backend's ring buffer
 * discarded before this panel asked for it.
 *
 * What each page does to what is on screen is `reduceSessionLogs`; this is only the polling.
 */
export function useSessionLogs({enabled, minSeverity, contains}: SessionLogOptions) {
    const [logs, dispatch] = useReducer(reduceSessionLogs, INITIAL_SESSION_LOGS)

    const clear = useCallback(() => {
        dispatch({type: 'cleared'})
    }, [])

    useEffect(() => {
        if (!enabled || !isTauri()) return
        let cancelled = false
        // The cursor is carried here rather than read from the state: it moves with every page, and
        // an effect that depended on it would tear down and restart the poll on each one.
        let after: number | undefined
        dispatch({type: 'restarted'})

        const poll = async () => {
            try {
                const page = await readGodotLogs({
                    ...(after !== undefined && {after}),
                    minSeverity,
                    ...(contains.trim() !== '' && {contains: contains.trim()}),
                    limit: PAGE_LIMIT
                })
                if (cancelled) return
                after = page.cursor
                dispatch({type: 'page-read', page})
            } catch (failure) {
                if (!cancelled) dispatch({type: 'failed', error: toGodotError(failure)})
            }
        }

        void poll()
        const stop = repeat(() => {
            void poll()
        }, POLL_INTERVAL_MS)
        return () => {
            cancelled = true
            stop()
        }
    }, [contains, enabled, minSeverity])

    return {clear, dropped: logs.dropped, entries: logs.entries, error: logs.error}
}
