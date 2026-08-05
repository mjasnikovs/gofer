import {useCallback, useEffect, useState} from 'react'
import {toGodotError} from '../services/godot-session'
import type {GodotError} from '../models/godot'

export type GodotQuery<Result> = Readonly<{
    data: Result | undefined
    error: GodotError | undefined
    isLoading: boolean
    reload: () => void
}>

type Settled<Result> = Readonly<{
    /** Which request produced this answer. An older one is not shown next to a newer question. */
    id: number
    data?: Result | undefined
    error?: GodotError | undefined
}>

/**
 * Runs one panel's read whenever the caller's memoized `load` changes identity, and once more on
 * `reload`. A `load` of `undefined` means the panel has nothing to ask for — no session, nothing
 * selected — and clears the panel instead of showing a stale answer next to a new selection.
 *
 * Loading is derived rather than stored: the request the panel is waiting for and the request that
 * answered are both numbers, and a mismatch is what "loading" means. That keeps the effect free of
 * synchronous state writes, which would cost a cascading render on every selection.
 */
export function useGodotQuery<Result>(
    load: (() => Promise<Result>) | undefined
): GodotQuery<Result> {
    // The loader is boxed because React reads a bare function argument to `setState` as an updater
    // and would call it instead of storing it.
    const [previousLoad, setPreviousLoad] = useState(() => ({load}))
    const [requestId, setRequestId] = useState(1)
    const [settled, setSettled] = useState<Settled<Result>>({id: 0})

    // Adjusting state during render: a new `load` is a new question, and deriving that here rather
    // than in an effect keeps the previous answer from being painted under it first.
    if (previousLoad.load !== load) {
        setPreviousLoad({load})
        setRequestId(previous => previous + 1)
    }

    const reload = useCallback(() => {
        setRequestId(previous => previous + 1)
    }, [])

    useEffect(() => {
        if (!load) return
        let cancelled = false
        void load()
            .then(data => {
                if (!cancelled) setSettled({id: requestId, data})
            })
            .catch((failure: unknown) => {
                if (!cancelled) setSettled({id: requestId, error: toGodotError(failure)})
            })
        return () => {
            cancelled = true
        }
    }, [load, requestId])

    const isCurrent = settled.id === requestId
    return {
        data: load && isCurrent ? settled.data : undefined,
        error: load && isCurrent ? settled.error : undefined,
        isLoading: Boolean(load) && !isCurrent,
        reload
    }
}
