import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {InitializationSplash} from '../components/application/InitializationSplash'
import {Navigation} from '../components/application/Navigation'
import {SettingsPage} from '../components/settings/SettingsPage'
import {Workspace} from '../components/workspace/Workspace'
import type {StoredChat} from '../models/chat'

type InvokeFunction = (command: string, args?: unknown) => Promise<unknown>
type IsTauriFunction = () => boolean
type EventHandler = (event: {payload: never}) => void
type ListenFunction = (event?: string, handler?: EventHandler) => Promise<() => void>

const tauri = vi.hoisted(() => ({
    invoke: vi.fn<InvokeFunction>(),
    isTauri: vi.fn<IsTauriFunction>(),
    listen: vi.fn<ListenFunction>()
}))

vi.mock('../services/desktop', () => ({
    invoke: tauri.invoke,
    isTauri: tauri.isTauri,
    listen: tauri.listen
}))

const settingsResponse = {
    settings: {
        version: 1,
        ai: {
            connectionType: 'openai-compatible',
            name: 'Local AI',
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'local-model',
            api: 'openai-completions'
        }
    },
    hasApiKey: true
} as const

const incompleteCache = {
    path: '/tmp/gofer-rag',
    sizeBytes: 42,
    state: 'incomplete'
} as const

beforeEach(() => {
    window.localStorage.clear()
    tauri.isTauri.mockReturnValue(true)
    tauri.listen.mockResolvedValue(vi.fn())
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('InitializationSplash', () => {
    it('has no automatically detectable accessibility violations in its error state', async () => {
        tauri.isTauri.mockReturnValue(false)
        const {container} = render(<InitializationSplash onReady={vi.fn()} />)

        await screen.findByText('Models could not be initialized')
        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })

    it('explains that model initialization requires the desktop app', async () => {
        tauri.isTauri.mockReturnValue(false)

        render(<InitializationSplash onReady={vi.fn()} />)

        expect(await screen.findByText('Models could not be initialized')).toBeInTheDocument()
        expect(
            screen.getByText(/Model initialization requires the desktop app/)
        ).toBeInTheDocument()
        expect(tauri.invoke).not.toHaveBeenCalled()
    })

    it('subscribes before initialization, cleans up, and signals readiness', async () => {
        const calls: string[] = []
        const unlisten = vi.fn()
        const onReady = vi.fn()
        tauri.listen.mockImplementation(async () => {
            calls.push('listen')
            return unlisten
        })
        tauri.invoke.mockImplementation(async () => {
            calls.push('invoke')
        })

        render(<InitializationSplash onReady={onReady} />)

        await waitFor(() => {
            expect(onReady).toHaveBeenCalledOnce()
        })
        expect(calls).toEqual(['listen', 'invoke'])
        expect(unlisten).toHaveBeenCalledOnce()
    })

    it('shows listener registration failures and allows retrying', async () => {
        tauri.listen.mockRejectedValueOnce(new Error('event system unavailable'))
        tauri.invoke.mockResolvedValue(undefined)
        const onReady = vi.fn()

        render(<InitializationSplash onReady={onReady} />)

        expect(await screen.findByText(/event system unavailable/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Try again'}))
        await waitFor(() => {
            expect(onReady).toHaveBeenCalledOnce()
        })
    })
})

describe('SettingsPage', () => {
    function loadSettings() {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'load_settings') return settingsResponse
            if (command === 'get_rag_cache_status') return incompleteCache
            if (command === 'test_ai_connection') {
                return {status: 'connected', message: 'Connected.'}
            }
            if (command === 'list_ai_models') return []
            return undefined
        })
    }

    it('loads settings and sends keep, set, and clear API-key intents', async () => {
        loadSettings()
        render(
            <SettingsPage
                isOpen
                onOpenChange={vi.fn()}
                onCacheDeleted={vi.fn()}
            />
        )
        const user = userEvent.setup()

        expect(await screen.findByDisplayValue('Local AI')).toBeInTheDocument()
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        const keepRequest = tauri.invoke.mock.calls.find(call => call[0] === 'test_ai_connection')
        expect(keepRequest?.[1]).toMatchObject({request: {apiKey: {action: 'keep'}}})

        await user.type(screen.getByPlaceholderText('Stored securely'), ' new-secret ')
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        const setRequest = tauri.invoke.mock.calls
            .filter(call => call[0] === 'test_ai_connection')
            .at(-1)
        expect(setRequest?.[1]).toMatchObject({
            request: {apiKey: {action: 'set', value: ' new-secret '}}
        })

        await user.click(screen.getByRole('button', {name: 'Remove stored API key'}))
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        const clearRequest = tauri.invoke.mock.calls
            .filter(call => call[0] === 'test_ai_connection')
            .at(-1)
        expect(clearRequest?.[1]).toMatchObject({request: {apiKey: {action: 'clear'}}})
    })

    it('reports model listener failures and restores the cache state', async () => {
        loadSettings()
        render(
            <SettingsPage
                isOpen
                onOpenChange={vi.fn()}
                onCacheDeleted={vi.fn()}
            />
        )
        const user = userEvent.setup()

        await screen.findByDisplayValue('Local AI')
        tauri.listen.mockRejectedValueOnce(new Error('listener unavailable'))
        await user.click(screen.getByRole('button', {name: 'Download models'}))

        expect(await screen.findByText(/listener unavailable/)).toBeInTheDocument()
        expect(screen.getByText('Incomplete')).toBeInTheDocument()
    })

    it('closes without starting a new task', async () => {
        loadSettings()
        const onOpenChange = vi.fn()
        render(
            <SettingsPage
                isOpen
                onOpenChange={onOpenChange}
                onCacheDeleted={vi.fn()}
            />
        )

        await userEvent.click(screen.getByRole('button', {name: 'Close'}))

        expect(onOpenChange).toHaveBeenCalledWith(false)
        expect(tauri.invoke).not.toHaveBeenCalledWith('clear_chat_attachments')
    })
})

describe('Workspace', () => {
    it('disposes a process listener that finishes registering after unmount', async () => {
        const dispose = vi.fn()
        let resolveListen: ((dispose: () => void) => void) | undefined
        tauri.listen.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveListen = resolve
                })
        )

        const rendered = render(<Workspace />)
        await waitFor(() => {
            expect(tauri.listen).toHaveBeenCalledWith('godot-process-event', expect.any(Function))
        })
        rendered.unmount()
        resolveListen?.(dispose)

        await waitFor(() => {
            expect(dispose).toHaveBeenCalledOnce()
        })
    })

    it('attaches and sends an image without requiring text', async () => {
        tauri.invoke.mockImplementation(async command => {
            if (command === 'load_settings') {
                return {
                    ...settingsResponse,
                    settings: {
                        ...settingsResponse.settings,
                        ai: {...settingsResponse.settings.ai, input: ['text', 'image']}
                    }
                }
            }
            if (command === 'list_ai_models') {
                return [
                    {
                        id: 'local-model',
                        name: 'Local model',
                        contextWindow: 120_064,
                        maxTokens: 120_064,
                        reasoning: false,
                        supportsReasoningEffort: false,
                        input: ['text', 'image']
                    }
                ]
            }
            return undefined
        })
        render(<Workspace />)

        const attachButton = await screen.findByRole('button', {name: 'Attach images'})
        expect(attachButton).toBeEnabled()
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')
        if (!input) throw new Error('Attachment input was not rendered')
        await userEvent.upload(input, new File(['hi'], 'scene.png', {type: 'image/png'}))

        expect(await screen.findByAltText('Attached image: scene.png')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))

        await waitFor(() => {
            const saveCall = tauri.invoke.mock.calls.find(
                call => call[0] === 'save_chat_attachment'
            )
            const serializedSaveRequest = JSON.stringify(saveCall?.[1])
            expect(serializedSaveRequest).toContain('"name":"scene.png"')
            expect(serializedSaveRequest).toContain('"mimeType":"image/png"')
            expect(serializedSaveRequest).toContain('"size":2')
            expect(serializedSaveRequest).toContain('"data":"aGk="')
            expect(serializedSaveRequest).toMatch(/"id":"[a-z\d-]+"/u)
            expect(tauri.invoke).toHaveBeenCalledWith('send_ai_message', {
                request: {
                    requestId: 1,
                    agentMessages: [],
                    messages: [
                        expect.objectContaining({
                            sender: 'user',
                            text: '',
                            attachments: [
                                expect.objectContaining({
                                    name: 'scene.png',
                                    mimeType: 'image/png',
                                    size: 2
                                })
                            ]
                        })
                    ]
                }
            })
        })
        expect(window.localStorage.getItem('gofer.agent-chat.v1')).toBeNull()
    })

    it('loads project chat from Rust storage', async () => {
        tauri.invoke.mockImplementation(async command => {
            if (command === 'load_chat') {
                return {
                    taskId: '0198f4c0-02ef-7000-8000-000000000001',
                    messages: [
                        {id: 7, sender: 'user', text: 'Persisted project message', timestamp: 10}
                    ],
                    agentMessages: []
                }
            }
            return undefined
        })

        render(<Workspace />)

        expect(await screen.findByText('Persisted project message')).toBeInTheDocument()
        await waitFor(() => {
            const saveCall = tauri.invoke.mock.calls.find(call => call[0] === 'save_chat')
            expect(saveCall?.[1]).toMatchObject({
                chat: {taskId: '0198f4c0-02ef-7000-8000-000000000001'}
            })
        })
    })

    it('coalesces chat snapshots while a save is already running', async () => {
        let resolveFirstSave: (() => void) | undefined
        tauri.invoke.mockImplementation((command, args) => {
            if (command === 'load_chat') {
                return Promise.resolve({taskId: 'task-1', messages: [], agentMessages: []})
            }
            if (command === 'save_chat') {
                const saveCount = tauri.invoke.mock.calls.filter(
                    call => call[0] === 'save_chat'
                ).length
                if (saveCount === 1) {
                    return new Promise<void>(resolve => {
                        resolveFirstSave = resolve
                    })
                }
            }
            return Promise.resolve(args)
        })
        render(<Workspace />)

        await waitFor(() => {
            expect(tauri.invoke.mock.calls.filter(call => call[0] === 'save_chat')).toHaveLength(1)
        })
        await userEvent.type(screen.getByRole('textbox'), 'First{enter}')
        await waitFor(() => {
            expect(screen.getByRole('textbox')).toBeEnabled()
        })
        await userEvent.type(screen.getByRole('textbox'), 'Second{enter}')
        await new Promise(resolve => window.setTimeout(resolve, 250))

        expect(tauri.invoke.mock.calls.filter(call => call[0] === 'save_chat')).toHaveLength(1)
        resolveFirstSave?.()
        await waitFor(() => {
            expect(tauri.invoke.mock.calls.filter(call => call[0] === 'save_chat')).toHaveLength(2)
        })
        const latestSave = tauri.invoke.mock.calls.filter(call => call[0] === 'save_chat').at(-1)
        const latestChat = (latestSave?.[1] as {chat: StoredChat} | undefined)?.chat
        expect(latestChat?.taskId).toBe('task-1')
        expect(
            latestChat?.messages
                .filter(message => message.sender === 'user')
                .map(message => message.text)
        ).toEqual(['First', 'Second'])
    })

    it('loads each persisted attachment preview only once across message updates', async () => {
        tauri.invoke.mockImplementation(async command => {
            if (command === 'load_chat') {
                return {
                    messages: [
                        {
                            id: 7,
                            sender: 'user',
                            text: 'Persisted image',
                            timestamp: 10,
                            attachments: [
                                {
                                    id: 'attachment-1',
                                    name: 'scene.png',
                                    mimeType: 'image/png',
                                    size: 2
                                }
                            ]
                        }
                    ],
                    agentMessages: []
                }
            }
            if (command === 'read_chat_attachment') return 'data:image/png;base64,aGk='
            return undefined
        })

        render(<Workspace />)

        expect(await screen.findByAltText('Attached image: scene.png')).toHaveAttribute(
            'src',
            'data:image/png;base64,aGk='
        )
        await userEvent.type(screen.getByRole('textbox'), 'Continue{enter}')
        await waitFor(() => {
            expect(
                tauri.invoke.mock.calls.filter(call => call[0] === 'read_chat_attachment')
            ).toHaveLength(1)
        })
    })

    it('imports legacy localStorage chat once', async () => {
        const legacy = {
            messages: [{id: 3, sender: 'user', text: 'Legacy message', timestamp: 10}],
            agentMessages: []
        }
        window.localStorage.setItem('gofer.agent-chat.v1', JSON.stringify(legacy))
        tauri.invoke.mockImplementation(async (command, args) => {
            if (command === 'load_chat') return {messages: [], agentMessages: []}
            if (command === 'import_legacy_chat') {
                return (args as {chat: typeof legacy}).chat
            }
            return undefined
        })

        render(<Workspace />)

        expect(await screen.findByText('Legacy message')).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledWith('import_legacy_chat', {chat: legacy})
        expect(window.localStorage.getItem('gofer.agent-chat.v1')).toBeNull()
    })

    it('streams a Pi AI response into the assistant message', async () => {
        let handler: EventHandler | undefined
        tauri.listen.mockImplementation(async (_event, nextHandler) => {
            handler = nextHandler
            return () => undefined
        })
        tauri.invoke.mockImplementation(async command => {
            if (command === 'send_ai_message') {
                handler?.({
                    payload: {
                        requestId: 1,
                        event: {type: 'text-delta', delta: 'Hello from local AI'}
                    } as never
                })
            }
            return undefined
        })
        render(<Workspace />)

        await userEvent.type(screen.getByRole('textbox'), 'Say hello{enter}')

        expect(await screen.findByText('Hello from local AI')).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledWith('send_ai_message', {
            request: {
                requestId: 1,
                agentMessages: [],
                messages: [expect.objectContaining({sender: 'user', text: 'Say hello'})]
            }
        })
    })

    it('renders agent tool activity and token usage', async () => {
        let handler: EventHandler | undefined
        tauri.listen.mockImplementation(async (_event, nextHandler) => {
            handler = nextHandler
            return () => undefined
        })
        tauri.invoke.mockImplementation(async command => {
            if (command === 'load_settings') return settingsResponse
            if (command === 'list_ai_models') {
                return [
                    {
                        id: 'local-model',
                        name: 'Local model',
                        contextWindow: 120_064,
                        maxTokens: 120_064,
                        reasoning: false,
                        supportsReasoningEffort: false,
                        input: ['text']
                    }
                ]
            }
            if (command === 'send_ai_message') {
                const events = [
                    {
                        type: 'tool-start',
                        id: 'tool-1',
                        name: 'bash',
                        target: 'pwd',
                        startedAt: 10
                    },
                    {
                        type: 'tool-end',
                        id: 'tool-1',
                        output: '/workspace',
                        isError: false,
                        endedAt: 20
                    },
                    {type: 'text-delta', delta: 'Finished'},
                    {
                        type: 'done',
                        text: 'Finished',
                        thinking: '',
                        stopReason: 'stop',
                        model: 'local-model',
                        agentMessages: [],
                        usage: {
                            input: 10,
                            output: 2,
                            cacheRead: 0,
                            cacheWrite: 0,
                            reasoning: 0,
                            totalTokens: 12,
                            cost: {total: 0}
                        }
                    }
                ]
                for (const event of events) {
                    handler?.({payload: {requestId: 1, event} as never})
                }
            }
            return undefined
        })
        render(<Workspace />)

        await screen.findByText('Local AI connected')
        await userEvent.type(screen.getByRole('textbox'), 'Inspect workspace{enter}')

        expect(await screen.findByText('Finished')).toBeInTheDocument()
        expect(screen.getByText('bash')).toBeInTheDocument()
        expect(screen.getByText('pwd')).toBeInTheDocument()
        expect(screen.getByText(/10 in/)).toBeInTheDocument()
        expect(screen.getByText('0.01K / 120K')).toBeInTheDocument()
        expect(screen.queryByText('local-model')).not.toBeInTheDocument()
    })

    it('asks the user before the agent runs a gated tool call, and answers the backend', async () => {
        const handlers = new Map<string, EventHandler>()
        tauri.listen.mockImplementation(async (event, handler) => {
            if (event && handler) handlers.set(event, handler)
            return vi.fn<() => void>()
        })
        tauri.invoke.mockResolvedValue(undefined)
        render(<Workspace />)
        await waitFor(() => {
            expect(handlers.has('ai-approval-request')).toBe(true)
        })
        const raise = (approvalId: string, op: string, params: Record<string, unknown>) => {
            handlers.get('ai-approval-request')?.({
                payload: {
                    approvalId,
                    tool: 'godot_resource',
                    op,
                    reason: 'Deleting a file removes it from the task worktree.',
                    params
                } as never
            })
        }

        raise('approval-1', 'delete', {path: 'scenes/main.tscn'})
        // A second prompt queues behind the first rather than stacking a second dialog.
        raise('approval-2', 'move', {from: 'a.gd', to: 'b.gd'})
        expect(
            await screen.findByText(/The agent is waiting to run godot_resource delete/)
        ).toBeInTheDocument()
        expect(screen.getByText(/scenes\/main.tscn/)).toBeInTheDocument()
        expect(screen.queryByText(/godot_resource move/)).not.toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Reject'}))
        expect(tauri.invoke).toHaveBeenCalledWith('respond_tool_approval', {
            request: {approvalId: 'approval-1', approved: false}
        })

        expect(await screen.findByText(/a.gd → b.gd/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Approve'}))
        expect(tauri.invoke).toHaveBeenCalledWith('respond_tool_approval', {
            request: {approvalId: 'approval-2', approved: true}
        })

        // A prompt the backend settles on its own — a timeout, or a cancelled turn — closes too.
        raise('approval-3', 'delete', {path: 'scenes/other.tscn'})
        expect(await screen.findByText(/scenes\/other.tscn/)).toBeInTheDocument()
        handlers.get('ai-approval-settled')?.({
            payload: {approvalId: 'approval-3', approved: false} as never
        })
        await waitFor(() => {
            expect(screen.queryByText(/scenes\/other.tscn/)).not.toBeInTheDocument()
        })
    })
})

describe('Navigation', () => {
    it('lists persistent tasks and activates the selected task', async () => {
        const onNewTask = vi.fn()
        const onOpenTask = vi.fn()
        render(
            <Navigation
                page='workspace'
                selectedTaskId='task-1'
                tasks={[
                    {
                        id: 'task-1',
                        title: 'Player controller',
                        status: 'active',
                        isCurrent: true,
                        createdAt: 10,
                        updatedAt: 20
                    },
                    {
                        id: 'task-2',
                        title: 'Inventory UI',
                        status: 'active',
                        isCurrent: false,
                        createdAt: 11,
                        updatedAt: 19
                    }
                ]}
                onNavigate={vi.fn()}
                onNewTask={onNewTask}
                onOpenTask={onOpenTask}
            />
        )

        await userEvent.click(screen.getByText('Inventory UI'))
        await userEvent.click(screen.getByText('New task'))

        expect(screen.getByText('Inventory UI').closest('a')).toHaveAttribute(
            'href',
            '#/tasks/task-2'
        )
        expect(onOpenTask).toHaveBeenCalledWith('task-2')
        expect(onNewTask).toHaveBeenCalledOnce()
    })
})
