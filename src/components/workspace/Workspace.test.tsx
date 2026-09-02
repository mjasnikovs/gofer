import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {Workspace} from './Workspace'
import {ErrorBoundary} from '../application/ErrorBoundary'
import type {ComposerActions} from '../../hooks/useComposer'
import type {Message, StoredChat} from '../../models/chat'
import type {MonacoStubState} from '../../test/monaco-stub'
import {createManualScheduler, immediateScheduler, setScheduler} from '../../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush} from '../../test/flush'
import {installBackend} from '../../test/backend'
import {setTurnRunning} from '../../services/turn-activity'
import type {BriefEvent} from '../../models/brief'
import type {Backend, BackendAnswers} from '../../test/backend'
import {sketchMessage} from '../../models/sketch'
import type {ProjectSketch} from '../../models/sketch'

const tauri = createDesktopFake()

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

const composerProbe = vi.hoisted(() => ({mounted: undefined as ComposerActions | undefined}))

vi.mock('../../hooks/useComposer', async importOriginal => {
    const real = await importOriginal<typeof import('../../hooks/useComposer')>()
    return {
        ...real,
        useComposer: () => {
            const value = real.useComposer()
            composerProbe.mounted ??= value.actions
            return value
        }
    }
})

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

const TRANSCRIPT = [{role: 'user'}, {role: 'assistant'}]

const USAGE = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: {total: 0}
}

let sent: ChatRequest[] = []
let ending: 'done' | 'crash' = 'done'
let server: Backend

const runTurn: BackendAnswers['send_ai_message'] = ({request, stream}) => {
    sent.push(request)
    const channel = stream as unknown as StreamChannel
    channel.onmessage({
        requestId: request.requestId,
        event: {type: 'text-delta', delta: 'work so far'}
    })
    channel.onmessage({
        requestId: request.requestId,
        event: {type: 'turn-state', agentMessages: TRANSCRIPT}
    })
    if (ending === 'crash') throw new Error('the AI worker died')
    channel.onmessage({
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

beforeEach(() => {
    sent = []
    ending = 'done'
    setScheduler(immediateScheduler)
    installDesktopFake(tauri)
    server = installBackend(tauri, {answers: {send_ai_message: runTurn}})
    tauri.listen.mockImplementation(async (name, handler) => {
        if (name === 'ai-brief') {
            briefListener = payload => {
                handler({event: name, id: 1, payload} as never)
            }
        }
        return () => undefined
    })
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    vi.clearAllMocks()
    briefListener = undefined
})

let briefListener: ((payload: BriefEvent) => void) | undefined

function announceBrief(event: BriefEvent) {
    briefListener?.(event)
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
    const composer = await screen.findByRole('combobox', {name: 'Message input'})
    await user.click(composer)
    await user.paste(text)
    await user.keyboard('{Enter}')
    await flush()
}

function storedTexts(chat: StoredChat | undefined) {
    return chat?.messages.map((message: Message) => message.text)
}

describe('Workspace while a plan is running', () => {
    async function startPlan(user: ReturnType<typeof userEvent.setup>) {
        render(<Workspace taskId='task-1' />)
        await flush()
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.paste('add a pause menu')
        await user.click(screen.getByRole('button', {name: 'Execute as plan'}))
        await flush()
        const started = tauri.invoke.mock.calls.find(([command]) => command === 'run_task_brief')
        const requestId = (started?.[1] as {request: {requestId: number}}).request.requestId
        announceBrief({type: 'brief-started'})
        await flush()
        return requestId
    }

    it('offers the plan control until the first message, and never after', async () => {
        const user = userEvent.setup()
        render(<Workspace taskId='task-1' />)
        await flush()

        expect(await screen.findByRole('button', {name: 'Execute as plan'})).toBeInTheDocument()

        await send(user, 'add a pause menu')

        expect(screen.queryByRole('button', {name: 'Execute as plan'})).not.toBeInTheDocument()
    })

    it('takes the ask out of the composer and plans it', async () => {
        const user = userEvent.setup()
        await startPlan(user)

        expect(tauri.invoke).toHaveBeenCalledWith(
            'run_task_brief',
            expect.objectContaining({
                request: expect.objectContaining({prompt: 'add a pause menu'}) as unknown
            })
        )
        expect(tauri.invoke).not.toHaveBeenCalledWith('send_ai_message', expect.anything())
        expect(screen.queryByRole('button', {name: 'Execute as plan'})).not.toBeInTheDocument()
    })

    it('cancels the plan by the identifier it was started under', async () => {
        const user = userEvent.setup()
        const requestId = await startPlan(user)

        expect(screen.getByText('Planning this task')).toBeInTheDocument()
        const cancel = await screen.findByRole('button', {name: 'Cancel planning'})

        await user.click(cancel)
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('cancel_ai_request', {requestId})
    })

    it('has no composer to send from while the plan runs', async () => {
        const user = userEvent.setup()
        await startPlan(user)

        expect(screen.queryByRole('combobox', {name: 'Message input'})).not.toBeInTheDocument()
        expect(tauri.invoke).not.toHaveBeenCalledWith('send_ai_message', expect.anything())
    })

    it('offers no Stop when no plan and no turn is running', async () => {
        render(<Workspace taskId='task-1' />)
        await flush()
        expect(screen.queryByRole('button', {name: 'Stop'})).not.toBeInTheDocument()
    })
})

describe('Workspace retry', () => {
    it('rewrites the failed reply without deleting any stored turn', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await send(user, 'first prompt')
        ending = 'crash'
        await send(user, 'second prompt')
        await flush()

        const before = server.log.saved.at(-1)
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

        const after = server.log.saved.at(-1)
        expect(after?.messages).toHaveLength(before?.messages.length ?? 0)
        expect(storedTexts(after)).toEqual([
            'first prompt',
            'work so far',
            'second prompt',
            'work so far'
        ])
        expect(after?.messages.at(-1)?.status).toBe('complete')
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

        expect(server.log.saved.at(-1)?.agentMessages).toEqual(TRANSCRIPT)

        ending = 'done'
        await send(user, 'second prompt')
        await flush()

        expect(sent.at(-1)?.agentMessages).toEqual(TRANSCRIPT)
    })

    it('sends the transcript it read from disk with the first turn of a mount', async () => {
        const stored = [
            {role: 'user', content: 'Make the spiders flock'},
            {role: 'assistant', content: [{type: 'toolCall'}]}
        ]
        server = installBackend(tauri, {
            answers: {send_ai_message: runTurn},
            chat: {
                taskId: 'task-1',
                messages: [
                    {id: 1, sender: 'user', text: 'Make the spiders flock', timestamp: 10},
                    {id: 2, sender: 'assistant', text: 'Done', timestamp: 20}
                ],
                agentMessages: stored
            } as unknown as StoredChat
        })
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await send(user, 'now make them faster')
        await flush()

        expect(sent.at(-1)?.agentMessages).toEqual(stored)
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
        server = installBackend(tauri, {
            answers: {
                load_chat: () => {
                    throw new Error('the database is locked')
                }
            }
        })
        render(<Workspace />)
        await flush()
        await flush()

        expect(server.log.saved).toHaveLength(0)
    })

    it('keeps a half-written message in the composer when a turn is retried', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        ending = 'crash'
        await send(user, 'first prompt')

        const composer = await screen.findByRole('combobox', {name: 'Message input'})
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
        server = installBackend(tauri, {
            answers: {
                send_ai_message: ({request, stream}) => {
                    const channel = stream as unknown as StreamChannel
                    channel.onmessage({
                        requestId: request.requestId,
                        event: {type: 'text-delta', text: 'wrong field name'}
                    })
                    channel.onmessage({
                        requestId: request.requestId,
                        event: {type: 'not-an-event'}
                    })
                    channel.onmessage({
                        requestId: request.requestId,
                        event: {type: 'text-delta', delta: 'the real answer'}
                    })
                    return undefined
                }
            }
        })
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await send(user, 'go')
        await flush()

        expect(await screen.findByText('the real answer')).toBeTruthy()
        expect(screen.getByRole('combobox', {name: 'Message input'})).toBeTruthy()
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
        const clock = createManualScheduler()
        setScheduler(clock.schedule)
        const user = userEvent.setup()
        const view = render(<Workspace />)
        await flush()

        await send(user, 'the message they are sure they sent')
        await flush()
        expect(server.log.saved).toHaveLength(0)

        view.unmount()
        await flush()

        expect(storedTexts(server.log.saved.at(-1))).toContain(
            'the message they are sure they sent'
        )
        expect(server.log.saved.at(-1)?.taskId).toBe('task-1')
    })

    it('does not write again when nothing changed since the last save', async () => {
        const user = userEvent.setup()
        const view = render(<Workspace />)
        await flush()

        await send(user, 'saved already')
        await flush()
        const writes = server.log.saved.length

        view.unmount()
        await flush()

        expect(server.log.saved).toHaveLength(writes)
    })
})

describe('Workspace recovery', () => {
    it('picks up a turn the window stopped in the middle of', async () => {
        server = installBackend(tauri, {
            chat: {
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
            } as unknown as StoredChat
        })
        render(<Workspace />)
        await flush()

        expect(await screen.findByRole('button', {name: 'Retry'})).toBeTruthy()
        expect(server.log.saved.at(-1)?.messages.at(-1)?.status).toBe('aborted')
    })
})

describe('Workspace game screenshots', () => {
    const readsImages: BackendAnswers = {
        load_settings: () => ({
            settings: {
                version: 2,
                ai: {
                    connectionType: 'local',
                    connections: {
                        local: {
                            name: 'Local AI',
                            baseUrl: 'http://127.0.0.1:8080/v1',
                            api: 'openai-completions',
                            chatTemplateThinking: false,
                            model: {
                                id: 'local-model',
                                name: 'local-model',
                                input: ['text', 'image']
                            }
                        }
                    }
                }
            },
            storedSecrets: {'ai-default': true}
        })
    }

    function captureButton() {
        return screen.getByRole('button', {name: 'Attach a game screenshot'})
    }

    function captureItem(name: RegExp) {
        return screen.getByRole('menuitem', {name})
    }

    async function captureThe(user: ReturnType<typeof userEvent.setup>, source: 'game' | 'editor') {
        await user.click(captureButton())
        await user.click(captureItem(new RegExp(`Screenshot the ${source}`, 'u')))
        await flush()
    }

    beforeEach(() => {
        server = installBackend(tauri, {answers: {...readsImages, send_ai_message: runTurn}})
    })

    it('refuses the screenshot, and says why, while no game is running', async () => {
        render(<Workspace />)
        await flush()

        act(() => {
            server.publishSessionState('ready')
        })
        await flush()

        await userEvent.setup().click(captureButton())
        expect(captureItem(/Screenshot the game/u)).toHaveAttribute('aria-disabled', 'true')
        expect(captureItem(/Screenshot the game/u)).toHaveTextContent(
            'The game is not running. Run it first.'
        )
        expect(server.log.calls).not.toContain('runtime.capture')
    })

    it('offers nothing to photograph while there is no editor at all', async () => {
        render(<Workspace />)
        await flush()

        expect(captureButton()).toHaveAttribute('aria-disabled', 'true')
        expect(captureButton()).toHaveAccessibleDescription(
            'The editor is not running. Start a session, then take a screenshot.'
        )
    })

    // The 2D and 3D canvases live in the editor, and asking for them used to mean running a game.
    it('photographs the editor with no game running, so a 2D screen can be attached', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        // Start a session and then end its game, which is the state a 2D screen is read in.
        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()
        act(() => {
            server.publishSessionState('ready')
        })
        await flush()

        await captureThe(user, 'editor')

        expect(server.log.calls).toContain('runtime.capture')
        expect(
            await screen.findByAltText('Attached image: editor-screenshot.png')
        ).toBeInTheDocument()
    })

    it('attaches the running game’s own frame to the draft', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()

        await captureThe(user, 'game')

        expect(server.log.calls).toContain('runtime.capture')
        expect(screen.getByAltText('Attached image: game-screenshot.png')).toBeInTheDocument()
    })

    it('opens the scratchpad on the attachment that was pressed', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()
        await captureThe(user, 'game')

        await user.click(screen.getByRole('button', {name: /^Open game-screenshot\.png/u}))
        expect(
            screen.getByRole('img', {name: 'Drawing surface for game-screenshot.png'})
        ).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: 'Cancel'}))
        expect(
            screen.queryByRole('img', {name: 'Drawing surface for game-screenshot.png'})
        ).not.toBeInTheDocument()
        expect(screen.getByAltText('Attached image: game-screenshot.png')).toBeInTheDocument()
    })

    it('withdraws the screenshot when the game the editor was playing ends', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()
        await user.click(captureButton())
        expect(captureItem(/Screenshot the game/u)).not.toHaveAttribute('aria-disabled')
        await user.keyboard('{Escape}')

        act(() => {
            server.publishSessionState('ready')
        })
        await flush()

        await user.click(captureButton())
        expect(captureItem(/Screenshot the game/u)).toHaveAttribute('aria-disabled', 'true')
    })
})

describe('Workspace planning with a picture attached', () => {
    const readsImages: BackendAnswers = {
        load_settings: () => ({
            settings: {
                version: 2,
                ai: {
                    connectionType: 'local',
                    connections: {
                        local: {
                            name: 'Local AI',
                            baseUrl: 'http://127.0.0.1:8080/v1',
                            api: 'openai-completions',
                            chatTemplateThinking: false,
                            model: {
                                id: 'local-model',
                                name: 'local-model',
                                input: ['text', 'image']
                            }
                        }
                    }
                }
            },
            storedSecrets: {'ai-default': true}
        })
    }

    beforeEach(() => {
        server = installBackend(tauri, {answers: {...readsImages, send_ai_message: runTurn}})
    })

    async function attachPicture(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Attach a game screenshot'}))
        await user.click(screen.getByRole('menuitem', {name: /Screenshot the game/u}))
        await flush()
    }

    it('plans the picture with the ask, and sends it with the specification', async () => {
        const user = userEvent.setup()
        render(<Workspace taskId='task-1' />)
        await flush()

        await attachPicture(user)
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.paste('why is this menu off centre')
        await user.click(screen.getByRole('button', {name: 'Execute as plan'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith(
            'save_chat_attachment',
            expect.anything() as unknown
        )
        const started = tauri.invoke.mock.calls.find(([command]) => command === 'run_task_brief')
        const request = (started?.[1] as {request: {attachments?: readonly {name: string}[]}})
            .request
        expect(request.attachments?.map(attachment => attachment.name)).toEqual([
            'game-screenshot.png'
        ])

        announceBrief({
            type: 'brief-phase',
            phase: 'compose',
            field: 'spec',
            value: 'GOAL\nCentre.'
        })
        await flush()

        const turn = sent.at(-1)
        expect(turn?.messages.at(-1)?.text).toBe('GOAL\nCentre.')
        expect(
            (
                turn?.messages.at(-1) as {attachments?: readonly {name: string}[]} | undefined
            )?.attachments?.map(attachment => attachment.name)
        ).toEqual(['game-screenshot.png'])
    })
})

describe('Workspace sending a saved sketch to the chat', () => {
    const PAUSE: ProjectSketch = {
        id: 'question-1-run',
        taskId: null,
        questionId: 'question-1',
        question: 'Where does the pause menu go?',
        label: 'Centered overlay',
        isApproved: true,
        savedAt: 1_700_000_000_000
    }

    const INVENTORY: ProjectSketch = {
        ...PAUSE,
        id: 'question-2-run',
        questionId: 'question-2',
        question: 'Where does the inventory go?',
        savedAt: 1_600_000_000_000
    }

    const SOURCE: Readonly<Record<string, string>> = {
        'question-1-run': '<p>pause</p>',
        'question-2-run': '<p>inventory</p>'
    }

    beforeEach(() => {
        server = installBackend(tauri, {
            answers: {
                send_ai_message: runTurn,
                list_project_sketches: () => [PAUSE, INVENTORY],
                read_project_sketch: ({id}) => ({
                    shown: '<p>drawn</p>',
                    source: SOURCE[id] ?? null
                })
            }
        })
    })

    async function sendSketch(user: ReturnType<typeof userEvent.setup>, question: RegExp) {
        await user.click(screen.getByRole('button', {name: 'Design'}))
        await flush()
        await user.click(screen.getByText(question))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Send to chat'}))
        await flush()
        await user.click(screen.getByText(question))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Chat'}))
        await flush()
    }

    async function submitDraft(user: ReturnType<typeof userEvent.setup>) {
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.keyboard('{Enter}')
        await flush()
        return sent.at(-1)?.messages.at(-1)?.text ?? ''
    }

    it('pastes two saved sketches that happen to share a label', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await sendSketch(user, /pause menu/u)
        await sendSketch(user, /inventory/u)

        const draft = await submitDraft(user)
        expect(draft).toContain('<p>pause</p>')
        expect(draft).toContain('<p>inventory</p>')
    })

    it('pastes a sketch into a draft that already quotes the sentence it opens with', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        const [caption = ''] = sketchMessage(PAUSE, '<p>pause</p>').split('\n')
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.paste(`${caption} And where does the HUD go?`)
        await flush()
        await sendSketch(user, /pause menu/u)

        expect(await submitDraft(user)).toContain('<p>pause</p>')
    })

    it('adds nothing the second time the same sketch is sent', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await sendSketch(user, /pause menu/u)
        await sendSketch(user, /pause menu/u)

        const draft = await submitDraft(user)
        expect(draft.split('<p>pause</p>')).toHaveLength(2)
    })
})

describe('Workspace composer actions', () => {
    beforeEach(() => {
        composerProbe.mounted = undefined
    })

    it('stops the plan that is running now, not the turn it was built against', async () => {
        const user = userEvent.setup()
        render(<Workspace taskId='task-1' />)
        await flush()

        const mounted = composerProbe.mounted
        expect(mounted).toBeDefined()

        const input = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(input)
        await user.paste('add a pause menu')
        await user.click(screen.getByRole('button', {name: 'Execute as plan'}))
        await flush()
        const started = tauri.invoke.mock.calls.find(([command]) => command === 'run_task_brief')
        const {requestId} = (started?.[1] as {request: {requestId: number}}).request
        announceBrief({type: 'brief-started'})
        await flush()

        act(() => {
            mounted?.stop()
        })
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('cancel_ai_request', {requestId})
    })
})

describe('Workspace while a turn is running', () => {
    type Steered = Readonly<{id: string; text: string}>
    type HeldTurn = Readonly<{
        steers: readonly Steered[]
        play: (event: unknown) => void
        end: () => Promise<void>
    }>

    function holdTurnOpen(refuse = false): HeldTurn {
        let release: (() => void) | undefined
        let live: {requestId: number; channel: StreamChannel} | undefined
        const steers: Steered[] = []
        server = installBackend(tauri, {
            answers: {
                send_ai_message: ({request, stream}) => {
                    live = {
                        requestId: request.requestId,
                        channel: stream as unknown as StreamChannel
                    }
                    return new Promise<void>(resolve => {
                        release = resolve
                    })
                },
                steer_ai_request: ({request}) => {
                    if (refuse) throw new Error('no turn to steer')
                    steers.push({id: request.id, text: request.text})
                    return undefined
                }
            }
        })
        return {
            steers,
            play: event => {
                if (live) live.channel.onmessage({requestId: live.requestId, event})
            },
            end: async () => {
                release?.()
                await flush()
            }
        }
    }

    async function type(user: ReturnType<typeof userEvent.setup>, text: string) {
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.paste(text)
        await user.keyboard('{Enter}')
        await flush()
    }

    it('keeps what was typed instead of destroying it, and steers the running turn', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen()
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'also check the audio bus')

        expect(turn.steers.map(request => request.text)).toEqual(['also check the audio bus'])
        expect(await screen.findByText('also check the audio bus')).toBeInTheDocument()
        expect(screen.getByText('Queued')).toBeInTheDocument()

        await turn.end()
    })

    it('clears the composer once the message is queued', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen()
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'also check the audio bus')

        expect((await screen.findByRole('combobox', {name: 'Message input'})).textContent).toBe('')

        await turn.end()
    })

    it('stops calling it queued once the model has taken it', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen()
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'also check the audio bus')
        act(() => {
            turn.play({type: 'steered', id: turn.steers[0]?.id})
        })
        await flush()

        expect(screen.queryByText('Queued')).not.toBeInTheDocument()
        expect(screen.getByText('also check the audio bus')).toBeInTheDocument()

        await turn.end()
    })

    it('hands the message back to the composer when the steer is refused', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen(true)
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'also check the audio bus')

        expect((await screen.findByRole('combobox', {name: 'Message input'})).textContent).toBe(
            'also check the audio bus'
        )

        await turn.end()
    })

    it('hands the message back when the turn ends without taking it', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen()
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'also check the audio bus')
        await turn.end()

        expect((await screen.findByRole('combobox', {name: 'Message input'})).textContent).toBe(
            'also check the audio bus'
        )
    })

    it('hands back every queued message, however alike they are', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen()
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'try again')
        await type(user, 'try again')
        await turn.end()

        expect((await screen.findByRole('combobox', {name: 'Message input'})).textContent).toBe(
            'try again\n\ntry again'
        )
    })

    it('leaves the caret where it was typing when a message comes back', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen()
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'try again')
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.paste('more')
        const written = composer.firstChild as Text
        const caret = document.createRange()
        caret.setStart(written, 2)
        caret.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(caret)

        await turn.end()
        await user.keyboard('X')
        await flush()

        expect(composer.textContent).toBe('moXre\n\ntry again')
    })

    it('never stores a message the model has not taken', async () => {
        const user = userEvent.setup()
        const turn = holdTurnOpen()
        render(<Workspace taskId='task-1' />)
        await flush()

        await type(user, 'build the level')
        await type(user, 'also check the audio bus')

        expect(
            server.log.saved.every(
                chat => storedTexts(chat)?.includes('also check the audio bus') !== true
            )
        ).toBe(true)

        await turn.end()
    })
})

describe('Workspace while another job is running', () => {
    it('keeps what was typed when there is no turn to steer, and says why', async () => {
        const user = userEvent.setup()
        server = installBackend(tauri)
        render(<Workspace taskId='task-1' />)
        await flush()

        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.paste('also check the audio bus')
        act(() => {
            setTurnRunning('memory', true)
        })
        await flush()
        await user.keyboard('{Enter}')
        await flush()

        expect((await screen.findByRole('combobox', {name: 'Message input'})).textContent).toBe(
            'also check the audio bus'
        )
        expect(screen.getByText(/could not be queued/u)).toBeInTheDocument()

        act(() => {
            setTurnRunning('memory', false)
        })
    })
})

describe('Workspace mentions', () => {
    it('keeps the chips already written when the explorer mentions another file', async () => {
        const user = userEvent.setup()
        render(<Workspace taskId='task-1' />)
        await flush()
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.type(composer, '@player{Enter}')
        await flush()

        await user.click(screen.getByRole('button', {name: 'Files'}))
        await user.click(
            await screen.findByRole('button', {name: 'Mention main.tscn in the message'})
        )
        await flush()

        expect(composer.querySelectorAll('[data-astryx-token]')).toHaveLength(1)
        expect(composer.textContent).toContain('scripts/player.gd')
        expect(composer.textContent).toContain('@scenes/main.tscn')
    })

    it('keeps the chips already written when a scene node is mentioned', async () => {
        const user = userEvent.setup()
        render(<Workspace taskId='task-1' />)
        await flush()
        const composer = await screen.findByRole('combobox', {name: 'Message input'})
        await user.click(composer)
        await user.type(composer, '@player{Enter}')
        await flush()

        const explorer = within(screen.getByRole('navigation', {name: 'Explorer'}))
        await user.click(explorer.getByRole('button', {name: 'Start Godot'}))
        await flush()
        await user.click(await screen.findByRole('button', {name: 'Mention Player in the message'}))
        await flush()

        expect(composer.querySelectorAll('[data-astryx-token]')).toHaveLength(1)
        expect(composer.textContent).toContain('scripts/player.gd')
        expect(composer.textContent).toContain('node `Main/Player` (CharacterBody2D)')
    })
})

describe('Workspace errors', () => {
    it('lets a failed turn be dismissed, and stays dismissed', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        ending = 'crash'
        await send(user, 'first prompt')

        const banner = await screen.findByRole('alert')
        expect(banner).toHaveTextContent('the AI worker died')

        await user.click(screen.getByRole('button', {name: 'Dismiss Gofer could not do that'}))
        await flush()

        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('still reports the next failure after one has been dismissed', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        ending = 'crash'
        await send(user, 'first prompt')
        await user.click(
            await screen.findByRole('button', {name: 'Dismiss Gofer could not do that'})
        )
        await flush()

        await send(user, 'second prompt')

        expect(await screen.findByRole('alert')).toHaveTextContent('the AI worker died')
    })
})
