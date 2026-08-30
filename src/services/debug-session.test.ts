import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDebugSession} from './debug-session'
import type {DebugSession} from './debug-session'
import type {
    DebugRequest,
    DebugResponse,
    DebugSourceBreakpoints,
    DebugStopped
} from '../models/godot'

function scriptedAdapter(answers: Partial<Record<DebugRequest['op'], DebugResponse[]>> = {}) {
    const asked: DebugRequest[] = []
    const waiting: ((response: DebugResponse) => void)[] = []
    const queues = new Map<string, DebugResponse[]>(Object.entries(answers))

    const call = (input: DebugRequest): Promise<DebugResponse> => {
        asked.push(input)
        const queued = queues.get(input.op)?.shift()
        if (queued) return Promise.resolve(queued)
        if (input.op === 'awaitStop')
            return new Promise<DebugResponse>(resolve => waiting.push(resolve))
        return Promise.resolve({op: 'acknowledged'})
    }

    return {
        call,
        asked,
        ops: () => asked.map(request => request.op),
        howMany: (op: DebugRequest['op']) => asked.filter(request => request.op === op).length,
        waiting,
        stopNow: async (stopped: DebugStopped) => {
            for (let attempt = 0; attempt < 50 && waiting.length === 0; attempt += 1)
                await Promise.resolve()
            const resolve = waiting.shift()
            if (!resolve) throw new Error('nothing is waiting for a stop')
            resolve({op: 'stopped', stopped})
        }
    }
}

class GodotFailure extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message)
    }
}

async function settle() {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

const STOP: DebugStopped = {reason: 'breakpoint', threadId: 1, allThreadsStopped: true}

const LAUNCHED: DebugResponse = {op: 'launched', breakpoints: []}

async function launched(adapter: ReturnType<typeof scriptedAdapter>, session: DebugSession) {
    const running = session.launch()
    await adapter.stopNow(STOP)
    await running
}

describe('createDebugSession', () => {
    let adapter: ReturnType<typeof scriptedAdapter>
    let onError: ReturnType<typeof vi.fn<(message: string) => void>>
    let session: DebugSession

    beforeEach(() => {
        adapter = scriptedAdapter({
            launch: [LAUNCHED],
            stackTrace: [{op: 'stackTrace', frames: []}]
        })
        onError = vi.fn<(message: string) => void>()
        session = createDebugSession({call: adapter.call, onError})
    })

    it('does not start a second wait when Pause interrupts a Continue', async () => {
        await launched(adapter, session)
        expect(adapter.howMany('awaitStop')).toBe(1)

        const continuing = session.resume('continue')
        await settle()
        expect(adapter.howMany('awaitStop')).toBe(2)

        await session.pause()
        expect(adapter.howMany('awaitStop')).toBe(2)

        await adapter.stopNow(STOP)
        await continuing
        expect(onError).not.toHaveBeenCalled()
    })

    it('waits for the next stop when a step resumes instead of landing', async () => {
        adapter = scriptedAdapter({
            launch: [LAUNCHED],
            stackTrace: [
                {op: 'stackTrace', frames: []},
                {op: 'stackTrace', frames: []}
            ],
            stepOut: [{op: 'stepped', outcome: {kind: 'resumed'}}]
        })
        session = createDebugSession({call: adapter.call, onError})
        await launched(adapter, session)
        adapter.asked.length = 0

        const stepping = session.resume('stepOut')
        await settle()
        expect(adapter.ops()).toContain('awaitStop')

        await adapter.stopNow(STOP)
        await stepping
        expect(session.state().stopped).toEqual(STOP)
    })

    it('reads the stack directly when a step lands', async () => {
        adapter = scriptedAdapter({
            launch: [LAUNCHED],
            stackTrace: [
                {op: 'stackTrace', frames: []},
                {op: 'stackTrace', frames: []}
            ],
            stepOver: [{op: 'stepped', outcome: {kind: 'interrupted', stop: STOP}}]
        })
        session = createDebugSession({call: adapter.call, onError})
        await launched(adapter, session)
        adapter.asked.length = 0

        await session.resume('stepOver')

        expect(adapter.howMany('awaitStop')).toBe(0)
        expect(adapter.ops()).toContain('stackTrace')
    })

    it('finishes the session when a step terminates the debuggee', async () => {
        adapter = scriptedAdapter({
            launch: [LAUNCHED],
            stackTrace: [{op: 'stackTrace', frames: []}],
            stepIn: [{op: 'stepped', outcome: {kind: 'terminated'}}]
        })
        session = createDebugSession({call: adapter.call, onError})
        await launched(adapter, session)
        adapter.asked.length = 0

        await session.resume('stepIn')

        expect(session.state().isLaunched).toBe(false)
        expect(adapter.howMany('awaitStop')).toBe(0)
    })

    it('names a file whose last breakpoint was removed mid-run', async () => {
        const both: readonly DebugSourceBreakpoints[] = [
            {path: 'a.gd', lines: [1]},
            {path: 'b.gd', lines: [2]}
        ]
        session.setBreakpoints(both)
        await launched(adapter, session)
        adapter.asked.length = 0

        session.setBreakpoints([{path: 'a.gd', lines: [1]}])
        await settle()

        const sent = adapter.asked.filter(request => request.op === 'setBreakpoints')
        expect(sent).toEqual([
            {op: 'setBreakpoints', path: 'a.gd', lines: [1]},
            {op: 'setBreakpoints', path: 'b.gd', lines: []}
        ])
    })

    it('sends nothing when the breakpoints are rebuilt but unchanged', async () => {
        session.setBreakpoints([{path: 'a.gd', lines: [1]}])
        await launched(adapter, session)
        adapter.asked.length = 0

        session.setBreakpoints([{path: 'a.gd', lines: [1]}])
        await settle()

        expect(adapter.howMany('setBreakpoints')).toBe(0)
    })

    it('says nothing when a wait times out with the game still running', async () => {
        const timingOut = scriptedAdapter({launch: [LAUNCHED]})
        const failing = createDebugSession({
            call: input => {
                timingOut.asked.push(input)
                if (input.op === 'awaitStop')
                    return Promise.reject(new GodotFailure('stop_timeout', 'still running'))
                return Promise.resolve<DebugResponse>(LAUNCHED)
            },
            onError
        })

        await failing.launch()

        expect(onError).not.toHaveBeenCalled()
        expect(failing.state().error).toBeUndefined()
    })

    it('reports a launch the adapter refused', async () => {
        const refusing = createDebugSession({
            call: () => Promise.reject(new GodotFailure('no_project', 'nothing to run')),
            onError
        })

        await refusing.launch()

        expect(onError).toHaveBeenCalledWith('The debugger could not launch: nothing to run')
        expect(refusing.state().isLaunched).toBe(false)
    })

    it('publishes each change to its subscribers until they leave', async () => {
        const heard = vi.fn()
        const leave = session.subscribe(heard)
        await launched(adapter, session)
        expect(heard).toHaveBeenCalled()

        leave()
        const before = heard.mock.calls.length
        await session.terminate()
        expect(heard.mock.calls.length).toBe(before)
    })
})
