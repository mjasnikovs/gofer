import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen} from '@testing-library/react'
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
import type {BriefEvent} from '../../models/brief'
import type {Backend, BackendAnswers} from '../../test/backend'
import {sketchMessage} from '../../models/sketch'
import type {ProjectSketch} from '../../models/sketch'

const tauri = createDesktopFake()

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

/**
 * The actions object the composer was handed the first time it rendered.
 *
 * The workspace publishes one object for the life of the mount and swaps what it closes over
 * behind it, so this is the only way to hold the thing a control holds and call it later.
 */
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
/** How the next turn ends. The backend rejects a crashed turn without ever sending `done`. */
let ending: 'done' | 'crash' = 'done'
/** The backend behind the seam, so a test can read what the renderer stored. */
let server: Backend

/** Runs the turn the way the worker does: deltas, a checkpoint, then an ending. */
const runTurn: BackendAnswers['send_ai_message'] = ({request, stream}) => {
    sent.push(request)
    const channel = stream as unknown as StreamChannel
    channel.onmessage({
        requestId: request.requestId,
        event: {type: 'text-delta', delta: 'work so far'}
    })
    // The worker checkpoints what it remembers at every step, so a turn that dies after this point
    // has still reported it.
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
    // A brief reports its progress on a window event, not on the turn's channel, so a test that
    // drives one has to be able to send those.
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

/** Whoever subscribed to the brief's progress, so a test can be the backend sending it. */
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

/*
 * A brief is an AI turn — that is what makes it stoppable, and what keeps the one checkout from
 * being switched under four workers reading it — but it is not the CHAT turn.
 *
 * The composer's Stop follows `isStreaming`, which only a chat turn sets, so a fifteen-minute plan
 * ran with no Stop button and a composer that would happily take another message the backend was
 * going to refuse. The only way out was closing the window.
 */
describe('Workspace while a plan is running', () => {
    /**
     * Starts a plan the way the user does — type the ask, press the control beside Send — and
     * reports what the brief was registered as.
     */
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
        // The run announces itself before its first phase, which is what puts the panel on screen.
        announceBrief({type: 'brief-started'})
        await flush()
        return requestId
    }

    /*
     * The one moment the choice exists, and the only place it is offered.
     *
     * Planning reads the project and writes a specification for the agent to work from, which it can
     * only do before there is a conversation to work from instead. Pressing Send is the other answer
     * to the same question, so either press takes the control away.
     */
    it('offers the plan control until the first message, and never after', async () => {
        const user = userEvent.setup()
        render(<Workspace taskId='task-1' />)
        await flush()

        expect(await screen.findByRole('button', {name: 'Execute as plan'})).toBeInTheDocument()

        await send(user, 'add a pause menu')

        expect(screen.queryByRole('button', {name: 'Execute as plan'})).not.toBeInTheDocument()
    })

    // The ask goes with the plan. Left behind it would be a copy waiting to be sent a second time.
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

    /*
     * Cancel, not Stop, and on the panel rather than on the composer.
     *
     * The panel stands where the composer stood, so the composer's Stop is not on screen to press.
     * And the word is the honest one: a second run rewrites the stored row from its first phase and
     * is handed only the raw ask, so nothing the cancelled run finished is ever read again.
     */
    it('cancels the plan by the identifier it was started under', async () => {
        const user = userEvent.setup()
        const requestId = await startPlan(user)

        expect(screen.getByText('Planning this task')).toBeInTheDocument()
        const cancel = await screen.findByRole('button', {name: 'Cancel planning'})

        await user.click(cancel)
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('cancel_ai_request', {requestId})
    })

    /*
     * There is nothing to send from, which is the point.
     *
     * The panel takes the composer's place for the minutes a plan runs. An empty box left beside it
     * invites a second ask that the backend would refuse by name, and a refusal the user never asked
     * for is worse than never offering the press.
     */
    it('has no composer to send from while the plan runs', async () => {
        const user = userEvent.setup()
        await startPlan(user)

        expect(screen.queryByRole('combobox', {name: 'Message input'})).not.toBeInTheDocument()
        expect(tauri.invoke).not.toHaveBeenCalledWith('send_ai_message', expect.anything())
    })

    // Nothing is running before one starts, so nothing is offered to stop.
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
        expect(server.log.saved.at(-1)?.agentMessages).toEqual(TRANSCRIPT)

        ending = 'done'
        await send(user, 'second prompt')
        await flush()

        expect(sent.at(-1)?.agentMessages).toEqual(TRANSCRIPT)
    })

    /*
     * The turn after a restart, or after a task switch: the transcript is not in memory, it is on
     * disk, and the only thing that puts it back is the read this mount does.
     *
     * Every other test here builds its transcript inside one mount, so the read has never had to
     * carry one. Four real conversations on this machine show the shape of that gap: turn one holds
     * its tool calls, and every turn after it holds prose alone.
     */
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
                    // A worker one version ahead, or one field renamed: `text` where `delta` is
                    // meant.
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

        // The window is still a window, and the good delta still landed.
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
        // The real clock never fires here, so nothing but the flush can produce a write.
        const clock = createManualScheduler()
        setScheduler(clock.schedule)
        const user = userEvent.setup()
        const view = render(<Workspace />)
        await flush()

        await send(user, 'the message they are sure they sent')
        await flush()
        expect(server.log.saved).toHaveLength(0)

        // Switching tasks changes the workspace's key, which is an unmount.
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
    /**
     * Both chats found in the wild were stored exactly like this: a reply left `streaming` by a
     * window that stopped mid-turn. It came back as a turn that was still working, so the indicator
     * never stopped and Retry — which is offered on a turn that ended badly — was never offered.
     */
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

/**
 * The screenshot control beside the file picker.
 *
 * Asking about what is on screen is most of what a game is debugged with, and the picture used to
 * come from a system capture tool, a save dialog, and a trip back through the file picker. The
 * game can take its own, so it does — but only while there is a game to take one of, which is what
 * the control has to say for itself when there is not.
 */
describe('Workspace game screenshots', () => {
    /** A model that reads images, which is what offers either attach control at all. */
    const readsImages: BackendAnswers = {
        load_settings: () => ({
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
                            model: {
                                id: 'local-model',
                                name: 'local-model',
                                input: ['text', 'image']
                            }
                        }
                    }
                }
            },
            hasApiKey: true
        })
    }

    function captureButton() {
        return screen.getByRole('button', {name: 'Attach a game screenshot'})
    }

    beforeEach(() => {
        server = installBackend(tauri, {answers: {...readsImages, send_ai_message: runTurn}})
    })

    it('refuses the screenshot, and says why, while no game is running', async () => {
        render(<Workspace />)
        await flush()

        expect(captureButton()).toHaveAttribute('aria-disabled', 'true')
        expect(captureButton()).toHaveAccessibleDescription(
            'The game is not running. Run it, then take a screenshot of it.'
        )
        expect(server.log.calls).not.toContain('runtime.capture')
    })

    it('attaches the running game’s own frame to the draft', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()

        expect(captureButton()).not.toHaveAttribute('aria-disabled')
        await user.click(captureButton())
        await flush()

        expect(server.log.calls).toContain('runtime.capture')
        expect(screen.getByAltText('Attached image: game-screenshot.png')).toBeInTheDocument()
    })

    /*
     * The scratchpad is reached by pressing the picture, which is the only affordance an image has.
     * Capture stays one press: a user who wants the frame as it is never sees this dialog.
     */
    it('opens the scratchpad on the attachment that was pressed', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()
        await user.click(captureButton())
        await flush()

        await user.click(screen.getByRole('button', {name: /^Open game-screenshot\.png/u}))
        expect(
            screen.getByRole('img', {name: 'Drawing surface for game-screenshot.png'})
        ).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: 'Cancel'}))
        expect(
            screen.queryByRole('img', {name: 'Drawing surface for game-screenshot.png'})
        ).not.toBeInTheDocument()
        // The picture it was opened on is untouched by opening and closing it.
        expect(screen.getByAltText('Attached image: game-screenshot.png')).toBeInTheDocument()
    })

    /*
     * A game that ended takes the control with it. The editor reports its own play state, so a game
     * that crashed or was closed from its own window greys this out without anything being told —
     * the alternative is a press that can only come back with `runtime_not_running`.
     */
    it('withdraws the screenshot when the game the editor was playing ends', async () => {
        const user = userEvent.setup()
        render(<Workspace />)
        await flush()

        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()
        expect(captureButton()).not.toHaveAttribute('aria-disabled')

        act(() => {
            server.publishSessionState('ready')
        })
        await flush()

        expect(captureButton()).toHaveAttribute('aria-disabled', 'true')
    })
})

/*
 * A picture is part of the ask, whichever way the ask is sent.
 *
 * Planning is the composer's other Send. A user who pastes a screenshot and presses Execute as plan
 * has said "plan THIS", and every phase after refine reads text — so the picture has to reach the
 * one worker that reads the raw ask, and the turn the specification starts, or it reaches nothing at
 * all and the plan is written about a sentence describing a screen nobody looked at.
 */
describe('Workspace planning with a picture attached', () => {
    /** A model that reads images, which is what offers the attach controls at all. */
    const readsImages: BackendAnswers = {
        load_settings: () => ({
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
                            model: {
                                id: 'local-model',
                                name: 'local-model',
                                input: ['text', 'image']
                            }
                        }
                    }
                }
            },
            hasApiKey: true
        })
    }

    beforeEach(() => {
        server = installBackend(tauri, {answers: {...readsImages, send_ai_message: runTurn}})
    })

    /** Attaches the running game's own frame, which is one press and needs no file picker. */
    async function attachPicture(user: ReturnType<typeof userEvent.setup>) {
        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Attach a game screenshot'}))
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

        // The bytes are on disk before the backend is asked to read them by id.
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

/*
 * Send to chat is the only way a saved layout reaches the agent: a sketch lives in Gofer's own data,
 * which none of the agent's tools can read. The paste is guarded against a repeat, and the guard
 * used to compare the first line of the message — whose only variable part is the label the model
 * chose. Two questions it named the same thing produced the same first line, so the second layout
 * was dropped with nothing said, and a draft that happened to quote that sentence dropped the first.
 */
describe('Workspace sending a saved sketch to the chat', () => {
    /** Two questions, one name. Nothing stops the model from calling both of them the same thing. */
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

    /** The buildable markup, which is what the paste is worth reading for. */
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

    /** Sends one layout the way the user does, and leaves the panel as it found it. */
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

    /** Sends the draft, and reports the text the backend was handed — newlines and all. */
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

/*
 * The composer's actions are one object for the life of the mount, and every control in the
 * composer is handed it once. What they close over is replaced behind them through a ref, so this
 * is the only thing holding them to the commit they were called against: an action that read a
 * stale closure would stop a turn nobody is running, send without the image just attached, or
 * write the draft under the previous task's key — none of which says anything on screen.
 */
describe('Workspace composer actions', () => {
    beforeEach(() => {
        composerProbe.mounted = undefined
    })

    /*
     * Stop is the sharpest of them: it is not one function with changing state behind it but two
     * different functions, and which one it is changes when a plan starts. Held from the mount, it
     * is the chat turn's stop — which does nothing at all when no chat turn is running — so a
     * stale read here cancels nothing and the plan runs on with the button already pressed.
     */
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
