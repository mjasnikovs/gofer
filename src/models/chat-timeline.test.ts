import {describe, expect, it} from 'vitest'
import type {AiStreamEvent, Message, TokenUsage} from './chat'
import {
    applyStreamEvent,
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

    it('drops the compaction label once compaction ends', () => {
        const message = replay([
            {type: 'compaction-start', tokens: 100, contextWindow: 200},
            {type: 'compaction-end'}
        ])
        expect(message.activity).toBeUndefined()
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
