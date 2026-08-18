import {describe, expect, it, vi} from 'vitest'
import {createTurnRunner} from './turn'
import type {TurnRunner} from './turn'
import type {AiStreamEvent, Message, TokenUsage} from '../models/chat'
import type {SendAiMessageRequest} from './desktop'

const USAGE: TokenUsage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: {total: 0}
}

/** One scripted turn: what the backend emits, and how it ends. */
type Script = Readonly<{
    events?: readonly AiStreamEvent[]
    /** Thrown instead of settling, standing in for a command that rejected. */
    throws?: unknown
}>

type Harness = Readonly<{
    runner: TurnRunner
    /** Every request the runner sent, in order. */
    sent: SendAiMessageRequest[]
    /** Every request id the runner asked to cancel. */
    cancelled: number[]
    /** Settles once every turn started so far has finished. */
    idle: () => Promise<void>
}>

/**
 * Lets the running turn finish.
 *
 * A macrotask, not a delay: yielding to the task queue once drains every microtask behind it,
 * however deep the promise chain. `start` and `retry` deliberately do not return one to await —
 * a turn is fired and then watched — so this is what a test waits on instead.
 */
async function settled() {
    await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * A runner wired to a backend that emits exactly what the test says, in order, and then ends.
 *
 * `scripts` is consumed one per turn, so a test drives a failure followed by a retry by handing
 * over two. A turn beyond the end of the list emits nothing and ends cleanly.
 */
function harness(...scripts: readonly Script[]): Harness {
    const sent: SendAiMessageRequest[] = []
    const cancelled: number[] = []
    let turn = 0

    const runner = createTurnRunner({
        send: async (request, receive) => {
            sent.push(request)
            const script = scripts[turn++] ?? {}
            for (const event of script.events ?? []) {
                receive({requestId: request.requestId, event})
            }
            // Rejecting with a value rather than throwing one, because that is what the backend
            // does: a Tauri command rejects with the structured failure, not with an `Error`.
            // eslint-disable-next-line @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors
            if (script.throws !== undefined) throw script.throws
        },
        cancel: async requestId => {
            cancelled.push(requestId)
        }
    })

    return {runner, sent, cancelled, idle: settled}
}

function reply(state: {messages: readonly Message[]}): Message {
    const message = state.messages.at(-1)
    if (!message) throw new Error('the conversation has no messages')
    return message
}

describe('createTurnRunner', () => {
    it('starts with an empty conversation that is not streaming', () => {
        const {runner} = harness()
        expect(runner.state()).toEqual({messages: [], agentMessages: [], isStreaming: false})
    })

    it('appends the prompt and the reply, and folds the stream into the reply', async () => {
        const {runner, idle} = harness({
            events: [
                {type: 'text-delta', delta: 'Hello'},
                {type: 'text-delta', delta: ' there'},
                {
                    type: 'done',
                    text: 'Hello there',
                    thinking: '',
                    stopReason: 'end_turn',
                    usage: USAGE,
                    model: 'test',
                    agentMessages: [{role: 'assistant'}]
                }
            ]
        })

        runner.start('Say hello')
        await idle()

        const {messages, agentMessages, isStreaming} = runner.state()
        expect(messages.map(message => message.sender)).toEqual(['user', 'assistant'])
        expect(messages[0]?.text).toBe('Say hello')
        expect(reply({messages}).text).toBe('Hello there')
        expect(reply({messages}).status).toBe('complete')
        expect(agentMessages).toEqual([{role: 'assistant'}])
        expect(isStreaming).toBe(false)
    })

    it('sends the conversation so far as the history, and the new prompt with it', async () => {
        const {runner, sent, idle} = harness({}, {})

        runner.start('first')
        await idle()
        runner.start('second')
        await idle()

        expect(sent[0]?.messages.map(message => message.text)).toEqual(['first'])
        expect(sent[1]?.messages.map(message => message.text)).toEqual(['first', '', 'second'])
        // Consecutive and distinct, not 1 and 2: the counter is process-wide now, so what a
        // turn is given depends on how many ran before it. See the remount test below.
        const [first, second] = sent.map(request => request.requestId)
        expect(second).toBe((first ?? 0) + 1)
        expect(sent.every(request => !request.isRetry)).toBe(true)
    })

    /*
     * The workspace is keyed on the task, so opening another task builds a second runner. The
     * backend cancels a turn by id and holds that id for the life of the process, so a runner that
     * restarted the count handed the next turn an id that was already stopped — and every backend
     * tool answered its reachability probe with `cancelled`, refusing the turn before it started.
     */
    it('never gives a second runner an id the first one already used', async () => {
        const first = harness({})
        const second = harness({})

        first.runner.start('one')
        await first.idle()
        second.runner.start('two')
        await second.idle()

        const ids = [...first.sent, ...second.sent].map(request => request.requestId)
        expect(new Set(ids).size).toBe(ids.length)
    })

    it('keeps the transcript from a turn that never reached done', async () => {
        const {runner, idle} = harness({
            events: [{type: 'turn-state', agentMessages: [{role: 'tool'}]}]
        })

        runner.start('go')
        await idle()

        expect(runner.state().agentMessages).toEqual([{role: 'tool'}])
    })

    it('sends the transcript a failed turn checkpointed with the turn after it', async () => {
        const {runner, sent, idle} = harness(
            {
                events: [{type: 'turn-state', agentMessages: [{role: 'toolResult'}]}],
                throws: {message: 'the worker died'}
            },
            {}
        )

        runner.start('go')
        await idle()
        runner.start('carry on')
        await idle()

        // Empty here is the model being asked a question with no memory of the work it just did,
        // which is what the rebuild from the screen exists to paper over.
        expect(sent[1]?.agentMessages).toEqual([{role: 'toolResult'}])
    })

    it('settles a reply the backend stopped narrating', async () => {
        const {runner, idle} = harness({
            events: [
                {type: 'tool-start', id: 'a', name: 'read_file', startedAt: 1},
                {type: 'text-delta', delta: 'working'}
            ]
        })

        runner.start('go')
        await idle()

        const message = reply(runner.state())
        expect(message.status).toBe('complete')
        expect(message.tools?.[0]?.status).toBe('error')
        expect(message.tools?.[0]?.output).toBe('The turn ended before this call finished.')
        expect(message.activity).toBeUndefined()
    })

    it('drops the caption a long step was showing when the turn ends', async () => {
        const {runner, idle} = harness({
            events: [{type: 'compaction-start', tokens: 100, contextWindow: 200}]
        })

        runner.start('go')
        await idle()

        expect(reply(runner.state()).activity).toBeUndefined()
    })

    it('ignores events from a turn that is no longer the one running', async () => {
        const stale = {requestId: 99, event: {type: 'text-delta', delta: 'ghost'} as const}
        const sent: SendAiMessageRequest[] = []
        const runner = createTurnRunner({
            send: async (request, receive) => {
                sent.push(request)
                receive(stale)
            },
            cancel: async () => undefined
        })

        runner.start('go')
        await Promise.resolve()
        await Promise.resolve()

        expect(reply(runner.state()).text).toBe('')
    })

    it('drops a payload the timeline does not recognise', async () => {
        const runner = createTurnRunner({
            send: async (request, receive) => {
                receive({requestId: request.requestId, event: {type: 'nonsense'} as never})
                receive({requestId: request.requestId, event: {type: 'text-delta'} as never})
            },
            cancel: async () => undefined
        })

        runner.start('go')
        await Promise.resolve()
        await Promise.resolve()

        expect(reply(runner.state()).text).toBe('')
    })

    describe('when the turn fails', () => {
        it('says the reply could not be completed, and settles what was running', async () => {
            const {runner, idle} = harness({
                events: [{type: 'tool-start', id: 'a', name: 'read_file', startedAt: 1}],
                throws: {code: 'worker_crashed', message: 'the worker died'}
            })

            runner.start('go')
            await idle()

            const message = reply(runner.state())
            expect(message.status).toBe('error')
            expect(message.text).toBe('The AI response could not be completed.')
            expect(message.tools?.[0]?.status).toBe('error')
            expect(runner.state().error).toBe('the worker died')
            expect(runner.state().isStreaming).toBe(false)
        })

        it('says a refused turn never reached the model', async () => {
            const {runner, idle} = harness({
                throws: {code: 'ai_request_in_progress', message: 'busy'}
            })

            runner.start('go')
            await idle()

            expect(reply(runner.state()).text).toBe(
                'Gofer is still working on the previous message.'
            )
        })
    })

    describe('stop', () => {
        it('cancels the turn that is running', async () => {
            let release: (() => void) | undefined
            const cancelled: number[] = []
            const sent: number[] = []
            const runner = createTurnRunner({
                send: async request =>
                    new Promise<void>(resolve => {
                        sent.push(request.requestId)
                        release = resolve
                    }),
                cancel: async requestId => {
                    cancelled.push(requestId)
                }
            })

            runner.start('go')
            runner.stop()
            expect(cancelled).toEqual(sent)

            release?.()
        })

        it('does nothing when no turn is running', async () => {
            const {runner, cancelled, idle} = harness({})

            runner.stop()
            runner.start('go')
            await idle()
            runner.stop()

            expect(cancelled).toEqual([])
        })
    })

    describe('retry', () => {
        it('rewrites the last reply in place and keeps every id', async () => {
            const {runner, sent, idle} = harness(
                {throws: new Error('boom')},
                {events: [{type: 'text-delta', delta: 'second time'}]}
            )

            runner.start('go')
            await idle()
            const failed = reply(runner.state())

            runner.retry(failed.id)
            await idle()

            const {messages} = runner.state()
            expect(messages).toHaveLength(2)
            expect(messages[1]?.id).toBe(failed.id)
            expect(messages[1]?.text).toBe('second time')
            expect(sent[1]?.isRetry).toBe(true)
            expect(sent[1]?.messages.map(message => message.text)).toEqual(['go'])
        })

        it('refuses a reply that is not the last one', async () => {
            const {runner, sent, idle} = harness({}, {})

            runner.start('first')
            await idle()
            const first = reply(runner.state())
            runner.start('second')
            await idle()

            runner.retry(first.id)
            await idle()

            expect(sent).toHaveLength(2)
        })
    })

    describe('open', () => {
        it('settles a reply a previous window left running', () => {
            const {runner} = harness()

            runner.open({
                messages: [
                    {id: 1, sender: 'user', text: 'go', timestamp: 0},
                    {
                        id: 2,
                        sender: 'assistant',
                        text: '',
                        timestamp: 0,
                        tools: [{id: 'a', name: 'read_file', status: 'running', startedAt: 0}],
                        status: 'streaming'
                    }
                ],
                agentMessages: [{role: 'user'}],
                taskId: 'task-1'
            })

            const {messages, agentMessages, taskId} = runner.state()
            expect(messages[1]?.status).toBe('aborted')
            expect(messages[1]?.tools?.[0]?.status).toBe('error')
            expect(agentMessages).toEqual([{role: 'user'}])
            expect(taskId).toBe('task-1')
        })

        it('continues the stored ids rather than starting again from one', async () => {
            const {runner, idle} = harness({})

            runner.open({
                messages: [{id: 7, sender: 'user', text: 'go', timestamp: 0}],
                agentMessages: []
            })
            runner.start('again')
            await idle()

            expect(runner.state().messages.map(message => message.id)).toEqual([7, 8, 9])
        })

        it('names the task every turn is sent for', async () => {
            const {runner, sent, idle} = harness({})

            runner.open({messages: [], agentMessages: [], taskId: 'task-2'})
            runner.start('go')
            await idle()

            expect(sent[0]?.taskId).toBe('task-2')
        })
    })

    describe('subscribe', () => {
        it('tells a listener about every change until it stops listening', async () => {
            const {runner, idle} = harness({events: [{type: 'text-delta', delta: 'hi'}]})
            const listener = vi.fn()

            const unsubscribe = runner.subscribe(listener)
            runner.start('go')
            await idle()
            const seen = listener.mock.calls.length
            expect(seen).toBeGreaterThan(1)

            unsubscribe()
            runner.start('again')
            await idle()
            expect(listener).toHaveBeenCalledTimes(seen)
        })
    })
})
