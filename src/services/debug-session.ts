import {INITIAL_DEBUG_PANEL, reduceDebug} from '../models/debug-panel'
import type {DebugPanel, ScopeVariables} from '../models/debug-panel'
import {toGodotError} from './godot-session'
import type {DebugRequest, DebugResponse, DebugSourceBreakpoints} from '../models/godot'

export type DebugResume = 'continue' | 'stepOver' | 'stepIn' | 'stepOut'

export type DebugDependencies = Readonly<{
    call: (input: DebugRequest) => Promise<DebugResponse>
    onError: (message: string) => void
}>

export type DebugSession = Readonly<{
    state: () => DebugPanel
    subscribe: (listener: () => void) => () => void
    launch: () => Promise<void>
    pause: () => Promise<void>
    resume: (op: DebugResume) => Promise<void>
    selectFrame: (id: number) => Promise<void>
    terminate: () => Promise<void>
    setBreakpoints: (breakpoints: readonly DebugSourceBreakpoints[]) => void
}>

export function createDebugSession({call, onError}: DebugDependencies): DebugSession {
    let panel: DebugPanel = INITIAL_DEBUG_PANEL
    const listeners = new Set<() => void>()

    let installed: {signature: string; paths: readonly string[]} = {signature: '', paths: []}
    let gutter: readonly DebugSourceBreakpoints[] = []
    let isAwaitingStop = false

    const dispatch = (action: Parameters<typeof reduceDebug>[1]) => {
        const next = reduceDebug(panel, action)
        if (next === panel) return
        panel = next
        for (const listener of [...listeners]) listener()
    }

    const request = async (input: DebugRequest): Promise<DebugResponse | undefined> => {
        const isWatching = input.op === 'awaitStop'
        if (!isWatching) dispatch({type: 'began'})
        try {
            const response = await call(input)
            dispatch({type: 'succeeded'})
            return response
        } catch (failure) {
            const reported = toGodotError(failure)
            if (input.op === 'awaitStop' && reported.code === 'stop_timeout') return undefined
            dispatch({type: 'failed', error: reported})
            onError(`The debugger could not ${input.op}: ${reported.message}`)
            return undefined
        } finally {
            if (!isWatching) dispatch({type: 'ended'})
        }
    }

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
            dispatch({type: 'finished'})
            return
        }
        dispatch({type: 'stopped', stop: answered.stopped})
        await readStack()
    }

    const syncBreakpoints = async (next: readonly DebugSourceBreakpoints[]) => {
        const signature = JSON.stringify(next)
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
            const isWatched = isAwaitingStop
            const answered = await request({op: 'pause'})
            if (!answered) return
            if (!isWatched) await awaitStop()
        },

        resume: async op => {
            dispatch({type: 'resuming'})
            const answered = await request({op})
            if (!answered) return
            if (answered.op === 'stepped') {
                if (answered.outcome.kind === 'terminated') {
                    dispatch({type: 'finished'})
                    return
                }
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
