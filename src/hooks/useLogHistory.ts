import {useEffect, useState} from 'react'
import {isTauri} from '../services/desktop'
import {searchGodotLogHistory, toGodotError} from '../services/godot-session'
import type {GodotError, GodotLogSearchHit} from '../models/godot'

type LogHistoryOptions = Readonly<{
    enabled: boolean
    query: string
}>

const MAX_HITS = 100
const NO_HITS: readonly GodotLogSearchHit[] = []

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

    const isAnswered = isActive && answered?.query === needle
    const error = isActive && failed?.query === needle ? failed.error : undefined
    return {
        error,
        hits: isAnswered ? answered.hits : NO_HITS,
        isLoading: isActive && !isAnswered && !error
    }
}
