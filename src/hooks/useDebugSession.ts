import {useCallback, useEffect, useMemo, useReducer, useRef} from 'react'
import {callGodotDebug, toGodotError} from '../services/godot-session'
import {isTauri} from '../services/desktop'
import {INITIAL_DEBUG_PANEL, isDebugBusy, reduceDebug} from '../models/debug-panel'
import type {ScopeVariables} from '../models/debug-panel'
import type {DebugRequest, DebugSourceBreakpoints} from '../models/godot'

type DebugSessionOptions = Readonly<{
    /** The breakpoints Monaco's gutter holds, installed with the launch. */
    breakpoints: readonly DebugSourceBreakpoints[]
    /**
     * Where a failed debugger request is reported.
     *
     * The panel keeps the last error for its own display, but a Run pressed from the toolbar has
     * no panel in view: without this, a launch that fails leaves the button unchanged and says
     * nothing at all.
     */
    onError: (message: string) => void
}>

/**
 * The debugger, as the frame shares it. One instance is owned by `InspectorWorkspace` so the Run
 * control and the debugger panel drive the same session rather than two adapters' worth of state.
 */
export type DebugSession = ReturnType<typeof useDebugSession>

export type {ScopeVariables} from '../models/debug-panel'

/**
 * The debugger panel's state machine over Godot's DAP adapter.
 *
 * Stopping is an event, not an answer: every control that resumes the game is followed by a wait
 * for the next stop, and the stack, its scopes, and their variables are read only once the debuggee
 * has actually stopped. `variables` is the one request Godot rejects rather than defers when the
 * debuggee has not dumped the reference yet, and Rust already retries it, so the panel asks once.
 */
export function useDebugSession({breakpoints, onError}: DebugSessionOptions) {
    const [panel, dispatch] = useReducer(reduceDebug, INITIAL_DEBUG_PANEL)
    /**
     * What the adapter has been told about the breakpoints, so only a real change is sent again.
     *
     * The paths are kept beside the signature because a file whose last breakpoint was removed
     * drops out of the list entirely, and clearing it means naming it one more time.
     */
    const installed = useRef<{signature: string; paths: readonly string[]}>({
        signature: '',
        paths: []
    })
    /**
     * Whether a wait for the next stop is already outstanding.
     *
     * There is one event stream, so there can only be one waiter. A Continue leaves its wait
     * running until something stops the game — and Pause is exactly that something, so a second
     * wait started alongside it would watch a stop that the first one had already taken, and end
     * at its own timeout with an error about a pause that had in fact worked.
     */
    const isAwaitingStop = useRef(false)

    const request = useCallback(
        async (input: DebugRequest) => {
            if (!isTauri()) return undefined
            // Waiting for the next stop is not work the user is waiting on — it is the debugger
            // listening. Counting it as busy disabled every control for the length of the wait,
            // Pause included, which is the one control whose whole purpose is to end it.
            const isWatching = input.op === 'awaitStop'
            if (!isWatching) dispatch({type: 'began'})
            try {
                const response = await callGodotDebug(input)
                dispatch({type: 'succeeded'})
                return response
            } catch (failure) {
                const reported = toGodotError(failure)
                // A wait that has not seen a stop is not a failure: the game is simply still
                // running, which is what the user asked for when they pressed Continue.
                if (input.op === 'awaitStop' && reported.code === 'stop_timeout') return undefined
                dispatch({type: 'failed', error: reported})
                onError(`The debugger could not ${input.op}: ${reported.message}`)
                return undefined
            } finally {
                if (!isWatching) dispatch({type: 'ended'})
            }
        },
        [onError]
    )

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
            dispatch({type: 'scopes-read', scopes: filled})
        },
        [request]
    )

    /** Reads the stack the debuggee stopped on, then the scopes and variables of its top frame. */
    const readStack = useCallback(async () => {
        const stack = await request({op: 'stackTrace'})
        if (stack?.op !== 'stackTrace') return
        dispatch({type: 'stack-read', frames: stack.frames})
        const top = stack.frames[0]
        if (!top) return
        await loadScopes(top.id)
    }, [loadScopes, request])

    const selectFrame = useCallback(
        async (id: number) => {
            dispatch({type: 'frame-chosen', frameId: id})
            await loadScopes(id)
        },
        [loadScopes]
    )

    const awaitStop = useCallback(async () => {
        if (isAwaitingStop.current) return
        isAwaitingStop.current = true
        let answered
        try {
            answered = await request({op: 'awaitStop'})
        } finally {
            isAwaitingStop.current = false
        }
        if (answered?.op !== 'stopped') return
        if (!answered.stopped) {
            // The debuggee ended before it stopped again: the session is over, not paused.
            dispatch({type: 'finished'})
            return
        }
        dispatch({type: 'stopped', stop: answered.stopped})
        await readStack()
    }, [readStack, request])

    const launch = useCallback(async () => {
        const answered = await request({op: 'launch', breakpoints, playArgs: []})
        if (answered?.op !== 'launched') return
        installed.current = {
            signature: JSON.stringify(breakpoints),
            paths: breakpoints.map(source => source.path)
        }
        dispatch({type: 'launched'})
        await awaitStop()
    }, [awaitStop, breakpoints, request])

    const resume = useCallback(
        async (op: 'continue' | 'stepOver' | 'stepIn' | 'stepOut') => {
            dispatch({type: 'resuming'})
            const answered = await request({op})
            if (!answered) return
            // A step answers with where it landed; a continue only acknowledges, so the next stop
            // has to be waited for.
            if (answered.op === 'stepped') {
                if (answered.outcome.kind === 'terminated') {
                    dispatch({type: 'finished'})
                    return
                }
                // Stepping out of the outermost frame is resuming: there is no caller to land in,
                // so the game runs on and the panel waits for whatever stops it next.
                if (answered.outcome.kind === 'resumed') {
                    await awaitStop()
                    return
                }
                dispatch({type: 'stopped', stop: answered.outcome.stop})
                await readStack()
                return
            }
            await awaitStop()
        },
        [awaitStop, readStack, request]
    )

    const pause = useCallback(async () => {
        // Whatever stop the pause produces is the one an outstanding wait is already watching for,
        // and there can only be one waiter — so a second wait started here would find the event
        // already taken and end at its own timeout, reporting a pause that had in fact worked.
        const isWatched = isAwaitingStop.current
        const answered = await request({op: 'pause'})
        if (!answered) return
        if (!isWatched) await awaitStop()
    }, [awaitStop, request])

    /**
     * Keeps the running game's breakpoints the ones the gutter shows.
     *
     * Godot applies breakpoint changes to a debuggee that is already running, and the launch is
     * the only place they were ever sent. Without this, a breakpoint removed mid-run keeps
     * stopping the game at a line Monaco no longer marks, and one added mid-run never stops it at
     * all — the gutter and the debugger would be describing two different games.
     */
    useEffect(() => {
        if (!panel.isLaunched) {
            installed.current = {signature: '', paths: []}
            return
        }
        const signature = JSON.stringify(breakpoints)
        // Every keystroke rebuilds the list; only a different list is worth a round trip.
        if (signature === installed.current.signature) return
        const cleared = installed.current.paths.filter(
            path => !breakpoints.some(source => source.path === path)
        )
        installed.current = {signature, paths: breakpoints.map(source => source.path)}
        const sync = async () => {
            for (const source of breakpoints)
                await request({op: 'setBreakpoints', path: source.path, lines: [...source.lines]})
            for (const path of cleared) await request({op: 'setBreakpoints', path, lines: []})
        }
        void sync()
    }, [breakpoints, panel.isLaunched, request])

    const terminate = useCallback(async () => {
        await request({op: 'terminate'})
        dispatch({type: 'finished'})
    }, [request])

    return useMemo(
        () => ({
            ...panel,
            isBusy: isDebugBusy(panel),
            launch,
            pause,
            resume,
            selectFrame,
            terminate
        }),
        [launch, panel, pause, resume, selectFrame, terminate]
    )
}
