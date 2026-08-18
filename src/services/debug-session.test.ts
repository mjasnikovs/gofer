import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createDebugSession} from './debug-session'
import type {DebugSession} from './debug-session'
import type {
    DebugRequest,
    DebugResponse,
    DebugSourceBreakpoints,
    DebugStopped
} from '../models/godot'

/**
 * The debug adapter, scripted.
 *
 * Every one of these tests is about an ordering, so the adapter records what it was asked and in
 * what order, and answers by operation rather than by turn. What used to make these unwritable was
 * not the adapter — it is a seam either way — but that the ordering lived in refs inside a hook,
 * reachable only by mounting the whole IDE.
 */
function scriptedAdapter(answers: Partial<Record<DebugRequest['op'], DebugResponse[]>> = {}) {
    const asked: DebugRequest[] = []
    /** Waits that have not been answered yet, so a test can decide when a stop arrives. */
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
        /** Every operation asked for, in order. */
        ops: () => asked.map(request => request.op),
        howMany: (op: DebugRequest['op']) => asked.filter(request => request.op === op).length,
        waiting,
        /**
         * Answers the outstanding wait with a stop, once there is one.
         *
         * The wait is several `await`s deep inside whichever control started it, so a test that
         * answered synchronously would be answering before anything asked.
         */
        stopNow: async (stopped: DebugStopped) => {
            for (let attempt = 0; attempt < 50 && waiting.length === 0; attempt += 1)
                await Promise.resolve()
            const resolve = waiting.shift()
            if (!resolve) throw new Error('nothing is waiting for a stop')
            resolve({op: 'stopped', stopped})
        }
    }
}

/**
 * What the debug adapter rejects with: a coded Godot failure carrying a sentence, which is what
 * `toGodotError` reads. Plain `Error` would lose the code the waits branch on.
 */
class GodotFailure extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message)
    }
}

/** Yields until every already-queued microtask has run. */
async function settle() {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

const STOP: DebugStopped = {reason: 'breakpoint', threadId: 1, allThreadsStopped: true}

const LAUNCHED: DebugResponse = {op: 'launched', breakpoints: []}

/** A launched session with nothing outstanding, which is where most of these start. */
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

    /*
     * There is one event stream, so there can only be one waiter.
     *
     * Continue leaves a wait running until something stops the game, and Pause is exactly that
     * something. A second wait started alongside it would watch a stop the first waiter had already
     * taken and end at its own timeout — reporting a failure for a pause that worked. The whole of
     * that invariant used to be a ref inside a hook, and nothing could reach it.
     */
    it('does not start a second wait when Pause interrupts a Continue', async () => {
        await launched(adapter, session)
        expect(adapter.howMany('awaitStop')).toBe(1)

        // Continue: acknowledged, then a wait that nothing has answered yet.
        const continuing = session.resume('continue')
        await settle()
        expect(adapter.howMany('awaitStop')).toBe(2)

        // Pause must join the outstanding wait rather than start a second one.
        await session.pause()
        expect(adapter.howMany('awaitStop')).toBe(2)

        await adapter.stopNow(STOP)
        await continuing
        expect(onError).not.toHaveBeenCalled()
    })

    /*
     * Stepping out of the outermost frame resumes: there is no caller to land in, so the game runs
     * on and the next stop has to be waited for rather than read off the answer.
     */
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

    /** A step that lands reads the stack straight off the answer, with no wait at all. */
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

    /** A step that ends the debuggee finishes the session rather than waiting for a stop. */
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

    /*
     * A file whose last breakpoint is removed drops out of the gutter's list entirely, so clearing
     * it means naming it one more time. Godot applies breakpoint changes to a game that is already
     * running, and the launch used to be the only place they were ever sent.
     */
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

    /** Every keystroke rebuilds the gutter's list; only a different list is worth a round trip. */
    it('sends nothing when the breakpoints are rebuilt but unchanged', async () => {
        session.setBreakpoints([{path: 'a.gd', lines: [1]}])
        await launched(adapter, session)
        adapter.asked.length = 0

        session.setBreakpoints([{path: 'a.gd', lines: [1]}])
        await settle()

        expect(adapter.howMany('setBreakpoints')).toBe(0)
    })

    /*
     * A wait that has not seen a stop is not a failure: the game is still running, which is what
     * the user asked for when they pressed Continue.
     */
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

    /** Any other failure is the user's to see, wherever they pressed the control from. */
    it('reports a launch the adapter refused', async () => {
        const refusing = createDebugSession({
            call: () => Promise.reject(new GodotFailure('no_project', 'nothing to run')),
            onError
        })

        await refusing.launch()

        expect(onError).toHaveBeenCalledWith('The debugger could not launch: nothing to run')
        expect(refusing.state().isLaunched).toBe(false)
    })

    /** Subscribers hear every change, and stop hearing them once they unsubscribe. */
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
