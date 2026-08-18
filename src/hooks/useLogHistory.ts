import {useEffect, useState} from 'react'
import {isTauri} from '../services/desktop'
import {searchGodotLogHistory, toGodotError} from '../services/godot-session'
import type {GodotError, GodotLogSearchHit} from '../models/godot'

type LogHistoryOptions = Readonly<{
    enabled: boolean
    query: string
}>

/** How many archived events one search puts on screen. */
const MAX_HITS = 100
const NO_HITS: readonly GodotLogSearchHit[] = []

/**
 * Searches the stored warning and error history of every recorded run.
 *
 * The session buffer belongs to the editor that is running now; this is the archive behind it, so
 * it answers with no session at all — which is exactly when a user goes looking for what the last
 * one printed. An empty query searches for nothing rather than for everything.
 *
 * Every answer carries the query that produced it, so what is on screen is always an answer to the
 * question the search box is asking rather than the previous one's hits waiting to be replaced.
 */
export function useLogHistory({enabled, query}: LogHistoryOptions) {
    const [answered, setAnswered] = useState<{query: string; hits: readonly GodotLogSearchHit[]}>()
    const [failed, setFailed] = useState<{query: string; error: GodotError}>()

    const needle = query.trim()
    const isActive = enabled && needle !== ''

    useEffect(() => {
        if (!isActive || !isTauri()) return
        let cancelled = false
        void searchGodotLogHistory({query: needle, limit: MAX_HITS})
            .then(hits => {
                if (cancelled) return
                setAnswered({query: needle, hits})
                setFailed(undefined)
            })
            .catch((failure: unknown) => {
                if (!cancelled) setFailed({query: needle, error: toGodotError(failure)})
            })
        return () => {
            cancelled = true
        }
    }, [isActive, needle])

    // A search that found nothing has still answered, so emptiness is reported as an empty result
    // rather than as a request still in flight.
    const isAnswered = isActive && answered?.query === needle
    const error = isActive && failed?.query === needle ? failed.error : undefined
    return {
        error,
        hits: isAnswered ? answered.hits : NO_HITS,
        isLoading: isActive && !isAnswered && !error
    }
}
