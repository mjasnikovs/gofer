import {describe, expect, it} from 'vitest'
import type {AiStreamEvent, Message, TokenUsage} from './chat'
import {
    applyStreamEvent,
    isAiStreamEvent,
    messageParts,
    retryPlan,
    settleRunningTools,
    settleStoredChat
} from './chat-timeline'

const USAGE: TokenUsage = {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 30,
    cost: {total: 0}
}

function assistant(): Message {
    return {
        id: 1,
        sender: 'assistant',
        text: '',
        timestamp: 0,
        tools: [],
        parts: [],
        status: 'streaming'
    }
}

function replay(events: readonly AiStreamEvent[], from: Message = assistant()) {
    return events.reduce(applyStreamEvent, from)
}

describe('applyStreamEvent', () => {
    /**
     * Every point sends twice — once when it starts, once when it answers — so a reducer that
     * appended would draw a running row and a finished row for the same check.
     */
    it('upserts a verification point by name and keeps the order it ran in', () => {
        const message = replay([
            {
                type: 'verify-point',
                name: 'the boss moves',
                command: 'a',
                status: 'running',
                index: 0,
                of: 2
            },
            {
                type: 'verify-point',
                name: 'it still starts',
                command: 'b',
                status: 'running',
                index: 1,
                of: 2
            },
            {
                type: 'verify-point',
                name: 'the boss moves',
                command: 'a',
                status: 'error',
                index: 0,
                of: 2,
                output: 'actual=0'
            },
            {
                type: 'verify-point',
                name: 'it still starts',
                command: 'b',
                status: 'complete',
                index: 1,
                of: 2
            }
        ])

        expect(message.verifyPoints).toEqual([
            {name: 'the boss moves', command: 'a', status: 'error', output: 'actual=0'},
            {name: 'it still starts', command: 'b', status: 'complete'}
        ])
    })

    it('keeps text and tool calls in the order they arrived', () => {
        const message = replay([
            {type: 'text-delta', delta: 'Let me look.'},
            {type: 'tool-start', id: 'a', name: 'godot_script', target: 'open', startedAt: 1},
            {type: 'tool-end', id: 'a', output: 'ok', isError: false, endedAt: 2},
            {type: 'text-delta', delta: 'Now the tileset.'},
            {type: 'tool-start', id: 'b', name: 'godot_scene', target: 'save', startedAt: 3}
        ])
        expect(messageParts(message)).toEqual([
            {kind: 'text', text: 'Let me look.'},
            {kind: 'tool', toolId: 'a'},
            {kind: 'text', text: 'Now the tileset.'},
            {kind: 'tool', toolId: 'b'}
        ])
    })

    it('merges consecutive deltas into one part rather than one part per delta', () => {
        const message = replay([
            {type: 'text-delta', delta: 'Hello '},
            {type: 'text-delta', delta: 'there'}
        ])
        expect(message.parts).toEqual([{kind: 'text', text: 'Hello there'}])
        expect(message.text).toBe('Hello there')
    })

    it('keeps reasoning as its own step, next to the text it preceded', () => {
        const message = replay([
            {type: 'thinking-delta', delta: 'The scene needs a tileset.'},
            {type: 'text-delta', delta: 'Building it now.'}
        ])
        expect(message.parts).toEqual([
            {kind: 'thinking', text: 'The scene needs a tileset.'},
            {kind: 'text', text: 'Building it now.'}
        ])
        expect(message.thinking).toBe('The scene needs a tileset.')
    })

    it('resolves a tool part to the call it names', () => {
        const message = replay([
            {type: 'tool-start', id: 'a', name: 'bash', target: 'ls', startedAt: 1},
            {type: 'tool-end', id: 'a', output: 'files', isError: false, endedAt: 5}
        ])
        expect(message.parts).toEqual([{kind: 'tool', toolId: 'a'}])
        expect(message.tools).toEqual([
            {
                id: 'a',
                name: 'bash',
                target: 'ls',
                status: 'complete',
                output: 'files',
                startedAt: 1,
                endedAt: 5
            }
        ])
    })

    /*
     * A delegation runs a whole agent for minutes, and the row used to say the question and then
     * nothing at all until it answered. The step is what it is doing NOW, so it is dropped the
     * moment the call ends — left on, it reads as the result, and it is stored with the chat, so it
     * would still be reading that way when the task is reopened.
     */
    it('carries what a long call is doing now, and drops it when the call ends', () => {
        const running = replay([
            {type: 'tool-start', id: 'a', name: 'subagent', target: 'find the menu', startedAt: 1},
            {type: 'tool-update', id: 'a', output: 'Working — 1 step', step: 'bash: rg -n Main'}
        ])
        expect(running.tools?.[0]).toMatchObject({
            target: 'find the menu',
            step: 'bash: rg -n Main',
            status: 'running'
        })

        const done = replay([
            {type: 'tool-start', id: 'a', name: 'subagent', target: 'find the menu', startedAt: 1},
            {type: 'tool-update', id: 'a', output: 'Working — 1 step', step: 'bash: rg -n Main'},
            {type: 'tool-end', id: 'a', output: 'MainMenu.tscn', isError: false, endedAt: 9}
        ])
        expect(done.tools?.[0]).not.toHaveProperty('step')
        expect(done.tools?.[0]?.target).toBe('find the menu')
    })

    // The step is optional, so a worker that sends none is not a malformed event to be dropped.
    it('accepts a tool update with no step, and rejects one whose step is not text', () => {
        expect(isAiStreamEvent({type: 'tool-update', id: 'a', output: 'x'})).toBe(true)
        expect(isAiStreamEvent({type: 'tool-update', id: 'a', output: 'x', step: 'bash: ls'})).toBe(
            true
        )
        expect(isAiStreamEvent({type: 'tool-update', id: 'a', output: 'x', step: 7})).toBe(false)
    })

    it('keeps everything the agent said, not only its last step', () => {
        // The backend takes `done.text` from the final `turn_end`, which for a turn that called
        // tools is the last step alone. Preferring it dropped every earlier narration.
        const message = replay([
            {type: 'text-delta', delta: 'Let me inspect the scene.'},
            {type: 'tool-start', id: 'a', name: 'godot_scene', startedAt: 1},
            {type: 'tool-end', id: 'a', output: 'ok', isError: false, endedAt: 2},
            {type: 'text-delta', delta: 'Scene inspected.'},
            {
                type: 'done',
                text: 'Scene inspected.',
                thinking: '',
                stopReason: 'stop',
                usage: USAGE,
                model: 'local',
                agentMessages: []
            }
        ])
        expect(message.text).toBe('Let me inspect the scene.Scene inspected.')
        expect(message.status).toBe('complete')
        expect(message.usage).toEqual(USAGE)
    })

    it('marks a completion the model was stopped mid-way as stopped, not as complete', () => {
        // The worker answers the backend's cancel line now: it aborts its own agent, checkpoints
        // what the model had done and ends the turn on its own completion. That completion arrives
        // AFTER the `aborted` the backend mints, and a `done` that always meant `complete` marked
        // the stopped turn finished — the last event won, and it was the wrong one.
        const message = replay([
            {type: 'text-delta', delta: 'Half an ans'},
            {type: 'tool-start', id: 'a', name: 'godot_scene', startedAt: 1},
            {type: 'aborted'},
            {
                type: 'done',
                text: 'Half an ans',
                thinking: '',
                stopReason: 'aborted',
                usage: USAGE,
                model: 'local',
                agentMessages: []
            }
        ])
        expect(message.status).toBe('aborted')
        // What it managed to say is kept, which is the whole reason the worker is asked before it
        // is killed.
        expect(message.text).toBe('Half an ans')
        expect(message.tools?.[0]?.status).toBe('error')
    })

    it('settles the calls a stopped turn left running, on the completion as well', () => {
        // A stop the backend never had to mint an `aborted` for: the worker answered, so the
        // completion is the only event saying the turn ended, and the spinning row is still there.
        const message = replay([
            {type: 'tool-start', id: 'a', name: 'godot_scene', startedAt: 1},
            {
                type: 'done',
                text: '',
                thinking: '',
                stopReason: 'aborted',
                usage: USAGE,
                model: 'local',
                agentMessages: []
            }
        ])
        expect(message.status).toBe('aborted')
        expect(message.tools?.[0]?.status).toBe('error')
        expect(message.tools?.[0]?.output).toBe('Stopped before it finished.')
    })

    it('falls back to the final message when the turn streamed no text', () => {
        const message = replay([
            {
                type: 'done',
                text: 'All done.',
                thinking: '',
                stopReason: 'stop',
                usage: USAGE,
                model: 'local',
                agentMessages: []
            }
        ])
        expect(message.text).toBe('All done.')
        expect(message.parts).toEqual([{kind: 'text', text: 'All done.'}])
    })

    it('ends the calls still running when the turn is cancelled, and says so', () => {
        const message = replay([
            {type: 'tool-start', id: 'a', name: 'bash', startedAt: 1},
            {type: 'aborted'}
        ])
        expect(message.status).toBe('aborted')
        expect(message.tools?.[0]?.status).toBe('error')
        expect(message.parts).toEqual([
            {kind: 'tool', toolId: 'a'},
            {kind: 'text', text: 'Generation stopped.'}
        ])
    })

    it('charges an ask to the one call it issued', () => {
        const message = replay([
            {type: 'tool-start', id: 'a', name: 'godot_node', startedAt: 1},
            {type: 'tool-end', id: 'a', output: 'ok', isError: false, endedAt: 2},
            {type: 'tool-cost', ids: ['a'], tokens: 1967}
        ])
        expect(message.tools?.[0]?.tokens).toBe(1967)
    })

    // The rows are only worth reading if they add up, so a shared ask is split without losing the
    // remainder, and a call from another ask is left alone.
    it('splits an ask between its calls and leaves other calls untouched', () => {
        const message = replay([
            {type: 'tool-start', id: 'a', name: 'godot_node', startedAt: 1},
            {type: 'tool-start', id: 'b', name: 'godot_node', startedAt: 1},
            {type: 'tool-start', id: 'c', name: 'bash', startedAt: 1},
            {type: 'tool-cost', ids: ['a', 'b'], tokens: 101}
        ])
        expect(message.tools?.map(tool => tool.tokens)).toEqual([51, 50, undefined])
    })

    it('drops the compaction label once compaction ends', () => {
        const message = replay([
            {type: 'compaction-start', tokens: 100, contextWindow: 200},
            {type: 'compaction-end'}
        ])
        expect(message.activity).toBeUndefined()
    })

    it('says a turn is waiting to be tried again without ending it', () => {
        const message = replay([
            {type: 'text-delta', delta: 'Looking at it'},
            {
                type: 'retry-scheduled',
                attempt: 2,
                maxAttempts: 10,
                delayMs: 20_000,
                errorMessage: 'connection refused'
            }
        ])
        // Still running: a settled turn stops the indicator and offers a Retry button, and the turn
        // is already retrying itself.
        expect(message.status).toBe('streaming')
        expect(message.activity).toContain('20s')
        expect(message.activity).toContain('2 of 10')
        expect(message.activity).toContain('connection refused')
        // What the model managed to say is not thrown away between attempts.
        expect(message.text).toBe('Looking at it')
    })

    it('replaces the countdown once the model is being asked again', () => {
        const message = replay([
            {
                type: 'retry-scheduled',
                attempt: 3,
                maxAttempts: 10,
                delayMs: 40_000,
                errorMessage: 'overloaded'
            },
            {type: 'retry-start', attempt: 3, maxAttempts: 10}
        ])
        expect(message.activity).toBe('Trying again (3 of 10)')
        expect(message.status).toBe('streaming')
    })

    it('drops the retry label when the turn finally answers', () => {
        const message = replay([
            {
                type: 'retry-scheduled',
                attempt: 1,
                maxAttempts: 10,
                delayMs: 5_000,
                errorMessage: 'overloaded'
            },
            {type: 'retry-start', attempt: 1, maxAttempts: 10},
            {
                type: 'done',
                text: 'Back online',
                thinking: '',
                stopReason: 'stop',
                usage: USAGE,
                model: 'local',
                agentMessages: []
            }
        ])
        expect(message.status).toBe('complete')
        expect(message.activity).toBeUndefined()
    })
})

describe('isAiStreamEvent', () => {
    it('accepts the retry events the worker sends', () => {
        expect(
            isAiStreamEvent({
                type: 'retry-scheduled',
                attempt: 1,
                maxAttempts: 10,
                delayMs: 5_000,
                errorMessage: 'overloaded'
            })
        ).toBe(true)
        expect(isAiStreamEvent({type: 'retry-start', attempt: 1, maxAttempts: 10})).toBe(true)
    })

    it('drops a retry event missing what the caption is drawn from', () => {
        expect(
            isAiStreamEvent({type: 'retry-scheduled', attempt: 1, maxAttempts: 10, delayMs: 5_000})
        ).toBe(false)
        expect(isAiStreamEvent({type: 'retry-start', attempt: 1})).toBe(false)
    })
})

describe('messageParts', () => {
    it('rebuilds a displayable order for a chat stored before order was recorded', () => {
        const stored: Message = {
            id: 1,
            sender: 'assistant',
            text: 'Done.',
            timestamp: 0,
            thinking: 'Thought about it.',
            tools: [{id: 'a', name: 'bash', status: 'complete', startedAt: 1, endedAt: 2}]
        }
        expect(messageParts(stored)).toEqual([
            {kind: 'thinking', text: 'Thought about it.'},
            {kind: 'tool', toolId: 'a'},
            {kind: 'text', text: 'Done.'}
        ])
    })

    it('leaves a recorded order alone', () => {
        const message = {...assistant(), parts: [{kind: 'text', text: 'Hi'}] as const, text: 'Hi'}
        expect(messageParts(message)).toEqual([{kind: 'text', text: 'Hi'}])
    })
})

describe('settleRunningTools', () => {
    it('leaves a message whose calls all finished untouched', () => {
        const message: Message = {
            ...assistant(),
            tools: [{id: 'a', name: 'bash', status: 'complete', startedAt: 1, endedAt: 2}]
        }
        expect(settleRunningTools(message, 'stopped')).toBe(message)
    })

    /**
     * A call that was reporting progress keeps what it said and is told why it stopped.
     *
     * One recorded row is a sub-agent asked why a blue tileset renders green, ended after two
     * steps, and stored with `Working — 2 steps so far: bash: pwd; …` as its answer. The reason it
     * ended was never written down, because the output it already had was taken instead.
     */
    it('adds the reason to a call that had already said something, rather than instead of it', () => {
        const message: Message = {
            ...assistant(),
            tools: [
                {
                    id: 'a',
                    name: 'subagent',
                    status: 'running',
                    startedAt: 1,
                    output: 'Working — 2 steps so far:\nbash: pwd'
                },
                {id: 'b', name: 'bash', status: 'pending', startedAt: 1}
            ]
        }

        const settled = settleRunningTools(message, 'The turn ended before this call finished.')

        expect(settled.tools?.[0]?.output).toBe(
            'Working — 2 steps so far:\nbash: pwd\n\nThe turn ended before this call finished.'
        )
        expect(settled.tools?.[1]?.output).toBe('The turn ended before this call finished.')
        expect(settled.tools?.map(tool => tool.status)).toEqual(['error', 'error'])
    })
})

describe('retryPlan', () => {
    const user: Message = {id: 1, sender: 'user', text: 'Build the level', timestamp: 0}
    const failed: Message = {
        id: 2,
        sender: 'assistant',
        text: 'The AI response could not be completed.',
        timestamp: 0,
        tools: [{id: 'a', name: 'bash', status: 'error', startedAt: 1, endedAt: 2}],
        parts: [{kind: 'text', text: 'The AI response could not be completed.'}],
        status: 'error'
    }

    it('rewrites the failed reply in place and removes nothing', () => {
        const plan = retryPlan([user, failed], 2)
        expect(plan?.conversation).toHaveLength(2)
        expect(plan?.conversation[0]).toBe(user)
        expect(plan?.conversation[1]).toMatchObject({
            id: 2,
            sender: 'assistant',
            text: '',
            tools: [],
            parts: [],
            status: 'streaming'
        })
    })

    it('keeps every earlier turn, and sends them as the history', () => {
        const earlier: readonly Message[] = [
            {id: 1, sender: 'user', text: 'First', timestamp: 0},
            {id: 2, sender: 'assistant', text: 'Done', timestamp: 0, status: 'complete'},
            {...user, id: 3},
            {...failed, id: 4}
        ]
        const plan = retryPlan(earlier, 4)
        expect(plan?.conversation.map(message => message.id)).toEqual([1, 2, 3, 4])
        expect(plan?.history.map(message => message.id)).toEqual([1, 2])
        expect(plan?.prompt.id).toBe(3)
    })

    /*
     * What a long agentic reply really looks like on screen: one bubble holding every step.
     *
     * A real stopped turn was found holding a hundred and twenty eight steps of work in the
     * transcript and, after a Retry, an empty bubble on screen and in the database. This is the
     * shape that has to survive.
     */
    const worked: Message = {
        id: 2,
        sender: 'assistant',
        text: 'Looking at it.All done.',
        timestamp: 0,
        thinking: 'Thinking about it.',
        tools: [
            {id: 'a', name: 'bash', status: 'complete', startedAt: 1, endedAt: 2},
            {id: 'b', name: 'godot_scene', status: 'error', startedAt: 3, endedAt: 4}
        ],
        parts: [
            {kind: 'thinking', text: 'Thinking about it.'},
            {kind: 'text', text: 'Looking at it.'},
            {kind: 'tool', toolId: 'a'},
            {kind: 'tool', toolId: 'b'},
            {kind: 'text', text: 'All done.'}
        ],
        status: 'aborted'
    }

    it('keeps the work the reply already did', () => {
        const reopened = retryPlan([user, worked], 2)?.conversation.at(-1)
        expect(reopened?.tools).toEqual(worked.tools)
        expect(reopened?.parts).toEqual([
            {kind: 'thinking', text: 'Thinking about it.'},
            {kind: 'text', text: 'Looking at it.'},
            {kind: 'tool', toolId: 'a'},
            {kind: 'tool', toolId: 'b'}
        ])
        // The prose the turn ended on is dropped, and `text` is what the kept prose says — the
        // same trailing answer the worker takes off the transcript before it carries on.
        expect(reopened?.text).toBe('Looking at it.')
        expect(reopened?.status).toBe('streaming')
    })

    it('clears a reply that only ever wrote prose', () => {
        const reopened = retryPlan([user, failed], 2)?.conversation.at(-1)
        expect(reopened?.parts).toEqual([])
        expect(reopened?.text).toBe('')
        expect(reopened?.tools).toEqual([])
    })

    it('keeps a reply whose last step was a tool call whole', () => {
        const stopped: Message = {
            ...worked,
            text: 'Looking at it.',
            parts: [
                {kind: 'text', text: 'Looking at it.'},
                {kind: 'tool', toolId: 'a'},
                {kind: 'tool', toolId: 'b'}
            ]
        }
        const reopened = retryPlan([user, stopped], 2)?.conversation.at(-1)
        expect(reopened?.parts).toEqual(stopped.parts)
        expect(reopened?.text).toBe('Looking at it.')
    })

    it('replays the user turn with its attachments', () => {
        const withImage: Message = {
            ...user,
            attachments: [{id: 'x', name: 'a.png', mimeType: 'image/png', size: 1}]
        }
        expect(retryPlan([withImage, failed], 2)?.prompt.attachments).toEqual(withImage.attachments)
    })

    it('refuses a reply that is not the last message', () => {
        const later: readonly Message[] = [
            user,
            failed,
            {id: 3, sender: 'user', text: 'Never mind', timestamp: 0},
            {id: 4, sender: 'assistant', text: 'Fine', timestamp: 0, status: 'complete'}
        ]
        expect(retryPlan(later, 2)).toBeUndefined()
    })

    it('refuses a reply with no user turn above it', () => {
        expect(retryPlan([failed], 2)).toBeUndefined()
        expect(retryPlan([{...failed, id: 9}, failed], 2)).toBeUndefined()
    })

    it('refuses an id that names no message', () => {
        expect(retryPlan([user, failed], 99)).toBeUndefined()
    })
})

describe('settleStoredChat', () => {
    it('leaves a conversation that ended properly alone', () => {
        const messages: readonly Message[] = [
            {id: 1, sender: 'user', text: 'Hi', timestamp: 0},
            {id: 2, sender: 'assistant', text: 'Hello', timestamp: 0, status: 'complete'}
        ]
        expect(settleStoredChat(messages)).toBe(messages)
    })

    it('ends a turn the window stopped in the middle of', () => {
        const settled = settleStoredChat([
            {id: 1, sender: 'user', text: 'Build it', timestamp: 0},
            {
                id: 2,
                sender: 'assistant',
                text: 'Starting',
                timestamp: 0,
                activity: 'Summarising the conversation',
                tools: [{id: 'a', name: 'bash', status: 'running', startedAt: 1}],
                status: 'streaming'
            }
        ])
        const reply = settled[1]
        expect(reply?.status).toBe('aborted')
        expect(reply?.activity).toBeUndefined()
        expect(reply?.tools?.[0]?.status).toBe('error')
    })
})
