import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {Workspace} from './Workspace'
import {ErrorBoundary} from '../application/ErrorBoundary'
import type {Message, StoredChat} from '../../models/chat'
import type {MonacoStubState} from '../../test/monaco-stub'
import {createManualScheduler, immediateScheduler, setScheduler} from '../../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'

const tauri = createDesktopFake()

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {loadMonaco: () => Promise.resolve(stub.monaco)}
})

type ChatRequest = Readonly<{
    requestId: number
    agentMessages: readonly unknown[]
    isRetry: boolean
    messages: readonly {sender: string; text: string}[]
}>
interface StreamChannel {
    onmessage: (payload: {requestId: number; event: unknown}) => void
}

/** Stands in for what the agent remembers, as the worker reports it mid-turn. */
const TRANSCRIPT = [{role: 'user'}, {role: 'assistant'}]

const USAGE = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: {total: 0}
}

/** Every turn the renderer asked the backend to run, in order. */
let sent: ChatRequest[] = []
/** Every chat the renderer asked the backend to store, in order. */
let saved: StoredChat[] = []
/** How the next turn ends. The backend rejects a crashed turn without ever sending `done`. */
let ending: 'done' | 'crash' = 'done'

beforeEach(() => {
    sent = []
    saved = []
    ending = 'done'
    setScheduler(immediateScheduler)
    installDesktopFake(tauri)
    tauri.invoke.mockImplementation(async (command: string, argument?: unknown) => {
        const payload = (argument ?? {}) as Record<string, unknown>
        switch (command) {
            case 'load_chat':
                return {taskId: 'task-1', messages: [], agentMessages: []}
            case 'save_chat':
                saved.push(payload['chat'] as StoredChat)
                return undefined
            case 'load_settings':
                return {settings: {}}
            case 'list_ai_models':
            case 'list_workspace_files':
            case 'list_project_tasks':
                return []
            case 'send_ai_message': {
                const request = payload['request'] as ChatRequest
                const stream = payload['stream'] as StreamChannel
                sent.push(request)
                stream.onmessage({
                    requestId: request.requestId,
                    event: {type: 'text-delta', delta: 'work so far'}
                })
                // The worker checkpoints what it remembers at every step, so a turn that dies after
                // this point has still reported it.
                stream.onmessage({
                    requestId: request.requestId,
                    event: {type: 'turn-state', agentMessages: TRANSCRIPT}
                })
                if (ending === 'crash') throw new Error('the AI worker died')
                stream.onmessage({
                    requestId: request.requestId,
                    event: {
                        type: 'done',
                        text: 'work so far',
                        thinking: '',
                        stopReason: 'stop',
                        agentMessages: TRANSCRIPT,
                        usage: USAGE,
                        model: 'fake'
                    }
                })
                return undefined
            }
            default:
                return undefined
        }
    })
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    vi.clearAllMocks()
})

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
    const composer = await screen.findByRole('textbox', {name: 'Message input'})
    await user.click(composer)
    await user.paste(text)
    await user.keyboard('{Enter}')
    await flush()
}

function storedTexts(chat: StoredChat | undefined) {
    return chat?.messages.map((message: Message) => message.text)
}

describe('Workspace retry', () => {
    it('rewrites the failed reply without deleting any stored turn', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await send(user, 'first prompt')
        ending = 'crash'
        await send(user, 'second prompt')
        await flush()

        const before = saved.at(-1)
        expect(storedTexts(before)).toEqual([
            'first prompt',
            'work so far',
            'second prompt',
            'work so far'
        ])
        expect(before?.messages.at(-1)?.status).toBe('error')

        ending = 'done'
        await user.click(await screen.findByRole('button', {name: 'Retry'}))
        await flush()

        const after = saved.at(-1)
        expect(after?.messages).toHaveLength(before?.messages.length ?? 0)
        expect(storedTexts(after)).toEqual([
            'first prompt',
            'work so far',
            'second prompt',
            'work so far'
        ])
        expect(after?.messages.at(-1)?.status).toBe('complete')
        // Rewritten in place: the row the failed reply was stored under is the row it kept.
        expect(after?.messages.map(message => message.id)).toEqual(
            before?.messages.map(message => message.id)
        )
    })

    it('replays the retried turn without the turns that came after it in the history', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await send(user, 'first prompt')
        ending = 'crash'
        await send(user, 'second prompt')
        ending = 'done'
        await user.click(await screen.findByRole('button', {name: 'Retry'}))
        await flush()

        expect(sent.at(-1)?.messages.map(message => message.text)).toEqual([
            'first prompt',
            'work so far',
            'second prompt'
        ])
    })

    it('offers retry only on the turn at the end of the conversation', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        ending = 'crash'
        await send(user, 'first prompt')
        expect(await screen.findAllByRole('button', {name: 'Retry'})).toHaveLength(1)

        ending = 'done'
        await send(user, 'second prompt')
        await flush()

        expect(screen.queryByRole('button', {name: 'Retry'})).toBeNull()
    })

    it('carries what the agent remembered through a crashed turn into the next one', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        ending = 'crash'
        await send(user, 'first prompt')
        await flush()

        // On disk before anything else happens: a crashed turn is not a turn the model forgets.
        expect(saved.at(-1)?.agentMessages).toEqual(TRANSCRIPT)

        ending = 'done'
        await send(user, 'second prompt')
        await flush()

        expect(sent.at(-1)?.agentMessages).toEqual(TRANSCRIPT)
    })

    it('tells the backend when a turn replaces one that already ran', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        ending = 'crash'
        await send(user, 'first prompt')
        expect(sent.at(-1)?.isRetry).toBe(false)

        ending = 'done'
        await user.click(await screen.findByRole('button', {name: 'Retry'}))
        await flush()

        expect(sent.at(-1)?.isRetry).toBe(true)
    })

    it('writes nothing when the stored chat could not be read', async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'load_chat') throw new Error('the database is locked')
            if (command === 'save_chat') {
                saved.push({messages: [], agentMessages: []})
                return undefined
            }
            if (command === 'load_settings') return {settings: {}}
            return []
        })
        render(<Workspace />)
        await flush()
        await flush()

        expect(saved).toHaveLength(0)
    })

    it('keeps a half-written message in the composer when a turn is retried', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        ending = 'crash'
        await send(user, 'first prompt')

        const composer = await screen.findByRole('textbox', {name: 'Message input'})
        await user.click(composer)
        await user.paste('half written')
        await flush()

        ending = 'done'
        await user.click(await screen.findByRole('button', {name: 'Retry'}))
        await flush()

        expect(composer).toHaveTextContent('half written')
    })
})

describe('Workspace resilience', () => {
    it('drops a stream event it does not recognise instead of drawing it', async () => {
        tauri.invoke.mockImplementation(async (command: string, argument?: unknown) => {
            const payload = (argument ?? {}) as Record<string, unknown>
            if (command === 'load_chat') return {taskId: 'task-1', messages: [], agentMessages: []}
            if (command === 'load_settings') return {settings: {}}
            if (command === 'send_ai_message') {
                const request = payload['request'] as ChatRequest
                const stream = payload['stream'] as StreamChannel
                // A worker one version ahead, or one field renamed: `text` where `delta` is meant.
                stream.onmessage({
                    requestId: request.requestId,
                    event: {type: 'text-delta', text: 'wrong field name'}
                })
                stream.onmessage({requestId: request.requestId, event: {type: 'not-an-event'}})
                stream.onmessage({
                    requestId: request.requestId,
                    event: {type: 'text-delta', delta: 'the real answer'}
                })
                return undefined
            }
            return []
        })
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await send(user, 'go')
        await flush()

        // The window is still a window, and the good delta still landed.
        expect(await screen.findByText('the real answer')).toBeTruthy()
        expect(screen.getByRole('textbox', {name: 'Message input'})).toBeTruthy()
    })

    it('keeps a failed region inside itself', async () => {
        const Broken = () => {
            throw new Error('this component is broken')
        }
        render(
            <ErrorBoundary
                title='This part stopped drawing'
                description='The rest of the window is fine.'
            >
                <Broken />
            </ErrorBoundary>
        )

        expect(await screen.findByText('This part stopped drawing')).toBeTruthy()
        expect(screen.getByRole('button', {name: 'Try again'})).toBeTruthy()
    })
})

describe('Workspace persistence', () => {
    it('saves what the debounce was still holding when the task is switched away', async () => {
        // The real clock never fires here, so nothing but the flush can produce a write.
        const clock = createManualScheduler()
        setScheduler(clock.schedule)
        const user = userEvent.setup()
        const view = render(<Workspace />)
        await flush()

        await send(user, 'the message they are sure they sent')
        await flush()
        expect(saved).toHaveLength(0)

        // Switching tasks changes the workspace's key, which is an unmount.
        view.unmount()
        await flush()

        expect(storedTexts(saved.at(-1))).toContain('the message they are sure they sent')
        expect(saved.at(-1)?.taskId).toBe('task-1')
    })

    it('does not write again when nothing changed since the last save', async () => {
        const user = userEvent.setup()
        const view = render(<Workspace />)
        await flush()

        await send(user, 'saved already')
        await flush()
        const writes = saved.length

        view.unmount()
        await flush()

        expect(saved).toHaveLength(writes)
    })
})

describe('Workspace recovery', () => {
    /**
     * Both chats found in the wild were stored exactly like this: a reply left `streaming` by a
     * window that stopped mid-turn. It came back as a turn that was still working, so the indicator
     * never stopped and Retry — which is offered on a turn that ended badly — was never offered.
     */
    it('picks up a turn the window stopped in the middle of', async () => {
        tauri.invoke.mockImplementation(async (command: string, argument?: unknown) => {
            const payload = (argument ?? {}) as Record<string, unknown>
            if (command === 'load_chat')
                return {
                    taskId: 'task-1',
                    agentMessages: [],
                    messages: [
                        {id: 1, sender: 'user', text: 'Create Mario level 1-1', timestamp: 1},
                        {
                            id: 2,
                            sender: 'assistant',
                            text: "I'll create a Mario level",
                            timestamp: 2,
                            status: 'streaming'
                        }
                    ]
                }
            if (command === 'save_chat') {
                saved.push(payload['chat'] as StoredChat)
                return undefined
            }
            if (command === 'load_settings') return {settings: {}}
            return []
        })
        render(<Workspace />)
        await flush()

        expect(await screen.findByRole('button', {name: 'Retry'})).toBeTruthy()
        expect(saved.at(-1)?.messages.at(-1)?.status).toBe('aborted')
    })
})
