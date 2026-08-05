import {useCallback, useRef, useState} from 'react'
import {callGodotDebug, toGodotError} from '../services/godot-session'
import {isTauri} from '../services/desktop'
import type {
    DebugRequest,
    DebugScope,
    DebugSourceBreakpoints,
    DebugStackFrame,
    DebugStopped,
    DebugVariable,
    GodotError
} from '../models/godot'

type DebugSessionOptions = Readonly<{
    /** The breakpoints Monaco's gutter holds, installed with the launch. */
    breakpoints: readonly DebugSourceBreakpoints[]
}>

export type ScopeVariables = Readonly<{
    scope: DebugScope
    variables: readonly DebugVariable[]
}>

/**
 * The debugger panel's state machine over Godot's DAP adapter.
 *
 * Stopping is an event, not an answer: every control that resumes the game is followed by a wait
 * for the next stop, and the stack, its scopes, and their variables are read only once the debuggee
 * has actually stopped. `variables` is the one request Godot rejects rather than defers when the
 * debuggee has not dumped the reference yet, and Rust already retries it, so the panel asks once.
 */
export function useDebugSession({breakpoints}: DebugSessionOptions) {
    const [stopped, setStopped] = useState<DebugStopped>()
    const [frames, setFrames] = useState<readonly DebugStackFrame[]>([])
    const [frameId, setFrameId] = useState<number>()
    const [scopes, setScopes] = useState<readonly ScopeVariables[]>([])
    const [isLaunched, setIsLaunched] = useState(false)
    const [isBusy, setIsBusy] = useState(false)
    const [error, setError] = useState<GodotError>()
    const pending = useRef(0)

    const request = useCallback(async (input: DebugRequest) => {
        if (!isTauri()) return undefined
        pending.current += 1
        setIsBusy(true)
        try {
            const response = await callGodotDebug(input)
            setError(undefined)
            return response
        } catch (failure) {
            setError(toGodotError(failure))
            return undefined
        } finally {
            pending.current -= 1
            if (pending.current === 0) setIsBusy(false)
        }
    }, [])

    /** Reads one frame's scopes and every variable in them. */
    const loadScopes = useCallback(
        async (id: number) => {
            const answered = await request({op: 'scopes', frameId: id})
            if (answered?.op !== 'scopes') return
            const filled: ScopeVariables[] = []
            for (const scope of answered.scopes) {
                const variables = await request({
                    op: 'variables',
                    variablesReference: scope.variablesReference
                })
                filled.push({
                    scope,
                    variables: variables?.op === 'variables' ? variables.variables : []
                })
            }
            setScopes(filled)
        },
        [request]
    )

    /** Reads the stack the debuggee stopped on, then the scopes and variables of its top frame. */
    const readStack = useCallback(async () => {
        const stack = await request({op: 'stackTrace'})
        if (stack?.op !== 'stackTrace') return
        setFrames(stack.frames)
        const top = stack.frames[0]
        setFrameId(top?.id)
        if (!top) {
            setScopes([])
            return
        }
        await loadScopes(top.id)
    }, [loadScopes, request])

    const selectFrame = useCallback(
        async (id: number) => {
            setFrameId(id)
            await loadScopes(id)
        },
        [loadScopes]
    )

    const awaitStop = useCallback(async () => {
        const answered = await request({op: 'awaitStop'})
        if (answered?.op !== 'stopped') return
        if (!answered.stopped) {
            // The debuggee ended before it stopped again: the session is over, not paused.
            setStopped(undefined)
            setFrames([])
            setScopes([])
            setFrameId(undefined)
            setIsLaunched(false)
            return
        }
        setStopped(answered.stopped)
        await readStack()
    }, [readStack, request])

    const launch = useCallback(async () => {
        const answered = await request({op: 'launch', breakpoints, playArgs: []})
        if (answered?.op !== 'launched') return
        setIsLaunched(true)
        setStopped(undefined)
        await awaitStop()
    }, [awaitStop, breakpoints, request])

    const resume = useCallback(
        async (op: 'continue' | 'stepOver' | 'stepIn' | 'stepOut') => {
            setStopped(undefined)
            setFrames([])
            setScopes([])
            const answered = await request({op})
            if (!answered) return
            // A step answers with where it landed; a continue only acknowledges, so the next stop
            // has to be waited for.
            if (answered.op === 'stepped') {
                if (answered.outcome.kind === 'terminated') {
                    setIsLaunched(false)
                    return
                }
                setStopped(answered.outcome.stop)
                await readStack()
                return
            }
            await awaitStop()
        },
        [awaitStop, readStack, request]
    )

    const pause = useCallback(async () => {
        const answered = await request({op: 'pause'})
        if (!answered) return
        await awaitStop()
    }, [awaitStop, request])

    const terminate = useCallback(async () => {
        await request({op: 'terminate'})
        setIsLaunched(false)
        setStopped(undefined)
        setFrames([])
        setScopes([])
        setFrameId(undefined)
    }, [request])

    return {
        error,
        frameId,
        frames,
        isBusy,
        isLaunched,
        launch,
        pause,
        resume,
        scopes,
        selectFrame,
        stopped,
        terminate
    }
}
