import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {Workspace} from './Workspace'
import {RECONCILE_MS} from '../../hooks/useGodotSession'
import {immediateScheduler, setScheduler} from '../../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'
import {SETTINGS, installBackend} from '../../test/backend'
import type {Backend} from '../../test/backend'
import type {Message, StoredChat} from '../../models/chat'
import type {ProjectMemory} from '../../models/memory'
import type {UserQuestionPrompt} from '../../models/brief'

const tauri = createDesktopFake()

interface Counts {
    list: number
    message: number
    remember: number
    ask: number
}

// The list and each message are counted when their parent renders them again. The two cards are
// counted as Profiler commits, because they also re-render from their own state and context.
const commits = vi.hoisted<Counts>(() => ({list: 0, message: 0, remember: 0, ask: 0}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    return {loadMonaco: () => Promise.resolve(createMonacoStub().monaco)}
})

vi.mock('./ChatConversation', async importOriginal => {
    const {createElement} = await import('react')
    const actual = await importOriginal<typeof import('./ChatConversation')>()
    return {
        ...actual,
        ChatConversation: (props: Parameters<typeof actual.ChatConversation>[0]) => {
            commits.list += 1
            return createElement(actual.ChatConversation, props)
        }
    }
})

vi.mock('@astryxdesign/core/Chat', async importOriginal => {
    const {createElement} = await import('react')
    const actual = await importOriginal<typeof import('@astryxdesign/core/Chat')>()
    return {
        ...actual,
        ChatMessage: (props: Parameters<typeof actual.ChatMessage>[0]) => {
            commits.message += 1
            return createElement(actual.ChatMessage, props)
        }
    }
})

vi.mock('./RememberBlock', async importOriginal => {
    const {createElement, Profiler} = await import('react')
    const actual = await importOriginal<typeof import('./RememberBlock')>()
    return {
        ...actual,
        RememberBlock: (props: Parameters<typeof actual.RememberBlock>[0]) =>
            createElement(
                Profiler,
                {id: 'remember', onRender: () => (commits.remember += 1)},
                createElement(actual.RememberBlock, props)
            )
    }
})

vi.mock('./AskBlock', async importOriginal => {
    const {createElement, Profiler} = await import('react')
    const actual = await importOriginal<typeof import('./AskBlock')>()
    return {
        ...actual,
        AskBlock: (props: Parameters<typeof actual.AskBlock>[0]) =>
            createElement(
                Profiler,
                {id: 'ask', onRender: () => (commits.ask += 1)},
                createElement(actual.AskBlock, props)
            )
    }
})

const TASK = 'task-1'
const REMEMBER_CALL = 'call-remember'
const ASK_CALL = 'call-ask'
const MESSAGES = 20
const TOKENS = 40

function seededMessage(index: number): Message {
    const id = index + 1
    if (index % 2 === 0)
        return {
            id,
            sender: 'user',
            text: `Message ${String(id)}.`,
            timestamp: 0,
            status: 'complete'
        }
    const tools = [
        {
            id: `call-${String(id)}`,
            name: 'read_file',
            target: 'res://player.gd',
            status: 'complete' as const
        },
        ...(id === 2 ?
            [
                {
                    id: REMEMBER_CALL,
                    name: 'remember',
                    target: 'No match.',
                    status: 'complete' as const
                }
            ]
        :   []),
        ...(id === 4 ?
            [{id: ASK_CALL, name: 'ask_user', target: 'Which scene?', status: 'complete' as const}]
        :   [])
    ].map(tool => ({...tool, output: 'Done.', startedAt: 0, endedAt: 1}))
    return {
        id,
        sender: 'assistant',
        text: `Message ${String(id)}.\n\n\`\`\`gdscript\nfunc _ready() -> void:\n\tpass\n\`\`\``,
        tools,
        parts: [
            ...tools.map(tool => ({kind: 'tool' as const, toolId: tool.id})),
            {kind: 'text' as const, text: `Message ${String(id)}.`}
        ],
        timestamp: 0,
        status: 'complete',
        model: 'local-model'
    }
}

const CHAT: StoredChat = {
    taskId: TASK,
    messages: Array.from({length: MESSAGES}, (_, index) => seededMessage(index)),
    agentMessages: []
}

const KEPT: ProjectMemory = {
    id: 'memory-1',
    kind: 'preference',
    state: 'candidate',
    content: 'No match.',
    provenance: {source: 'model', callId: REMEMBER_CALL},
    createdAt: 0,
    updatedAt: 0,
    check: 'unanchored',
    anchors: []
}

const QUESTION: UserQuestionPrompt = {
    questionId: 'q-1',
    question: 'Which scene?',
    options: ['main', 'menu'],
    sketches: [],
    why: 'it changes the tree',
    revision: 1,
    isDelegated: false,
    canStopAsking: false
}

let server: Backend

beforeEach(() => {
    setScheduler(immediateScheduler)
    installDesktopFake(tauri)
    server = installBackend(tauri, {
        chat: CHAT,
        memories: [KEPT],
        // The real bridge hands back a parsed copy, never the object the fake holds.
        answers: {load_chat: (_, answer) => structuredClone(answer())}
    })
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    vi.clearAllMocks()
})

async function openChat() {
    render(<Workspace taskId={TASK} />)
    await flush()
    await screen.findByText('Message 20.')
    await flush()
}

/** Every listener the window holds for the event, as the real bus would call them. */
async function announce(event: string, payload: unknown) {
    await act(async () => {
        tauri.emit(event, payload)
        await Promise.resolve()
    })
    await flush()
}

/** What the chat committed while `work` ran. */
async function costOf(work: () => Promise<void>): Promise<Counts> {
    const before = {...commits}
    await work()
    return {
        list: commits.list - before.list,
        message: commits.message - before.message,
        remember: commits.remember - before.remember,
        ask: commits.ask - before.ask
    }
}

const NOTHING: Counts = {list: 0, message: 0, remember: 0, ask: 0}

describe('what the rest of the window costs the chat', () => {
    it('seeds a chat that shows a remember card and an ask card', async () => {
        await openChat()

        expect(commits.message).toBeGreaterThanOrEqual(MESSAGES)
        expect(commits.remember).toBeGreaterThan(0)
        expect(commits.ask).toBeGreaterThan(0)
    })

    it('redraws nothing when the settings are saved', async () => {
        await openChat()

        expect(await costOf(() => announce('settings-saved', SETTINGS))).toEqual(NOTHING)
    })

    it('redraws nothing while a message is typed', async () => {
        const user = userEvent.setup()
        await openChat()
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await flush()

        const cost = await costOf(async () => {
            await user.keyboard('a message typed one key at a time')
            await flush()
        })

        expect(cost).toEqual(NOTHING)
    })

    it('redraws nothing when files change on disk', async () => {
        await openChat()

        const cost = await costOf(async () => {
            await act(async () => {
                server.publishFileChanges([{path: 'scripts/player.gd', kind: 'modified'}])
                await Promise.resolve()
            })
            await flush()
        })

        expect(cost).toEqual(NOTHING)
    })

    it('redraws nothing when a tool asks for approval and is answered', async () => {
        await openChat()

        const cost = await costOf(async () => {
            await announce('ai-approval-request', {approvalId: 'a-1', tool: 'bash', calls: []})
            await announce('ai-approval-settled', {approvalId: 'a-1', approved: true})
        })

        expect(cost).toEqual(NOTHING)
    })

    it('redraws only the ask cards when the model asks the user', async () => {
        await openChat()

        const cost = await costOf(async () => {
            await announce('ai-question-request', QUESTION)
            await announce('ai-question-settled', {questionId: 'q-1'})
        })

        expect(cost).toEqual({...NOTHING, ask: 3})
    })

    it('redraws every message when an outside agent rewrites the chat', async () => {
        await openChat()

        const cost = await costOf(() => announce('chat-changed', {taskId: TASK}))

        expect(cost).toEqual({list: 1, message: MESSAGES, remember: 1, ask: 1})
    })

    it('redraws the list and only the streaming message for each token', async () => {
        const user = userEvent.setup()
        await openChat()
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.paste('go')
        await user.keyboard('{Enter}')
        await flush()

        const cost = await costOf(async () => {
            for (let index = 0; index < TOKENS; index += 1) {
                await act(async () => {
                    server.publishStream({
                        requestId: 1,
                        event: {type: 'text-delta', delta: 'word '}
                    } as never)
                    await Promise.resolve()
                })
            }
            await flush()
        })

        expect(cost).toEqual({...NOTHING, list: TOKENS, message: TOKENS})
    })

    it.each(['memories', 'sketches', 'changes', 'board'])(
        'redraws nothing when the project says its %s changed',
        async what => {
            await openChat()

            expect(await costOf(() => announce('project-changed', {what}))).toEqual(NOTHING)
        }
    )

    it('redraws nothing when the window comes back into focus', async () => {
        await openChat()

        const cost = await costOf(async () => {
            await act(async () => {
                window.dispatchEvent(new FocusEvent('focus'))
                await Promise.resolve()
            })
            await flush()
        })

        expect(cost).toEqual(NOTHING)
    })

    it('redraws only the remember card whose memory the user kept', async () => {
        await openChat()

        const cost = await costOf(async () => {
            server.state.memories = server.state.memories.map(row => ({
                ...row,
                state: 'confirmed' as const
            }))
            await announce('project-changed', {what: 'memories'})
        })

        // Two commits, the same as the cache this one replaced cost for the same press.
        expect(cost).toEqual({...NOTHING, remember: 2})
    })

    it('redraws nothing when the memory list is read again unchanged', async () => {
        await openChat()

        const cost = await costOf(() => announce('project-changed', {what: 'memories'}))

        expect(cost).toEqual(NOTHING)
    })

    it('redraws nothing on a session heartbeat that read the same session back', async () => {
        vi.useFakeTimers({shouldAdvanceTime: true})
        try {
            const user = userEvent.setup({advanceTimers: vi.advanceTimersByTime})
            await openChat()
            await user.click(
                within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
                    name: 'Start Godot'
                })
            )
            await flush()

            const cost = await costOf(async () => {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(RECONCILE_MS * 5)
                })
                await flush()
            })

            expect(cost).toEqual(NOTHING)
        } finally {
            vi.useRealTimers()
        }
    })
})
