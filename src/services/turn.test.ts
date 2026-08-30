import {describe, expect, it, vi} from 'vitest'
import {createTurnRunner} from './turn'
import type {TurnRunner} from './turn'
import type {AiStreamEvent, Message, TokenUsage} from '../models/chat'
import type {SendAiMessageRequest, SteerAiRequest} from './desktop'

const USAGE: TokenUsage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: {total: 0}
}

type Script = Readonly<{
    events?: readonly AiStreamEvent[]
    throws?: unknown
    during?: (play: (event: AiStreamEvent) => void) => void
}>

type Harness = Readonly<{
    runner: TurnRunner
    sent: SendAiMessageRequest[]
    cancelled: number[]
    steered: SteerAiRequest[]
    refuseSteer: (reason: unknown) => void
    idle: () => Promise<void>
}>

async function settled() {
    await new Promise(resolve => setTimeout(resolve, 0))
}

function harness(...scripts: readonly Script[]): Harness {
    const sent: SendAiMessageRequest[] = []
    const cancelled: number[] = []
    const steered: SteerAiRequest[] = []
    let turn = 0
    let steerFailure: unknown

    const runner = createTurnRunner({
        send: async (request, receive) => {
            sent.push(request)
            const script = scripts[turn++] ?? {}
            const play = (event: AiStreamEvent) => {
                receive({requestId: request.requestId, event})
            }
            script.during?.(play)
            for (const event of script.events ?? []) play(event)
            // eslint-disable-next-line @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors
            if (script.throws !== undefined) throw script.throws
        },
        cancel: async requestId => {
            cancelled.push(requestId)
        },
        steer: async request => {
            steered.push(request)
            // eslint-disable-next-line @typescript-eslint/only-throw-error, @typescript-eslint/prefer-promise-reject-errors
            if (steerFailure !== undefined) throw steerFailure
        }
    })

    return {
        runner,
        sent,
        cancelled,
        steered,
        refuseSteer: reason => {
            steerFailure = reason
        },
        idle: settled
    }
}

function reply(state: {messages: readonly Message[]}): Message {
    const message = state.messages.at(-1)
    if (!message) throw new Error('the conversation has no messages')
    return message
}

describe('createTurnRunner', () => {
    it('starts with an empty conversation that is not streaming', () => {
        const {runner} = harness()
        expect(runner.state()).toEqual({
            messages: [],
            agentMessages: [],
            queued: [],
            handBack: [],
            isStreaming: false
        })
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
        const [first, second] = sent.map(request => request.requestId)
        expect(second).toBe((first ?? 0) + 1)
        expect(sent.every(request => !request.isRetry)).toBe(true)
    })

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
            cancel: async () => undefined,
            steer: async () => undefined
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
            cancel: async () => undefined,
            steer: async () => undefined
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
                },
                steer: async () => undefined
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

describe('a message typed while the turn is running', () => {
    it('is queued rather than lost, and steered into the turn that is running', async () => {
        const {runner, steered, sent, idle} = harness({
            during: () => {
                runner.queue('also check the audio bus')
            }
        })

        runner.start('build the level')
        await idle()

        expect(steered.map(request => request.text)).toEqual(['also check the audio bus'])
        expect(steered[0]?.requestId).toBe(sent[0]?.requestId)
        expect(sent).toHaveLength(1)
    })

    it('shows as queued until the model takes it', async () => {
        let queuedText: string | undefined
        const {runner, idle} = harness({
            during: () => {
                runner.queue('and the audio bus')
                queuedText = runner.state().messages.at(-1)?.text
            }
        })

        runner.start('build the level')
        await idle()

        expect(queuedText).toBe('and the audio bus')
    })

    it('stops being queued and opens a fresh answer when the model takes it', async () => {
        const {runner, steered, idle} = harness({
            during: play => {
                runner.queue('and the audio bus')
                play({type: 'text-delta', delta: 'working'})
                play({type: 'steered', id: steered[0]?.id ?? ''})
                play({type: 'text-delta', delta: 'on it'})
            }
        })

        runner.start('build the level')
        await idle()

        const {messages, queued} = runner.state()
        expect(messages.map(message => message.sender)).toEqual([
            'user',
            'assistant',
            'user',
            'assistant'
        ])
        expect(messages[1]?.text).toBe('working')
        expect(messages[2]?.status).toBeUndefined()
        expect(messages[3]?.text).toBe('on it')
        expect(queued).toEqual([])
    })

    it('is handed back to the caller when the turn ends without taking it', async () => {
        const {runner, idle} = harness({
            during: () => {
                runner.queue('too late')
            }
        })

        runner.start('build the level')
        await idle()

        expect(runner.takeHandBack()).toEqual(['too late'])
        expect(runner.state().messages.map(message => message.sender)).toEqual([
            'user',
            'assistant'
        ])
    })

    it('is handed back when the steer is refused', async () => {
        const {runner, refuseSteer, idle} = harness({
            during: () => {
                refuseSteer(new Error('no turn to steer'))
                runner.queue('nowhere to go')
            }
        })

        runner.start('build the level')
        await idle()

        expect(runner.takeHandBack()).toEqual(['nowhere to go'])
    })

    it('says why the steer was refused, rather than the bubble just vanishing', async () => {
        const {runner, refuseSteer, idle} = harness({
            during: () => {
                refuseSteer({
                    code: 'steer_undelivered',
                    message: 'The AI agent did not take the message.'
                })
                runner.queue('nowhere to go')
            }
        })

        runner.start('build the level')
        await idle()

        expect(runner.state().error).toBe('The AI agent did not take the message.')
    })

    it('is refused outright when no turn is running', () => {
        const {runner, steered} = harness()

        expect(runner.queue('nobody is listening')).toBe(false)
        expect(steered).toEqual([])
    })
})

describe('the timeline a steered turn leaves behind', () => {
    it('puts the answer under the message it answers, not under a later queued one', async () => {
        let order: readonly string[] = []
        const {runner, steered, idle} = harness({
            during: play => {
                play({type: 'text-delta', delta: 'working'})
                runner.queue('first follow-up')
                runner.queue('second follow-up')
                play({type: 'steered', id: steered[0]?.id ?? ''})
                order = runner.state().messages.map(message => message.text)
            }
        })

        runner.start('build the level')
        await idle()

        expect(order).toEqual([
            'build the level',
            'working',
            'first follow-up',
            '',
            'second follow-up'
        ])
    })

    it('leaves the last answer retryable after a steer', async () => {
        const {runner, steered, idle} = harness({
            during: play => {
                runner.queue('follow-up')
                play({type: 'steered', id: steered[0]?.id ?? ''})
                play({type: 'text-delta', delta: 'on it'})
            }
        })

        runner.start('build the level')
        await idle()

        const {messages} = runner.state()
        expect(messages.at(-1)?.sender).toBe('assistant')
        expect(messages.at(-2)?.sender).toBe('user')
    })

    it('never leaves an empty answer above a message steered in before any reply', async () => {
        const {runner, steered, idle} = harness({
            during: play => {
                runner.queue('actually, the audio bus')
                play({type: 'steered', id: steered[0]?.id ?? ''})
                play({type: 'text-delta', delta: 'on it'})
            }
        })

        runner.start('build the level')
        await idle()

        const {messages} = runner.state()
        expect(messages.map(message => message.text)).toEqual([
            'build the level',
            'actually, the audio bus',
            'on it'
        ])
    })
})
