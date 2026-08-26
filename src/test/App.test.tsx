import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {InitializationSplash} from '../components/application/InitializationSplash'
import {Navigation} from '../components/application/Navigation'
import {SettingsPage} from '../components/settings/SettingsPage'
import {Workspace} from '../components/workspace/Workspace'
import type {TaskSummary} from '../models/app'
import {DEFAULT_SIDE_NAV_LAYOUT} from '../models/ui-state'
import type {StoredChat, TokenUsage} from '../models/chat'
import {immediateScheduler, setScheduler} from '../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from './desktop-driver'
import {flush} from './flush'
import {installBackend} from './backend'
import type {BackendAnswers} from './backend'

type EventHandler = (event: {payload: never}) => void
interface AiStream {
    onmessage: (payload: unknown) => void
}

const tauri = createDesktopFake()

/** The shared in-memory backend, with this test's own answers over the top. */
const backend = (answers: BackendAnswers = {}) => installBackend(tauri, {answers})

/** The channel `send_ai_message` now streams its deltas down, as the fixture receives it. */
const emptyUsage: TokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {total: 0}
}

/**
 * The stream channel for one `send_ai_message`, with the turn's own request id stamped on
 * everything sent down it.
 *
 * Stamped rather than written by the test, because the id is process-wide: a test is not the first
 * turn this file runs, and a hard-coded one is an event the runner drops as belonging to somebody
 * else's turn. See `nextRequestId` in `services/turn.ts` for why the counter is not per runner.
 */
function streamOf(args: unknown): AiStream {
    const stream = (args as {stream?: AiStream} | undefined)?.stream
    if (!stream) throw new Error('send_ai_message was invoked without its stream channel')
    const requestId = (args as {request?: {requestId?: number}} | undefined)?.request?.requestId
    return {
        onmessage: payload => {
            stream.onmessage({...(payload as object), requestId})
        }
    }
}

const settingsResponse = {
    settings: {
        version: 1,
        ai: {
            connectionType: 'openai-compatible',
            connections: {
                'openai-compatible': {
                    name: 'Local AI',
                    baseUrl: 'http://127.0.0.1:8080/v1',
                    api: 'openai-completions',
                    chatTemplateThinking: false,
                    model: {id: 'local-model', name: 'local-model', input: ['text']}
                }
            }
        }
    },
    hasApiKey: true
} as const

const agentPrompt = {
    prompt: 'You are Gofer, a capable local coding agent.',
    defaultPrompt: 'You are Gofer, a capable local coding agent.'
} as const

const incompleteCache = {
    path: '/tmp/gofer-rag',
    sizeBytes: 42,
    state: 'incomplete'
} as const

beforeEach(() => {
    /*
     * Interface state is written through a 250 ms debounce. It coalesces a drag or a burst of
     * typing into one write; it does not decide what is written. Running it on the spot here keeps
     * that out of the test's budget, so an assertion about a stored layout is never also a race
     * against the clock on a loaded machine.
     */
    setScheduler(immediateScheduler)
    window.localStorage.clear()
    installDesktopFake(tauri)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    vi.clearAllMocks()
})

describe('InitializationSplash', () => {
    it('has no automatically detectable accessibility violations in its error state', async () => {
        tauri.isTauri.mockReturnValue(false)
        const {container} = render(<InitializationSplash onReady={vi.fn()} />)

        await flush()
        expect(screen.getByText('Models could not be initialized')).toBeInTheDocument()
        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })

    it('explains that model initialization requires the desktop app', async () => {
        tauri.isTauri.mockReturnValue(false)

        render(<InitializationSplash onReady={vi.fn()} />)

        await flush()
        expect(screen.getByText('Models could not be initialized')).toBeInTheDocument()
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
        tauri.invoke.mockImplementation(async command => {
            calls.push(command)
            return command === 'get_rag_cache_status' ?
                    {path: '/cache', sizeBytes: 0, state: 'not-installed'}
                :   undefined
        })

        render(<InitializationSplash onReady={onReady} />)

        await flush()

        expect(onReady).toHaveBeenCalledOnce()
        expect(calls).toEqual(['listen', 'get_rag_cache_status', 'initialize_rag'])
        expect(unlisten).toHaveBeenCalledOnce()
    })

    /**
     * The failure this pins is five seconds of splash on every launch, doing work already done.
     * `initialize_rag` spawns a sidecar that loads 1.8 GB of models into a process which then
     * exits: measured at 5,088ms with every model file already present, and the memory it loads
     * is thrown away when the process goes. The splash gates the whole application, so the user
     * waits it out each time.
     */
    it('does not reinstall models that are already installed', async () => {
        const calls: string[] = []
        const onReady = vi.fn()
        tauri.listen.mockResolvedValue(vi.fn())
        tauri.invoke.mockImplementation(async command => {
            calls.push(command)
            return command === 'get_rag_cache_status' ?
                    {path: '/cache', sizeBytes: 1_823_614_836, state: 'installed'}
                :   undefined
        })

        render(<InitializationSplash onReady={onReady} />)

        await flush()

        expect(calls).toEqual(['get_rag_cache_status'])
        expect(calls).not.toContain('initialize_rag')
        expect(onReady).toHaveBeenCalledOnce()
    })

    it('still installs when the cache is half written', async () => {
        const calls: string[] = []
        tauri.listen.mockResolvedValue(vi.fn())
        tauri.invoke.mockImplementation(async command => {
            calls.push(command)
            return command === 'get_rag_cache_status' ?
                    {path: '/cache', sizeBytes: 12, state: 'incomplete'}
                :   undefined
        })

        render(<InitializationSplash onReady={vi.fn()} />)

        await flush()

        expect(calls).toContain('initialize_rag')
    })

    it('shows listener registration failures and allows retrying', async () => {
        tauri.listen.mockRejectedValueOnce(new Error('event system unavailable'))
        tauri.invoke.mockResolvedValue(undefined)
        const onReady = vi.fn()

        render(<InitializationSplash onReady={onReady} />)

        await flush()
        expect(screen.getByText(/event system unavailable/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Try again'}))
        await flush()

        expect(onReady).toHaveBeenCalledOnce()
    })
})

describe('SettingsPage', () => {
    function loadSettings() {
        backend({
            load_settings: () => settingsResponse,
            read_agent_prompt: () => agentPrompt,
            get_rag_cache_status: () => incompleteCache
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

        await flush()
        expect(screen.getByDisplayValue('Local AI')).toBeInTheDocument()
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        const keepRequest = tauri.invoke.mock.calls.find(call => call[0] === 'test_ai_connection')
        expect(keepRequest?.[1]).toMatchObject({request: {apiKey: {action: 'keep'}}})

        // Each click below sends the intent the *previous* interaction set, and React commits that
        // state on its own schedule rather than by the time the interaction's promise resolves. On
        // a loaded machine an unwaited click reads the state before it lands and tests the previous
        // intent twice, so every interaction here waits for the render that proves it took effect.
        // By label: a stored key no longer puts a sentence in the placeholder, because a
        // placeholder reads as a typed value.
        await user.type(screen.getByLabelText(/^API key/), ' new-secret ')
        // `toHaveValue` rather than `findByDisplayValue`: the surrounding spaces are the point of
        // this key, and the display-value query normalizes them away before it compares.
        await flush()

        expect(screen.getByLabelText(/^API key/)).toHaveValue(' new-secret ')
        await user.click(screen.getByRole('button', {name: 'Test connection'}))
        const setRequest = tauri.invoke.mock.calls
            .filter(call => call[0] === 'test_ai_connection')
            .at(-1)
        expect(setRequest?.[1]).toMatchObject({
            request: {apiKey: {action: 'set', value: ' new-secret '}}
        })

        await user.click(screen.getByRole('button', {name: 'Remove stored API key'}))
        // The button renames itself once the stored key is marked for removal: that render is the
        // proof the intent is `clear` before the connection test reads it.
        await flush()
        expect(screen.getByRole('button', {name: 'Keep stored API key'})).toBeInTheDocument()
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

        await flush()
        expect(screen.getByDisplayValue('Local AI')).toBeInTheDocument()
        await user.click(screen.getByRole('button', {name: 'Documentation models'}))
        await flush()
        tauri.listen.mockRejectedValueOnce(new Error('listener unavailable'))
        await user.click(screen.getByRole('button', {name: 'Download models'}))

        await flush()
        expect(screen.getByText(/listener unavailable/)).toBeInTheDocument()
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
    it('disposes a session listener that finishes registering after unmount', async () => {
        const dispose = vi.fn()
        let resolveListen: ((dispose: () => void) => void) | undefined
        tauri.listen.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveListen = resolve
                })
        )

        const rendered = render(<Workspace />)
        await flush()

        expect(tauri.listen).toHaveBeenCalledWith('godot-session-event', expect.any(Function))
        rendered.unmount()
        resolveListen?.(dispose)

        await flush()

        expect(dispose).toHaveBeenCalledOnce()
    })

    it('attaches and sends an image without requiring text', async () => {
        backend({
            load_settings: () => ({
                ...settingsResponse,
                settings: {
                    ...settingsResponse.settings,
                    ai: {
                        ...settingsResponse.settings.ai,
                        connections: {
                            'openai-compatible': {
                                ...settingsResponse.settings.ai.connections['openai-compatible'],
                                model: {
                                    id: 'local-model',
                                    name: 'local-model',
                                    input: ['text', 'image']
                                }
                            }
                        }
                    }
                }
            }),
            list_ai_models: () => [
                {
                    id: 'local-model',
                    name: 'Local model',
                    contextWindow: 120_064,
                    maxTokens: 120_064,
                    reasoning: false,
                    supportsReasoningEffort: false,
                    thinkingLevels: [],
                    input: ['text', 'image']
                }
            ]
        })
        render(<Workspace />)

        await flush()
        const attachButton = screen.getByRole('button', {name: 'Attach images'})
        expect(attachButton).toBeEnabled()
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')
        if (!input) throw new Error('Attachment input was not rendered')
        await userEvent.upload(input, new File(['hi'], 'scene.png', {type: 'image/png'}))

        await flush()
        expect(screen.getByAltText('Attached image: scene.png')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))

        await flush()

        const saveCall = tauri.invoke.mock.calls.find(call => call[0] === 'save_chat_attachment')
        const serializedSaveRequest = JSON.stringify(saveCall?.[1])
        expect(serializedSaveRequest).toContain('"name":"scene.png"')
        expect(serializedSaveRequest).toContain('"mimeType":"image/png"')
        expect(serializedSaveRequest).toContain('"size":2')
        expect(serializedSaveRequest).toContain('"data":"aGk="')
        expect(serializedSaveRequest).toMatch(/"id":"[a-z\d-]+"/u)
        expect(tauri.invoke).toHaveBeenCalledWith('send_ai_message', {
            stream: expect.anything() as unknown,
            request: {
                requestId: expect.any(Number) as number,
                taskId: 'task-1',
                agentMessages: [],
                isRetry: false,
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
        expect(window.localStorage.getItem('gofer.agent-chat.v1')).toBeNull()
    })

    it('loads project chat from Rust storage', async () => {
        backend({
            load_chat: () => ({
                taskId: '0198f4c0-02ef-7000-8000-000000000001',
                messages: [
                    {id: 7, sender: 'user', text: 'Persisted project message', timestamp: 10}
                ],
                agentMessages: []
            })
        })

        render(<Workspace />)

        await flush()
        expect(screen.getByText('Persisted project message')).toBeInTheDocument()
        await flush()

        const saveCall = tauri.invoke.mock.calls.find(call => call[0] === 'save_chat')
        expect(saveCall?.[1]).toMatchObject({
            chat: {taskId: '0198f4c0-02ef-7000-8000-000000000001'}
        })
    })

    /*
     * The unsent message is part of the conversation, so it is kept with the task and comes back
     * with it. Losing a half-written prompt to a window close is losing work.
     */
    it('keeps an unsent message with its task and restores it', async () => {
        const drafts: Record<string, string | undefined> = {
            'ui.draft.0198f4c0-02ef-7000-8000-000000000001': 'Half a thought about the'
        }
        backend({
            load_chat: () => ({
                taskId: '0198f4c0-02ef-7000-8000-000000000001',
                messages: [],
                agentMessages: []
            }),
            read_project_state: ({key}) => {
                const stored = drafts[key]
                return stored === undefined ? null : JSON.stringify(stored)
            },
            write_project_state: ({key, value}) => {
                drafts[key] = value === undefined ? undefined : (JSON.parse(value) as string)
                return undefined
            }
        })

        render(<Workspace />)

        // What was being written when the project was last closed is in the composer.
        await flush()
        const composer = screen.getByRole('combobox', {name: 'Message input'})
        await flush()

        expect(composer).toHaveTextContent('Half a thought about the')

        await userEvent.type(composer, ' level')

        // Typing again records the new text against the same task.
        await flush()

        expect(drafts['ui.draft.0198f4c0-02ef-7000-8000-000000000001']).toContain('level')
    })

    it('coalesces chat snapshots while a save is already running', async () => {
        let resolveFirstSave: (() => void) | undefined
        backend({
            save_chat: () => {
                const saveCount = tauri.invoke.mock.calls.filter(
                    call => call[0] === 'save_chat'
                ).length
                // The first save is held open, which is the state a second save has to coalesce
                // into rather than queue behind.
                if (saveCount === 1) {
                    return new Promise<void>(resolve => {
                        resolveFirstSave = resolve
                    })
                }
                return undefined
            }
        })
        render(<Workspace />)

        await flush()

        expect(tauri.invoke.mock.calls.filter(call => call[0] === 'save_chat')).toHaveLength(1)
        await flush()
        await userEvent.type(screen.getByRole('combobox', {name: 'Message input'}), 'First{enter}')
        await flush()

        expect(screen.getByRole('combobox', {name: 'Message input'})).toBeEnabled()
        await flush()
        await userEvent.type(screen.getByRole('combobox', {name: 'Message input'}), 'Second{enter}')
        await new Promise(resolve => window.setTimeout(resolve, 250))

        expect(tauri.invoke.mock.calls.filter(call => call[0] === 'save_chat')).toHaveLength(1)
        resolveFirstSave?.()
        await flush()

        expect(tauri.invoke.mock.calls.filter(call => call[0] === 'save_chat')).toHaveLength(2)
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
        backend({
            load_chat: () => ({
                messages: [
                    {
                        id: 7,
                        sender: 'user',
                        text: 'Persisted image',
                        timestamp: 10,
                        attachments: [
                            {id: 'attachment-1', name: 'scene.png', mimeType: 'image/png', size: 2}
                        ]
                    }
                ],
                agentMessages: []
            }),
            read_chat_attachment: () => 'data:image/png;base64,aGk='
        })

        render(<Workspace />)

        await flush()
        expect(screen.getByAltText('Attached image: scene.png')).toHaveAttribute(
            'src',
            'data:image/png;base64,aGk='
        )
        await flush()
        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Continue{enter}'
        )
        await flush()

        expect(
            tauri.invoke.mock.calls.filter(call => call[0] === 'read_chat_attachment')
        ).toHaveLength(1)
    })

    it('imports legacy localStorage chat once', async () => {
        const legacy = {
            messages: [{id: 3, sender: 'user', text: 'Legacy message', timestamp: 10}],
            agentMessages: []
        }
        window.localStorage.setItem('gofer.agent-chat.v1', JSON.stringify(legacy))
        backend({
            load_chat: () => ({messages: [], agentMessages: []}),
            import_legacy_chat: ({chat}) => chat
        })

        render(<Workspace />)

        await flush()
        expect(screen.getByText('Legacy message')).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledWith('import_legacy_chat', {chat: legacy})
        expect(window.localStorage.getItem('gofer.agent-chat.v1')).toBeNull()
    })

    it('streams a Pi AI response into the assistant message', async () => {
        backend({
            send_ai_message: args => {
                const stream = streamOf(args)
                stream.onmessage({
                    requestId: 1,
                    event: {type: 'text-delta', delta: 'Hello from local AI'}
                })
                // Ends with no text of its own, so what is on screen can only be the delta. The
                // backend's `done` carries the turn's last step, not the turn, and a bubble that
                // took its text from there would be one that dropped everything said earlier.
                stream.onmessage({
                    requestId: 1,
                    event: {
                        type: 'done',
                        text: '',
                        thinking: '',
                        stopReason: 'stop',
                        usage: emptyUsage,
                        model: 'local',
                        agentMessages: []
                    }
                })
            }
        })
        render(<Workspace />)

        await flush()

        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Say hello{enter}'
        )

        await flush()
        expect(screen.getByText('Hello from local AI')).toBeInTheDocument()
        expect(tauri.invoke).toHaveBeenCalledWith('send_ai_message', {
            stream: expect.anything() as unknown,
            request: {
                requestId: expect.any(Number) as number,
                taskId: 'task-1',
                agentMessages: [],
                isRetry: false,
                messages: [expect.objectContaining({sender: 'user', text: 'Say hello'})]
            }
        })
    })

    /**
     * Summarising runs before the answer exists, and on a local model it is a wait long enough to
     * read as a hung app. The spinner is the only thing on screen at that point, so it has to say
     * what the wait is for — and stop saying it the moment the work moves on.
     */
    it('names the summarising step while it waits, and stops naming it after', async () => {
        let stream: AiStream | undefined
        let endTurn: (() => void) | undefined
        backend({
            send_ai_message: async args => {
                stream = streamOf(args)
                stream.onmessage({
                    requestId: 1,
                    event: {type: 'compaction-start', tokens: 105_000, contextWindow: 120_064}
                })
                // The turn is held open, because that is the state being tested: the summary is a
                // wait inside a turn, and a turn that returns cannot be waiting on anything.
                await new Promise<void>(resolve => {
                    endTurn = resolve
                })
            }
        })
        render(<Workspace />)

        await flush()

        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Keep going{enter}'
        )

        await flush()
        expect(
            screen.getByText('Summarising the conversation to make room (105K / 120K)')
        ).toBeInTheDocument()

        stream?.onmessage({requestId: 1, event: {type: 'compaction-end'}})
        stream?.onmessage({requestId: 1, event: {type: 'text-delta', delta: 'Carried on'}})
        endTurn?.()

        await flush()
        expect(screen.getByText('Carried on')).toBeInTheDocument()
        expect(screen.queryByText(/Summarising the conversation/)).not.toBeInTheDocument()
    })

    /**
     * A turn goes quiet between its steps: it finishes a sentence, then spends a long time deciding
     * what to call next. On screen that looked exactly like a turn that had ended — the last thing
     * drawn was a finished paragraph, under a finished tool call, over a token count. The only sign
     * of life was a placeholder in the composer, at the far edge of the screen from where the eye
     * is. Whatever else the conversation shows, a running turn shows that it is running.
     */
    it('shows the turn is still working after it stops writing', async () => {
        let stream: AiStream | undefined
        let endTurn: (() => void) | undefined
        backend({
            send_ai_message: async args => {
                stream = streamOf(args)
                for (const event of [
                    {
                        type: 'tool-start',
                        id: 'tool-1',
                        name: 'godot_session',
                        target: 'start',
                        startedAt: 1
                    },
                    {
                        type: 'tool-end',
                        id: 'tool-1',
                        output: 'ready',
                        isError: false,
                        endedAt: 131
                    },
                    {type: 'text-delta', delta: 'Let me create the tileset art first.'},
                    // Usage arrives once per step, not once per turn: the backend emits it on every
                    // `turn_end`, and a turn that calls tools has one of those per call.
                    {type: 'usage', usage: emptyUsage, model: 'local'}
                ]) {
                    stream.onmessage({requestId: 1, event})
                }
                // Held open, because a turn that has returned is not one that is still working.
                await new Promise<void>(resolve => {
                    endTurn = resolve
                })
            }
        })
        render(<Workspace />)

        await flush()

        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Build the level{enter}'
        )

        // The tool row rather than the sentence: streaming Markdown holds its last chunk back until
        // the next delta settles it, so the newest sentence is deliberately not on screen yet.
        await flush()
        expect(screen.getByText('godot_session')).toBeInTheDocument()
        expect(
            screen.getByRole('status', {name: 'Working'}),
            'a turn between steps looks finished'
        ).toBeInTheDocument()

        /*
         * Delivering the end of the turn inside `act` settles every effect it starts, so the
         * indicator's absence is read once, at a known moment. Inside `waitFor` the same assertion
         * would pass on its first poll — before these events were even processed.
         */
        await act(async () => {
            stream?.onmessage({
                requestId: 1,
                event: {
                    type: 'done',
                    text: '',
                    thinking: '',
                    stopReason: 'stop',
                    usage: emptyUsage,
                    model: 'local',
                    agentMessages: []
                }
            })
            endTurn?.()
        })

        expect(screen.queryByRole('status', {name: 'Working'})).not.toBeInTheDocument()
    })

    /**
     * A running call already spins, on its own row, next to the name of the thing it is doing. A
     * second indicator under it says the same thing twice and puts the vaguer of the two ("Working")
     * closest to the eye. One turn shows one indicator, and while a call is running it is the call's.
     */
    it('lets a running call be its own indicator', async () => {
        backend({
            send_ai_message: async args => {
                streamOf(args).onmessage({
                    requestId: 1,
                    event: {
                        type: 'tool-start',
                        id: 'tool-1',
                        name: 'godot_scene',
                        target: 'create',
                        startedAt: 1
                    }
                })
                await new Promise<void>(() => undefined)
            }
        })
        render(<Workspace />)

        await flush()

        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Build the level{enter}'
        )

        await flush()
        expect(screen.getByText('godot_scene')).toBeInTheDocument()
        expect(
            screen.queryByRole('status', {name: 'Working'}),
            'a running call is indicated twice'
        ).not.toBeInTheDocument()
    })

    /**
     * `done` is not guaranteed: the backend can return from a turn without emitting it. The
     * indicator has to come down when the stream is over, or it stays up for the session.
     */
    it('stops indicating work when the stream ends without saying it is done', async () => {
        backend({
            send_ai_message: async args => {
                streamOf(args).onmessage({
                    requestId: 1,
                    event: {type: 'tool-start', id: 'tool-1', name: 'bash', startedAt: 1}
                })
            }
        })
        render(<Workspace />)

        await flush()

        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Build the level{enter}'
        )

        // The call's own row appearing is the turn having been processed end to end: the stream
        // closes in the same microtask that starts it. The indicator is then read at that moment.
        await flush()
        expect(screen.getByText('bash')).toBeInTheDocument()
        await act(async () => undefined)
        expect(screen.queryByRole('status', {name: 'Working'})).not.toBeInTheDocument()
    })

    /**
     * The token footer is the turn's closing line, and a closing line under a turn that has not
     * closed says the wrong thing twice: it reports a total that is still climbing, and it tells
     * the reader the message is over.
     */
    it('holds the token footer back until the turn is over', async () => {
        let stream: AiStream | undefined
        let endTurn: (() => void) | undefined
        backend({
            send_ai_message: async args => {
                stream = streamOf(args)
                stream.onmessage({requestId: 1, event: {type: 'text-delta', delta: 'Starting.'}})
                stream.onmessage({
                    requestId: 1,
                    event: {
                        type: 'usage',
                        usage: {...emptyUsage, input: 156, output: 114, reasoning: 0},
                        model: 'local'
                    }
                })
                await new Promise<void>(resolve => {
                    endTurn = resolve
                })
            }
        })
        render(<Workspace />)

        await flush()

        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Build the level{enter}'
        )

        /*
         * One of the few real waits left. `Markdown` parses a growing stretch incrementally and
         * schedules that work itself, so the first delta appearing is an external library's doing
         * rather than an effect this test can flush.
         */
        await waitFor(() => {
            expect(screen.getByText('Starting.')).toBeInTheDocument()
        })
        expect(
            screen.queryByText(/156 in/),
            'the running turn is already showing its closing line'
        ).not.toBeInTheDocument()

        stream?.onmessage({
            requestId: 1,
            event: {
                type: 'done',
                text: '',
                thinking: '',
                stopReason: 'stop',
                usage: {...emptyUsage, input: 156, output: 114, reasoning: 0},
                model: 'local',
                agentMessages: []
            }
        })
        endTurn?.()

        await flush()
        expect(screen.getByText(/156 in/)).toBeInTheDocument()
    })

    it('renders agent tool activity and token usage', async () => {
        tauri.invoke.mockImplementation(async (command, args) => {
            if (command === 'list_workspace_files') return []
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
                        thinkingLevels: [],
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
                for (const event of events) streamOf(args).onmessage({requestId: 1, event})
            }
        })
        render(<Workspace />)

        await flush()
        expect(screen.getByRole('img', {name: 'Local AI connected'})).toBeInTheDocument()
        await flush()
        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Inspect workspace{enter}'
        )

        await flush()
        expect(screen.getByText('Finished')).toBeInTheDocument()
        expect(screen.getByText('bash')).toBeInTheDocument()
        expect(screen.getByText('pwd')).toBeInTheDocument()
        expect(screen.getByText(/10 in/)).toBeInTheDocument()
        expect(screen.getByText('0.01K / 120K')).toBeInTheDocument()
        expect(screen.queryByText('local-model')).not.toBeInTheDocument()
    })

    it('settles the running tool calls when the user stops the turn', async () => {
        let finishRequest: (() => void) | undefined
        // The turn's own stream: the abort the backend sends on cancellation rides it too.
        let stream: AiStream | undefined
        const emit = (event: unknown) => {
            stream?.onmessage({requestId: 1, event})
        }
        backend({
            send_ai_message: async args => {
                stream = streamOf(args)
                emit({type: 'text-delta', delta: 'Working on it'})
                emit({
                    type: 'tool-start',
                    id: 'tool-1',
                    name: 'bash',
                    target: 'godot --headless',
                    startedAt: 10
                })
                // The turn stays open until the backend answers the cancellation.
                return new Promise<undefined>(resolve => {
                    finishRequest = () => {
                        resolve(undefined)
                    }
                })
            },
            cancel_ai_request: () => {
                emit({type: 'aborted'})
                finishRequest?.()
                return undefined
            }
        })
        render(<Workspace />)

        await flush()

        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Build a scene{enter}'
        )
        await flush()
        // A running call carries its own age beside the target — `godot --headless · 4s` — so the
        // row is matched by what it is about rather than by the whole string, which now moves.
        expect(screen.getByText(/godot --headless/u)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Stop'}))
        expect(tauri.invoke).toHaveBeenCalledWith('cancel_ai_request', {
            requestId: expect.any(Number) as number
        })

        // The backend has both emitted the abort and resolved the request by now; flushing settles
        // what they schedule. A `waitFor` here would pass before either had been handled.
        await act(async () => undefined)
        expect(screen.queryByRole('status', {name: 'Loading'})).not.toBeInTheDocument()
    })

    it('asks the user before the agent runs a gated tool call, and answers the backend', async () => {
        const handlers = new Map<string, EventHandler>()
        tauri.listen.mockImplementation(async (event, handler) => {
            handlers.set(event, handler)
            return vi.fn<() => void>()
        })
        backend()
        render(<Workspace />)
        await flush()

        expect(handlers.has('ai-approval-request')).toBe(true)
        const raise = (approvalId: string, ...calls: {op: string; params: unknown}[]) => {
            handlers.get('ai-approval-request')?.({
                payload: {
                    approvalId,
                    tool: 'godot_resource',
                    calls: calls.map(call => ({
                        ...call,
                        reason: 'Deleting a file removes it from the project.'
                    }))
                } as never
            })
        }

        raise('approval-1', {op: 'delete', params: {path: 'scenes/main.tscn'}})
        // A second prompt queues behind the first rather than stacking a second dialog.
        raise('approval-2', {op: 'move', params: {from: 'a.gd', to: 'b.gd'}})
        await flush()
        expect(
            screen.getByText(/The agent is waiting to run godot_resource delete/)
        ).toBeInTheDocument()
        expect(screen.getByText(/scenes\/main.tscn/)).toBeInTheDocument()
        expect(screen.queryByText(/godot_resource move/)).not.toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Reject'}))
        expect(tauri.invoke).toHaveBeenCalledWith('respond_tool_approval', {
            request: {approvalId: 'approval-1', approved: false}
        })

        await flush()
        expect(screen.getByText(/a.gd → b.gd/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Approve'}))
        expect(tauri.invoke).toHaveBeenCalledWith('respond_tool_approval', {
            request: {approvalId: 'approval-2', approved: true}
        })

        // A prompt the backend settles on its own — a timeout, or a cancelled turn — closes too.
        raise('approval-3', {op: 'delete', params: {path: 'scenes/other.tscn'}})
        await flush()
        expect(screen.getByText(/scenes\/other.tscn/)).toBeInTheDocument()
        await act(async () => {
            handlers.get('ai-approval-settled')?.({
                payload: {approvalId: 'approval-3', approved: false} as never
            })
        })
        // Read once, after the event has been delivered: inside `waitFor` this would pass on the
        // poll before the event arrived, and a prompt that never closed would still score green.
        expect(screen.queryByText(/scenes\/other.tscn/)).not.toBeInTheDocument()
    })
})

describe('Navigation', () => {
    const tasks: readonly TaskSummary[] = [
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
    ]

    it('lists persistent tasks and activates the selected task', async () => {
        const onNewTask = vi.fn()
        const onOpenTask = vi.fn()
        render(
            <Navigation
                page='workspace'
                selectedTaskId='task-1'
                tasks={tasks}
                isBusy={false}
                isTurnRunning={false}
                sideNav={DEFAULT_SIDE_NAV_LAYOUT}
                onNavigate={vi.fn()}
                onNewTask={onNewTask}
                onOpenTask={onOpenTask}
                onDeleteTask={vi.fn()}
                onSideNavChange={vi.fn()}
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

    /// Deleting a task destroys its branch, so the button asks first — and the
    /// delete button must not double as the link that opens the task.
    it('deletes a task only after the warning is confirmed', async () => {
        const onDeleteTask = vi.fn()
        const onOpenTask = vi.fn()
        render(
            <Navigation
                page='workspace'
                selectedTaskId='task-1'
                tasks={tasks}
                isBusy={false}
                isTurnRunning={false}
                sideNav={DEFAULT_SIDE_NAV_LAYOUT}
                onNavigate={vi.fn()}
                onNewTask={vi.fn()}
                onOpenTask={onOpenTask}
                onDeleteTask={onDeleteTask}
                onSideNavChange={vi.fn()}
            />
        )

        await userEvent.click(screen.getByLabelText('Delete task Inventory UI'))
        expect(onDeleteTask).not.toHaveBeenCalled()
        expect(onOpenTask).not.toHaveBeenCalled()
        expect(screen.getByText(/cannot be undone/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))
        expect(onDeleteTask).not.toHaveBeenCalled()

        await userEvent.click(screen.getByLabelText('Delete task Inventory UI'))
        await userEvent.click(screen.getByRole('button', {name: 'Delete task'}))

        expect(onDeleteTask).toHaveBeenCalledWith('task-2')
    })
})
