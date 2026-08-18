import {useCallback, useEffect, useMemo, useState} from 'react'
import {toGodotError} from '../services/godot-session'
import {useEditorSession} from './useEditorSession'
import {isSessionOffline, isSessionReadable} from '../models/godot'
import type {GodotError} from '../models/godot'
import type {
    GodotCommandName,
    GodotCommandParams,
    GodotCommandResult
} from '../models/godot-commands'

/**
 * The failures that mean "there is no editor to ask", which is not a failed read.
 *
 * A panel's read is in flight when the user presses Stop, and it lands after the editor is gone.
 * The answer is true — the session was stopped — but painting it turned the user's own deliberate
 * stop into a red banner saying the scene tree could not be read, over a workspace that is simply
 * offline and already says so. So these are dropped: the panel falls back to the empty state it
 * has for having no session.
 */
const SESSION_IS_GONE = new Set(['session_stopped', 'session_not_active', 'transport_closed'])

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
 *
 * This is the inside of `useGodotReading` and the seam its own tests are written against. Panels
 * use `useGodotReading`: a panel that names a `load` has to know when a session may be asked one,
 * and that is the rule this module exists to hold rather than hand out.
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
                if (cancelled) return
                const error = toGodotError(failure)
                setSettled(
                    SESSION_IS_GONE.has(error.code) ? {id: requestId} : {id: requestId, error}
                )
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

export type ReadingOptions = Readonly<{
    /**
     * Whether this reading is wanted at all — the tab is open, something is selected. Defaults to
     * true. A reading nobody wants is not sent and shows nothing, rather than showing the answer to
     * the question the panel was asking before.
     */
    when?: boolean
    /**
     * The epoch this reading follows, so an editor-side change refetches it. One number, and it is
     * the whole dependency: a scene reading follows the scene epoch, a runtime reading the runtime
     * one. Panels used to spell this as a discarded expression inside a memo.
     */
    follows?: number
}>

/**
 * One panel's reading of the editor session.
 *
 * The panel names a command and says when it is wanted. Everything else about being allowed to ask
 * lives here: an editor that is offline is not asked, an editor that is still staging, starting, or
 * importing is not asked either — it would answer with nothing and nothing would refetch it — and
 * an editor that goes away under a read in flight is not a failure. A session that cannot answer
 * yet reports `isLoading`, because that is what the panel is doing: waiting.
 *
 * `params` is compared by value rather than by identity, so a panel can write the dictionary inline
 * the way it reads. They are small flat dictionaries of paths, queries, and numbers — the same
 * shapes that go over the wire — which is exactly what serializing compares correctly.
 */
export function useGodotReading<Name extends GodotCommandName>(
    command: Name,
    params: GodotCommandParams<Name> = {},
    {when = true, follows = 0}: ReadingOptions = {}
): GodotQuery<GodotCommandResult<Name>> {
    const {call, state} = useEditorSession()
    const isReadable = isSessionReadable(state)
    const sent = JSON.stringify(params)

    const load = useMemo(() => {
        if (!when || !isReadable) return undefined
        // `follows` is a dependency of this memo and nothing more: a new epoch is a new function,
        // and a new function is a new question.
        void follows
        return () => call(command, JSON.parse(sent) as GodotCommandParams<Name>)
    }, [call, command, follows, isReadable, sent, when])

    const query = useGodotQuery(load)

    // A session still coming up is not idle and it is not failing; the panel is waiting for it.
    // Folding that in here is what lets a panel write `isLoading={reading.isLoading}` and be right
    // about a session that has not finished importing yet.
    const isSettling = when && !isReadable && !isSessionOffline(state)
    return isSettling ? {...query, isLoading: true} : query
}
