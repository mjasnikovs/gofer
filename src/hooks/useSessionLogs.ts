import {useCallback, useEffect, useRef, useState} from 'react'
import {isTauri} from '../services/desktop'
import {readGodotLogs, toGodotError} from '../services/godot-session'
import type {GodotError, GodotLogEntry, GodotLogSeverity} from '../models/godot'

type SessionLogOptions = Readonly<{
    enabled: boolean
    minSeverity: GodotLogSeverity
    contains: string
}>

/** How many lines the panel keeps on screen. The backend's own ring buffer is the real bound. */
const MAX_ENTRIES = 500
const POLL_INTERVAL_MS = 1_000
const PAGE_LIMIT = 200

/**
 * Follows the editor's captured output. One cursor advances across polls, so a line that arrives
 * between two reads cannot be skipped, and `dropped` reports what the backend's ring buffer
 * discarded before this panel asked for it.
 *
 * Changing a filter restarts from the oldest buffered line rather than filtering what is already on
 * screen: the filter belongs to the query, and the backend is the only place that still holds the
 * lines the previous filter excluded.
 */
export function useSessionLogs({enabled, minSeverity, contains}: SessionLogOptions) {
    const [entries, setEntries] = useState<readonly GodotLogEntry[]>([])
    const [dropped, setDropped] = useState(0)
    const [error, setError] = useState<GodotError>()
    const cursor = useRef<number | undefined>(undefined)

    const clear = useCallback(() => {
        setEntries([])
    }, [])

    useEffect(() => {
        if (!enabled || !isTauri()) return
        let cancelled = false
        // The first page of a new subscription replaces what the previous filter left on screen;
        // every later page appends. Doing it here rather than in the effect body keeps the reset
        // out of the render the effect would otherwise cascade into.
        let isFirstPage = true
        cursor.current = undefined

        const poll = async () => {
            try {
                const page = await readGodotLogs({
                    ...(cursor.current !== undefined && {after: cursor.current}),
                    minSeverity,
                    ...(contains.trim() !== '' && {contains: contains.trim()}),
                    limit: PAGE_LIMIT
                })
                if (cancelled) return
                cursor.current = page.cursor
                setDropped(page.dropped)
                setError(undefined)
                if (isFirstPage) {
                    isFirstPage = false
                    setEntries(page.entries.slice(-MAX_ENTRIES))
                    return
                }
                if (page.entries.length > 0)
                    setEntries(previous => [...previous, ...page.entries].slice(-MAX_ENTRIES))
            } catch (failure) {
                if (!cancelled) setError(toGodotError(failure))
            }
        }

        void poll()
        const timer = setInterval(() => {
            void poll()
        }, POLL_INTERVAL_MS)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [contains, enabled, minSeverity])

    return {clear, dropped, entries, error}
}
