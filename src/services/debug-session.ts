import {INITIAL_DEBUG_PANEL, reduceDebug} from '../models/debug-panel'
import type {DebugPanel, ScopeVariables} from '../models/debug-panel'
import {toGodotError} from './godot-session'
import type {DebugRequest, DebugResponse, DebugSourceBreakpoints} from '../models/godot'

/** Which of the four controls that give the game back to itself was pressed. */
export type DebugResume = 'continue' | 'stepOver' | 'stepIn' | 'stepOut'

/**
 * Everything the session cannot do itself.
 *
 * One seam, and it is the one its tests cross: a test hands over a `call` that answers a scripted
 * list and drives Continue-then-Pause, a step that resumes, or a breakpoint removed mid-run —
 * none of which was expressible while this lived in a hook.
 */
export type DebugDependencies = Readonly<{
    /** Sends one request to Godot's debug adapter. */
    call: (input: DebugRequest) => Promise<DebugResponse>
    /**
     * Where a failed debugger request is reported.
     *
     * The panel keeps the last error for its own display, but a Run pressed from the toolbar has
     * no panel in view: without this, a launch that fails leaves the button unchanged and says
     * nothing at all.
     */
    onError: (message: string) => void
}>

export type DebugSession = Readonly<{
    /** The panel as it stands. Stable by identity between changes. */
    state: () => DebugPanel
    /** Registers a listener for every change, and hands back the way to stop listening. */
    subscribe: (listener: () => void) => () => void
    launch: () => Promise<void>
    pause: () => Promise<void>
    resume: (op: DebugResume) => Promise<void>
    selectFrame: (id: number) => Promise<void>
    terminate: () => Promise<void>
    /**
     * Tells the session which breakpoints the gutter shows, and sends the difference to a debuggee
     * that is already running.
     *
     * Godot applies breakpoint changes to a running game, and the launch used to be the only place
     * they were ever sent. Without this, a breakpoint removed mid-run keeps stopping the game at a
     * line Monaco no longer marks, and one added mid-run never stops it at all — the gutter and the
     * debugger would be describing two different games.
     */
    setBreakpoints: (breakpoints: readonly DebugSourceBreakpoints[]) => void
}>

/**
 * The debugger: what a debugging session is, and what happens to it between one control and the
 * next.
 *
 * Owning the whole sequence is the point, and it is the same point `turn.ts` makes. The steps are
 * individually simple and only correct in order: there is one event stream, so there can only be
 * one waiter, and a Pause started alongside an outstanding wait would watch a stop the first waiter
 * had already taken and then time out reporting a pause that had in fact worked; a step out of the
 * outermost frame resumes rather than lands, so it has to wait rather than read a stack; a file
 * whose last breakpoint was removed drops out of the gutter's list entirely, so clearing it means
 * naming it one more time.
 *
 * None of that was testable. `reduceDebug` — fourteen one-line spreads — had fourteen tests, and
 * this, the part that is actually hard, was two hundred and fifty lines in a hook with no test file
 * at all, reachable only by mounting the whole IDE.
 */
export function createDebugSession({call, onError}: DebugDependencies): DebugSession {
    let panel: DebugPanel = INITIAL_DEBUG_PANEL
    const listeners = new Set<() => void>()

    /**
     * What the adapter has been told about the breakpoints, so only a real change is sent again.
     *
     * The paths are kept beside the signature because a file whose last breakpoint was removed
     * drops out of the list entirely, and clearing it means naming it one more time.
     */
    let installed: {signature: string; paths: readonly string[]} = {signature: '', paths: []}
    /** The breakpoints the gutter last showed, which a launch installs. */
    let gutter: readonly DebugSourceBreakpoints[] = []
    /**
     * Whether a wait for the next stop is already outstanding.
     *
     * There is one event stream, so there can only be one waiter. A Continue leaves its wait
     * running until something stops the game — and Pause is exactly that something, so a second
     * wait started alongside it would watch a stop that the first one had already taken, and end
     * at its own timeout with an error about a pause that had in fact worked.
     */
    let isAwaitingStop = false

    const dispatch = (action: Parameters<typeof reduceDebug>[1]) => {
        const next = reduceDebug(panel, action)
        if (next === panel) return
        panel = next
        for (const listener of [...listeners]) listener()
    }

    const request = async (input: DebugRequest): Promise<DebugResponse | undefined> => {
        // Waiting for the next stop is not work the user is waiting on — it is the debugger
        // listening. Counting it as busy disabled every control for the length of the wait,
        // Pause included, which is the one control whose whole purpose is to end it.
        const isWatching = input.op === 'awaitStop'
        if (!isWatching) dispatch({type: 'began'})
        try {
            const response = await call(input)
            dispatch({type: 'succeeded'})
            return response
        } catch (failure) {
            const reported = toGodotError(failure)
            // A wait that has not seen a stop is not a failure: the game is simply still running,
            // which is what the user asked for when they pressed Continue.
            if (input.op === 'awaitStop' && reported.code === 'stop_timeout') return undefined
            dispatch({type: 'failed', error: reported})
            onError(`The debugger could not ${input.op}: ${reported.message}`)
            return undefined
        } finally {
            if (!isWatching) dispatch({type: 'ended'})
        }
    }

    /** Reads one frame's scopes and every variable in them. */
    const loadScopes = async (id: number) => {
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
    }

    /** Reads the stack the debuggee stopped on, then the scopes and variables of its top frame. */
    const readStack = async () => {
        const stack = await request({op: 'stackTrace'})
        if (stack?.op !== 'stackTrace') return
        dispatch({type: 'stack-read', frames: stack.frames})
        const top = stack.frames[0]
        if (!top) return
        await loadScopes(top.id)
    }

    const awaitStop = async () => {
        if (isAwaitingStop) return
        isAwaitingStop = true
        let answered
        try {
            answered = await request({op: 'awaitStop'})
        } finally {
            isAwaitingStop = false
        }
        if (answered?.op !== 'stopped') return
        if (!answered.stopped) {
            // The debuggee ended before it stopped again: the session is over, not paused.
            dispatch({type: 'finished'})
            return
        }
        dispatch({type: 'stopped', stop: answered.stopped})
        await readStack()
    }

    const syncBreakpoints = async (next: readonly DebugSourceBreakpoints[]) => {
        const signature = JSON.stringify(next)
        // Every keystroke rebuilds the list; only a different list is worth a round trip.
        if (signature === installed.signature) return
        const cleared = installed.paths.filter(path => !next.some(source => source.path === path))
        installed = {signature, paths: next.map(source => source.path)}
        for (const source of next)
            await request({op: 'setBreakpoints', path: source.path, lines: [...source.lines]})
        for (const path of cleared) await request({op: 'setBreakpoints', path, lines: []})
    }

    return {
        state: () => panel,
        subscribe: listener => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },

        launch: async () => {
            const answered = await request({op: 'launch', breakpoints: gutter, playArgs: []})
            if (answered?.op !== 'launched') return
            installed = {
                signature: JSON.stringify(gutter),
                paths: gutter.map(source => source.path)
            }
            dispatch({type: 'launched'})
            await awaitStop()
        },

        pause: async () => {
            // Whatever stop the pause produces is the one an outstanding wait is already watching
            // for, and there can only be one waiter — so a second wait started here would find the
            // event already taken and end at its own timeout, reporting a pause that had worked.
            const isWatched = isAwaitingStop
            const answered = await request({op: 'pause'})
            if (!answered) return
            if (!isWatched) await awaitStop()
        },

        resume: async op => {
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

        selectFrame: async id => {
            dispatch({type: 'frame-chosen', frameId: id})
            await loadScopes(id)
        },

        terminate: async () => {
            await request({op: 'terminate'})
            dispatch({type: 'finished'})
        },

        setBreakpoints: next => {
            gutter = next
            if (!panel.isLaunched) {
                installed = {signature: '', paths: []}
                return
            }
            void syncBreakpoints(next)
        }
    }
}
