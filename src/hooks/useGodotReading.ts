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

const SESSION_IS_GONE = new Set(['session_stopped', 'session_not_active', 'transport_closed'])

export type GodotQuery<Result> = Readonly<{
    data: Result | undefined
    error: GodotError | undefined
    isLoading: boolean
    reload: () => void
}>

type Settled<Result> = Readonly<{
    id: number
    data?: Result | undefined
    error?: GodotError | undefined
}>

export function useGodotQuery<Result>(
    load: (() => Promise<Result>) | undefined
): GodotQuery<Result> {
    const [previousLoad, setPreviousLoad] = useState(() => ({load}))
    const [requestId, setRequestId] = useState(1)
    const [settled, setSettled] = useState<Settled<Result>>({id: 0})

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
    when?: boolean
    follows?: number
}>

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
        void follows
        return () => call(command, JSON.parse(sent) as GodotCommandParams<Name>)
    }, [call, command, follows, isReadable, sent, when])

    const query = useGodotQuery(load)

    const isSettling = when && !isReadable && !isSessionOffline(state)
    return isSettling ? {...query, isLoading: true} : query
}
