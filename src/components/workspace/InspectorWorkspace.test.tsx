import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {InspectorWorkspace} from './InspectorWorkspace'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import type {ChatReference} from '../../utils/chat-references'
import type {MonacoStubState} from '../../test/monaco-stub'
import {immediateScheduler, setWriteScheduler} from '../../services/ui-state'

type InvokeFunction = (command: string, args?: unknown) => Promise<unknown>

const tauri = vi.hoisted(() => ({
    invoke: vi.fn<InvokeFunction>(),
    isTauri: vi.fn(() => true),
    listen: vi.fn()
}))

vi.mock('../../services/desktop', () => ({
    invoke: tauri.invoke,
    isTauri: tauri.isTauri,
    listen: tauri.listen
}))

const editor = vi.hoisted(() => ({state: undefined as MonacoStubState | undefined}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {loadMonaco: () => Promise.resolve(stub.monaco)}
})

/** A structured Godot failure, as Tauri hands the serialized Rust struct to the rejection. */
class GodotFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean
    ) {
        super(message)
    }
}

type CallRequest = Readonly<{
    path?: string
    command?: string
    params?: Readonly<Record<string, unknown>>
    op?: string
    query?: string
}>

const SCRIPT = 'extends Node\n\nfunc _ready():\n\tpass\n'
/** Stands in for the artwork the editor's theme hands back for a class. */
const ICON_PNG = 'iVBORw0KGgoAAAANSUhEUg=='
const FRAME = {encoding: 'png-base64', width: 320, height: 180, data: 'iVBORw0KGgo='}

const SCENE_TREE = {
    root: {
        name: 'Main',
        type: 'Node2D',
        path: 'Main',
        children: [
            {
                name: 'Player',
                type: 'CharacterBody2D',
                // The class the editor draws it with: this one is a script class of its own.
                icon: 'PlayerBody',
                path: 'Main/Player',
                children: []
            }
        ]
    }
}

type Backend = Readonly<{
    session: {started: boolean}
    calls: string[]
    /** Each batch of classes the tree asked the editor to draw. */
    iconRequests: string[][]
    debugCalls: string[]
    /** Every path handed to `scene.open`, in order. */
    sceneOpens: string[]
    /** Interface state the frame recorded, newest last. */
    writes: {key: string; value?: unknown}[]
    /** What the editor is editing, as `scene.open` changes it. */
    edited: {scene: string}
}>

type BackendOptions = Readonly<{
    /** The scene the editor already has open; empty models a session editing none. */
    openScene?: string
    /** Whether a debugger launch succeeds. */
    canLaunch?: boolean
    /** How the project was left, as the interface state the frame reads before it mounts. */
    stored?: Readonly<Record<string, unknown>>
}>

const MAIN_SCENE = 'res://scenes/main.tscn'

const SESSION = {
    sessionId: 'session-1',
    state: 'ready',
    rpcAddress: '127.0.0.1:7000',
    lspPort: 6005,
    dapPort: 6006,
    godotVersion: '4.7.1.stable',
    worktree: '/tmp/task'
}

function backend({
    openScene = 'res://main.tscn',
    canLaunch = true,
    stored = {}
}: BackendOptions = {}): Backend {
    const session = {started: false}
    const calls: string[] = []
    const iconRequests: string[][] = []
    const debugCalls: string[] = []
    const sceneOpens: string[] = []
    const writes: {key: string; value?: unknown}[] = []
    const edited = {scene: openScene}
    tauri.invoke.mockImplementation(async (command, args) => {
        const request = (args as {request?: CallRequest} | undefined)?.request ?? {}
        const state = args as {key?: string; value?: string} | undefined
        switch (command) {
            case 'read_project_state': {
                const value = stored[state?.key ?? '']
                return value === undefined ? null : JSON.stringify(value)
            }
            case 'write_project_state':
                writes.push({
                    key: state?.key ?? '',
                    ...(state?.value !== undefined && {value: JSON.parse(state.value)})
                })
                return undefined
            case 'list_workspace_files':
                return [
                    {path: 'scripts/player.gd', bytes: SCRIPT.length},
                    {path: 'scripts/player.gd.uid', bytes: 40},
                    {path: 'scenes/main.tscn', bytes: 200},
                    {path: 'art/tile.png.import', bytes: 120},
                    {path: 'addons/gofer/plugin.gd', bytes: 10}
                ]
            case 'open_script_document':
                return {
                    path: request.path ?? '',
                    text: SCRIPT,
                    hash: 'hash-1',
                    bytes: SCRIPT.length,
                    version: 1
                }
            case 'get_godot_session':
                return session.started ? SESSION : undefined
            case 'start_godot_session':
                session.started = true
                return SESSION
            case 'call_godot_debug': {
                const op = request.op ?? ''
                debugCalls.push(op)
                switch (op) {
                    case 'launch':
                        if (!canLaunch)
                            throw new GodotFailure(
                                'no_scene_to_run',
                                'No scene is open and the project names no main scene',
                                false
                            )
                        return {op: 'launched', breakpoints: []}
                    case 'awaitStop':
                        return {
                            op: 'stopped',
                            stopped: {
                                reason: 'breakpoint',
                                threadId: 1,
                                allThreadsStopped: true
                            }
                        }
                    case 'stackTrace':
                        return {
                            op: 'stackTrace',
                            frames: [
                                {
                                    id: 1,
                                    name: '_ready',
                                    line: 3,
                                    column: 1,
                                    path: 'scripts/player.gd'
                                }
                            ]
                        }
                    case 'scopes':
                        return {
                            op: 'scopes',
                            scopes: [{name: 'Locals', variablesReference: 10, expensive: false}]
                        }
                    case 'variables':
                        return {
                            op: 'variables',
                            variables: [{name: 'amount', value: '3', variablesReference: 0}]
                        }
                    default:
                        return {op: 'acknowledged'}
                }
            }
            case 'search_godot_log_history':
                return (request.query ?? '').includes('Invalid') ?
                        [
                            {
                                runId: 'run-1',
                                sessionId: 'session-0',
                                timestamp: 1_800_000_000_000,
                                level: 'error',
                                source: 'editorError',
                                message: 'ERROR: Invalid call in a session that already stopped'
                            }
                        ]
                    :   []
            case 'read_godot_logs':
                return {
                    entries: [
                        {
                            sequence: 1,
                            source: 'editor',
                            severity: 'info',
                            message: 'Godot Engine v4.7.1.stable',
                            timestamp: 1_800_000_000
                        },
                        {
                            sequence: 2,
                            source: 'editorError',
                            severity: 'error',
                            message: 'SCRIPT ERROR: Parse error',
                            timestamp: 1_800_000_001
                        }
                    ],
                    cursor: 2,
                    dropped: 0
                }
            case 'query_godot_docs':
                return {
                    passages: [
                        {
                            text: 'CharacterBody2D moves with move_and_slide().',
                            chapter: 'Physics introduction',
                            order: 3,
                            score: 0.82
                        }
                    ]
                }
            case 'call_godot': {
                const name = request.command ?? ''
                calls.push(name)
                if (!session.started)
                    throw new GodotFailure('session_not_active', 'No Godot session is active', true)
                switch (name) {
                    case 'session.get_state':
                        return {
                            id: 'x',
                            result: {
                                state: 'ready',
                                scene: edited.scene,
                                revision: 2,
                                dirty: false,
                                canUndo: false,
                                canRedo: false
                            }
                        }
                    case 'scene.get_tree':
                        return {id: 'x', result: edited.scene ? SCENE_TREE : {root: null}}
                    case 'scene.open': {
                        const requested = request.params?.['path']
                        const path = typeof requested === 'string' ? requested : ''
                        sceneOpens.push(path)
                        edited.scene = path
                        return {id: 'x', result: {scene: path, revision: 3}}
                    }
                    case 'project.get_settings':
                        return {
                            id: 'x',
                            result: {
                                projectName: 'Fixture',
                                mainScene: MAIN_SCENE,
                                renderingMethod: 'gl_compatibility'
                            }
                        }
                    case 'runtime.get_tree':
                        throw new GodotFailure(
                            'runtime_not_running',
                            'No game with the Gofer runtime helper is running',
                            true
                        )
                    case 'node.inspect':
                        return {
                            id: 'x',
                            result: {
                                name: 'Player',
                                type: 'CharacterBody2D',
                                path: 'Main/Player',
                                groups: ['players'],
                                signals: ['body_entered', 'ready'],
                                connections: [
                                    {
                                        signal: 'body_entered',
                                        target: '/Main',
                                        method: '_on_player_body_entered',
                                        binds: [],
                                        deferred: false,
                                        oneShot: false,
                                        persistent: true
                                    }
                                ]
                            }
                        }
                    case 'project.search_settings':
                        return {
                            id: 'x',
                            result: {
                                settings: [
                                    {
                                        name: 'application/config/name',
                                        value: {type: 'string', value: 'Fixture'},
                                        restartRequired: true
                                    }
                                ],
                                totalMatches: 1,
                                truncated: false
                            }
                        }
                    case 'editor.search_settings':
                        return {
                            id: 'x',
                            result: {
                                settings: [
                                    {
                                        name: 'interface/editor/single_window_mode',
                                        value: {type: 'bool', value: false}
                                    }
                                ],
                                totalMatches: 1,
                                truncated: false
                            }
                        }
                    case 'runtime.run':
                        return {id: 'x', result: {running: true, frame: FRAME}}
                    case 'editor.get_class_icons': {
                        const classes = (request.params?.['classes'] ?? []) as string[]
                        iconRequests.push(classes)
                        const icons: Record<string, string> = {}
                        for (const className of classes) icons[className] = ICON_PNG
                        return {id: 'x', result: {encoding: 'png-base64', icons}}
                    }
                    default:
                        return {id: 'x', result: {}}
                }
            }
            default:
                return undefined
        }
    })
    return {session, calls, iconRequests, debugCalls, sceneOpens, writes, edited}
}

/**
 * Tells the frame the editor is editing another scene, the way the addon does.
 *
 * The edited scene reaches the workspace as a `scene.changed` event and nowhere else — a
 * `scene.open` answering does not move it — so a test about what a scene change does has to send
 * one.
 */
function publishSceneChanged(scene: string) {
    const subscription = tauri.invoke.mock.calls.find(
        call => call[0] === 'subscribe_godot_events'
    )?.[1] as {events: {onmessage: (event: unknown) => void}} | undefined
    subscription?.events.onmessage({
        type: 'rpcEvent',
        event: 'scene.changed',
        data: {scene, revision: 0, dirty: false}
    })
}

/** Publishes one diagnostic through the channel the frame subscribed with. */
function publishDiagnostic() {
    const subscription = tauri.invoke.mock.calls.find(
        call => call[0] === 'subscribe_script_diagnostics'
    )?.[1] as {diagnostics: {onmessage: (event: unknown) => void}} | undefined
    subscription?.diagnostics.onmessage({
        path: 'scripts/player.gd',
        version: 1,
        diagnostics: [
            {
                range: {start: {line: 2, character: 0}, end: {line: 2, character: 4}},
                message: 'Unexpected identifier',
                severity: 1
            }
        ]
    })
}

function narrowViewport(isNarrow: boolean) {
    const listeners = new Set<(event: MediaQueryListEvent) => void>()
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string) => ({
            matches: isNarrow,
            media: query,
            onchange: null,
            addListener: () => undefined,
            removeListener: () => undefined,
            addEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => {
                listeners.add(handler)
            },
            removeEventListener: (
                _event: string,
                handler: (event: MediaQueryListEvent) => void
            ) => {
                listeners.delete(handler)
            },
            dispatchEvent: () => false
        })
    })
}

/**
 * Renders the frame and waits for it.
 *
 * The frame reads how this project was left before it mounts, so every test starts after that
 * read: the workspace a user sees is never the default one, and neither is the one under test.
 */
async function renderWorkspace(onError: (message: string) => void = vi.fn()) {
    const rendered = render(
        <InspectorWorkspace
            chat={<p>Chat column</p>}
            onError={onError}
        />
    )
    await screen.findByRole('navigation', {name: 'Explorer'})
    return rendered
}

/** The same frame, with somewhere for a panel to put what the user asked to talk about. */
async function renderWithChatReferences(added: ChatReference[]) {
    const rendered = render(
        <ChatReferenceContext.Provider
            value={{
                add: reference => {
                    added.push(reference)
                }
            }}
        >
            <InspectorWorkspace
                chat={<p>Chat column</p>}
                onError={vi.fn()}
            />
        </ChatReferenceContext.Provider>
    )
    await screen.findByRole('navigation', {name: 'Explorer'})
    return rendered
}

/** The explorer's own offer to start one. The inspector beside it makes the same offer. */
function startSessionButton() {
    return within(screen.getByRole('navigation', {name: 'Explorer'})).findByRole('button', {
        name: 'Start editor session'
    })
}

/** Starts the editor session the way the explorer's empty state offers to. */
async function startSession(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await startSessionButton())
    await waitFor(() => {
        expect(screen.getByText('Player')).toBeInTheDocument()
    })
}

/** The same start, for a session whose editor is editing no scene yet. */
async function startSessionWithoutScene(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await startSessionButton())
    await waitFor(() => {
        expect(screen.getByText('No scene is open')).toBeInTheDocument()
    })
}

beforeEach(() => {
    /*
     * Interface state is written through a 250 ms debounce. It coalesces a drag or a burst of
     * typing into one write; it does not decide what is written. Running it on the spot here keeps
     * that out of the test's budget, so an assertion about a stored layout is never also a race
     * against the clock on a loaded machine.
     */
    setWriteScheduler(immediateScheduler)
    tauri.isTauri.mockReturnValue(true)
    tauri.listen.mockResolvedValue(() => undefined)
    narrowViewport(false)
    editor.state?.reset()
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('InspectorWorkspace', () => {
    it('frames the explorer, centre, inspector, and bottom regions', async () => {
        backend()
        await renderWorkspace()

        for (const label of ['Scene', 'Runtime', 'Files'])
            expect(screen.getByRole('button', {name: label})).toBeInTheDocument()
        for (const label of ['Chat', 'Scripts', 'Game', 'Docs'])
            expect(screen.getByRole('button', {name: label})).toBeInTheDocument()
        for (const label of ['Node', 'Project', 'Editor'])
            expect(screen.getByRole('button', {name: label})).toBeInTheDocument()
        for (const label of ['Problems', 'Debugger', 'Output', 'Import'])
            expect(screen.getByRole('button', {name: label})).toBeInTheDocument()
        expect(screen.getByText('Chat column')).toBeInTheDocument()
    })

    it('offers to start the session while the workspace has no editor', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()

        expect(
            await within(screen.getByRole('navigation', {name: 'Explorer'})).findByText(
                'No editor session'
            )
        ).toBeInTheDocument()
        expect(screen.getByText('No problems')).toBeInTheDocument()

        await startSession(user)

        expect(server.session.started).toBe(true)
        expect(server.calls).toContain('scene.get_tree')
    })

    /**
     * The editor a person closes, or that crashes, takes its event stream with it. The next editor
     * has its own, and the subscription is what carries every lifecycle event the workspace waits
     * on — so a workspace that does not subscribe again sits on "Loading the scene tree…" over a
     * healthy editor that came up seconds ago and never says why.
     */
    it('subscribes again to the editor that replaces one that died', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        const subscriptions = () =>
            tauri.invoke.mock.calls.filter(call => call[0] === 'subscribe_godot_events').length
        expect(subscriptions()).toBe(1)

        // What the backend emits when it notices the editor process is gone.
        const announce = tauri.listen.mock.calls.find(
            call => call[0] === 'godot-session-event'
        )?.[1] as ((received: {payload: {type: string; state: string}}) => void) | undefined
        act(() => {
            announce?.({payload: {type: 'stateChanged', state: 'error'}})
        })

        await user.click(await startSessionButton())
        await waitFor(() => {
            expect(subscriptions()).toBe(2)
        })
    })

    /**
     * Stopping the session is something the user did, not something that went wrong.
     *
     * The panels have reads in flight when the editor goes away, and those land afterwards saying
     * — truthfully — that the session was stopped. Painted, that is a red banner claiming the scene
     * tree could not be read, over a workspace that is simply offline and already says so.
     */
    it('does not report a failed read when the session it was reading is gone', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        server.session.started = false
        const before = server.calls.length
        await user.click(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
                name: 'Refresh'
            })
        )

        // The read reaching the stopped session is the event worth waiting on. Both assertions then
        // describe one settled moment, rather than passing on the first poll after the click.
        await waitFor(() => {
            expect(server.calls.length).toBeGreaterThan(before)
        })
        await act(async () => undefined)
        expect(screen.queryByText('Player')).not.toBeInTheDocument()
        expect(screen.queryByText('The scene tree could not be read')).not.toBeInTheDocument()
    })

    it('fills the inspector from the node chosen in the edited scene', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByText('Player'))

        const inspector = await screen.findByRole('complementary', {name: 'Inspector'})
        await waitFor(() => {
            expect(within(inspector).getByText('Main/Player')).toBeInTheDocument()
        })
        expect(within(inspector).getByText('CharacterBody2D')).toBeInTheDocument()
        expect(within(inspector).getByText('players')).toBeInTheDocument()
        // What is wired to what, not merely what the node could emit: a scene's connections live in
        // the scene rather than in a script, and the panel is the only place they can be read.
        expect(
            within(inspector).getByText('body_entered → /Main._on_player_body_entered')
        ).toBeInTheDocument()
        // The reading is labelled as the edited scene, never confused with the running one.
        expect(within(inspector).getByText('Edited')).toBeInTheDocument()
    })

    it('draws each node with the icon the editor draws it with', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        const player = await screen.findByAltText('CharacterBody2D')
        expect(player).toHaveAttribute('src', `data:image/png;base64,${ICON_PNG}`)
        // The script class the node carries is what was asked for, not the engine class beneath it.
        expect(server.iconRequests[0]).toEqual(['Node2D', 'PlayerBody'])

        // A second read of the same tree is not a second request for artwork that cannot change.
        await user.click(screen.getByRole('button', {name: 'Refresh'}))
        await waitFor(() => {
            expect(server.calls.filter(call => call === 'scene.get_tree').length).toBe(2)
        })
        expect(server.iconRequests).toHaveLength(1)
    })

    it('hands a node to the message being written', async () => {
        backend()
        const added: ChatReference[] = []
        const user = userEvent.setup()
        await renderWithChatReferences(added)
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Mention Player in the message'}))

        expect(added).toEqual([{kind: 'node', id: 'Main/Player', detail: 'CharacterBody2D'}])
    })

    it('reports a game that is not running as a fact rather than a fault', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Runtime'}))

        // The addon answers `runtime.get_tree` with an error code whenever no game holds its
        // helper, which is true of every session that has not pressed Run. The panel has an empty
        // message for exactly that, and reporting it as a failed read would have made the message
        // unreachable and told the user something had gone wrong.
        expect(await screen.findByText('The game is not running')).toBeInTheDocument()
        expect(screen.queryByText('The runtime tree could not be read')).not.toBeInTheDocument()
    })

    it('opens a worktree file into the script editor and hides generated sidecars', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Files'}))

        expect(await screen.findByText('player.gd')).toBeInTheDocument()
        expect(screen.queryByText('player.gd.uid')).not.toBeInTheDocument()
        expect(screen.queryByText('plugin.gd')).not.toBeInTheDocument()

        await user.click(screen.getByText('player.gd'))

        await waitFor(() => {
            expect(editor.state?.editors).toBe(1)
        })
        expect(editor.state?.activeText()).toBe(SCRIPT)
    })

    it('opens a scene in the editor rather than as text in Monaco', async () => {
        const server = backend({openScene: ''})
        const user = userEvent.setup()
        await renderWorkspace()
        await startSessionWithoutScene(user)

        await user.click(screen.getByRole('button', {name: 'Files'}))
        await user.click(await screen.findByText('main.tscn'))

        // The editor owns the edited scene: a scene opened as text would leave the tree, the
        // inspector, and Run reading nothing while looking like it had been opened.
        await waitFor(() => {
            // The editor names a scene by its resource path; the explorer names a file by its
            // place in the worktree, and the editor has never heard of that name.
            expect(server.sceneOpens).toEqual(['res://scenes/main.tscn'])
        })
        expect(editor.state?.editors).toBe(0)
    })

    /**
     * A node chosen in one scene is not asked about in the next.
     *
     * The editor's scene changes under the inspector constantly, and the chosen path went with it —
     * so the panel asked the new scene for the old scene's node and showed what the addon rightly
     * answered: `Node /Main/Player was not found in the edited scene`. Reported as an error the
     * user could neither act on nor get rid of.
     */
    it('drops the chosen node when the editor moves to another scene', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByText('Player'))
        const inspector = await screen.findByRole('complementary', {name: 'Inspector'})
        await waitFor(() => {
            expect(within(inspector).getByText('Main/Player')).toBeInTheDocument()
        })

        // The editor moves to another scene, which is where the old path stops meaning anything.
        act(() => {
            publishSceneChanged('res://scenes/level_1.tscn')
        })

        await waitFor(() => {
            expect(within(inspector).getByText('Nothing selected')).toBeInTheDocument()
        })
        expect(within(inspector).queryByText('Main/Player')).not.toBeInTheDocument()
        // The reading is gone rather than replaced by the refusal it used to show.
        expect(
            within(inspector).queryByText(/was not found in the edited scene/u)
        ).not.toBeInTheDocument()
    })

    it('offers the scene the project runs when the editor is editing none', async () => {
        const server = backend({openScene: ''})
        const user = userEvent.setup()
        await renderWorkspace()
        await startSessionWithoutScene(user)

        await user.click(await screen.findByRole('button', {name: 'Open main scene'}))

        await waitFor(() => {
            expect(server.sceneOpens).toEqual([MAIN_SCENE])
        })
        expect(server.calls).toContain('project.get_settings')
    })

    it('reports a launch the debugger refused instead of leaving the button unchanged', async () => {
        backend({canLaunch: false})
        const onError = vi.fn()
        const user = userEvent.setup()
        await renderWorkspace(onError)

        await user.click(await screen.findByRole('button', {name: 'Run project'}))

        await waitFor(() => {
            expect(onError).toHaveBeenCalledWith(
                expect.stringContaining('No scene is open and the project names no main scene')
            )
        })
        // The game never started, so the control still offers to start it.
        expect(screen.getByRole('button', {name: 'Run project'})).toBeInTheDocument()
    })

    it('jumps from a problem to the line that produced it', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await waitFor(() => {
            expect(
                tauri.invoke.mock.calls.some(call => call[0] === 'subscribe_script_diagnostics')
            ).toBe(true)
        })
        publishDiagnostic()

        const problem = await screen.findByText('Unexpected identifier')
        await user.click(problem)

        await waitFor(() => {
            expect(editor.state?.revealed).toEqual([3])
        })
    })

    it('searches the project and editor settings separately', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Project'}))
        expect((await screen.findAllByText('application/config/name')).length).toBeGreaterThan(0)
        expect(screen.getAllByText('Fixture').length).toBeGreaterThan(0)
        // The column header, plus the badge on the one setting that asks for a restart.
        expect(screen.getAllByText('Restart').length).toBeGreaterThan(1)

        await user.click(screen.getByRole('button', {name: 'Editor'}))
        expect(
            (await screen.findAllByText('interface/editor/single_window_mode')).length
        ).toBeGreaterThan(0)
        expect(
            screen.getAllByText(/Editor settings are machine-wide and outside the worktree/).length
        ).toBeGreaterThan(0)
    })

    it('shows the captured frame a run answers with', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Game'}))
        expect(screen.getByText('No frame yet')).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: 'Run'}))

        const frame = await screen.findByRole('img', {name: /the running game/i})
        expect(frame).toHaveAttribute('src', `data:image/png;base64,${FRAME.data}`)
    })

    it('follows the editor output with its severities', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Output'}))

        expect(await screen.findByText('Godot Engine v4.7.1.stable')).toBeInTheDocument()
        expect(screen.getByText('SCRIPT ERROR: Parse error')).toBeInTheDocument()
    })

    it('runs the project by ensuring an editor session, then launching under the debugger', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()

        // No session is running: Run is one action, because the debug adapter belongs to the
        // editor and there is nothing to launch the game with until the editor is up.
        await user.click(await screen.findByRole('button', {name: 'Run project'}))

        await waitFor(() => {
            expect(server.session.started).toBe(true)
        })
        await waitFor(() => {
            expect(server.debugCalls).toContain('launch')
        })
        // The bottom panel follows the game to the debugger, where the stop it hit is readable.
        expect(await screen.findByText('Stopped: breakpoint')).toBeInTheDocument()
        expect(await screen.findByText('amount')).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: 'Stop project'}))
        await waitFor(() => {
            expect(server.debugCalls).toContain('terminate')
        })
    })

    it('searches recorded output from sessions that have already stopped', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Output'}))
        await user.click(screen.getByRole('radio', {name: 'History'}))

        // The archive answers with no editor running at all, which is when it is worth having.
        expect(screen.getByText('Nothing found')).toBeInTheDocument()
        await user.type(screen.getByRole('textbox', {name: 'Search recorded output'}), 'Invalid')

        expect(
            await screen.findByText('ERROR: Invalid call in a session that already stopped')
        ).toBeInTheDocument()
        expect(screen.getByText(/session session-0/)).toBeInTheDocument()
    })

    it('cites documentation by chapter, because retrieval exposes no URL', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Docs'}))
        expect(
            screen.getAllByText(
                /Passages are cited by chapter: the retriever returns no documentation URL/
            ).length
        ).toBeGreaterThan(0)

        await user.type(
            screen.getByRole('textbox', {name: 'Ask the Godot documentation'}),
            'how do I move a body'
        )
        await user.click(screen.getByRole('button', {name: 'Search'}))

        expect(await screen.findByText('Physics introduction')).toBeInTheDocument()
        expect(screen.getByText('Section 3')).toBeInTheDocument()
        expect(screen.getByText('score 0.820')).toBeInTheDocument()
    })

    it('collapses the bottom panel without losing the way back', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        const hide = screen.getByRole('button', {name: 'Hide panel'})
        expect(hide).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('No problems')).toBeInTheDocument()

        await user.click(hide)

        // The click's state update is committed on React's schedule, not on the promise this
        // interaction returns: on a loaded machine the label is still the old one when the click
        // resolves. Waiting for the button asserts what the user sees rather than how fast the
        // machine running the test happens to be.
        const show = await screen.findByRole('button', {name: 'Show panel'})
        expect(show).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('No problems')).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Problems'})).toBeInTheDocument()

        await user.click(show)
        expect(await screen.findByText('No problems')).toBeInTheDocument()
    })

    it('reaches and activates the centre tabs from the keyboard', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        const docs = screen.getByRole('button', {name: 'Docs'})
        docs.focus()
        expect(docs).toHaveFocus()
        await user.keyboard('{Enter}')

        expect(
            await screen.findByRole('textbox', {name: 'Ask the Godot documentation'})
        ).toBeInTheDocument()
    })

    it('overlays the inspector below the responsive breakpoint and returns focus', async () => {
        backend()
        narrowViewport(true)
        const user = userEvent.setup()
        await renderWorkspace()

        const opener = await screen.findByRole('button', {name: 'Inspector'})
        expect(opener).toHaveAttribute('aria-expanded', 'false')
        // The inspector's own tabs are not in the frame while it is overlaid and closed.
        expect(screen.queryByRole('button', {name: 'Project'})).not.toBeInTheDocument()

        await user.click(opener)

        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByRole('button', {name: 'Project'})).toBeInTheDocument()

        await user.click(within(dialog).getByRole('button', {name: /close/i}))

        // Focus coming back is the close completing, and it is a positive fact to wait on. The
        // dialog's absence is then read at that moment rather than on the first poll after the
        // click, when it would still be open and the assertion would pass anyway.
        await waitFor(() => {
            expect(opener).toHaveFocus()
        })
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    /*
     * How a project was left is a property of the project.
     *
     * The frame reads it before it mounts, so what a user comes back to is the workspace they
     * closed: the same centre tab, the same explorer tab, the same scripts open at the same lines,
     * with the bottom panel as they left it.
     */
    it('reopens the project where it was left', async () => {
        backend({
            stored: {
                'ui.workspace': {
                    centerTab: 'scripts',
                    explorerTab: 'files',
                    bottomTab: 'output',
                    isBottomCollapsed: true,
                    explorerWidth: 320,
                    openScripts: ['scripts/player.gd'],
                    activeScript: 'scripts/player.gd',
                    breakpoints: {'scripts/player.gd': [3]}
                },
                'ui.scriptViews': {'scripts/player.gd': {cursorLine: 3}}
            }
        })

        await renderWorkspace()

        /*
         * Waited on the text rather than on the tab. The tab strip renders as soon as the layout
         * names the script, a whole round trip before `open_script_document` answers with the
         * source — so anchoring on the tab and then reading the buffer synchronously was a race,
         * and it lost roughly one run in three.
         */
        await waitFor(() => {
            expect(editor.state?.activeText()).toBe(SCRIPT)
        })
        // The script is open, in the centre tab it was open in, at the line it was left on.
        expect(document.querySelector('[data-tab-value="scripts/player.gd"]')).toHaveTextContent(
            'player.gd'
        )
        expect(editor.state?.restored).toContainEqual({cursorLine: 3})
        // Its breakpoint came back with it, which is what makes the next Run stop there.
        await waitFor(() => {
            expect(editor.state?.decorations).toHaveLength(1)
        })
        expect(editor.state?.decorations[0]?.range).toMatchObject({startLineNumber: 3})
        // The explorer opened on Files rather than on the scene tree it defaults to.
        expect(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
                name: 'Files'
            })
        ).toHaveAttribute('aria-current', 'page')
    })

    /** A tab from a file that has since been deleted is simply not there, not an error banner. */
    it('says nothing about a remembered script that no longer opens', async () => {
        const onError = vi.fn()
        backend({stored: {'ui.workspace': {openScripts: ['scripts/deleted.gd']}}})

        await renderWorkspace(onError)

        await waitFor(() => {
            expect(screen.getByRole('button', {name: 'Chat'})).toBeInTheDocument()
        })
        expect(onError).not.toHaveBeenCalled()
        expect(screen.queryByText(/could not be opened/)).not.toBeInTheDocument()
    })

    it('records the tab the user moved to', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Game'}))

        await waitFor(() => {
            expect(
                server.writes.filter(write => write.key === 'ui.workspace').at(-1)?.value
            ).toMatchObject({centerTab: 'game'})
        })
    })

    it('records the node the user chose, with the scene it was chosen in', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByText('Player'))

        await waitFor(() => {
            expect(
                server.writes.filter(write => write.key === 'ui.workspace').at(-1)?.value
            ).toMatchObject({
                selection: {
                    scene: 'res://main.tscn',
                    selection: {origin: 'edited', path: 'Main/Player'}
                }
            })
        })
    })

    it('has no automatically detectable accessibility violations', async () => {
        backend()
        const user = userEvent.setup()
        const {container} = await renderWorkspace()
        await startSession(user)

        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })
})
