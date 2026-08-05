import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {InspectorWorkspace} from './InspectorWorkspace'
import type {MonacoStubState} from '../../test/monaco-stub'

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
const FRAME = {encoding: 'png-base64', width: 320, height: 180, data: 'iVBORw0KGgo='}

const SCENE_TREE = {
    root: {
        name: 'Main',
        type: 'Node2D',
        path: 'Main',
        children: [{name: 'Player', type: 'CharacterBody2D', path: 'Main/Player', children: []}]
    }
}

type Backend = Readonly<{
    session: {started: boolean}
    calls: string[]
    debugCalls: string[]
}>

const SESSION = {
    sessionId: 'session-1',
    state: 'ready',
    rpcAddress: '127.0.0.1:7000',
    lspPort: 6005,
    dapPort: 6006,
    godotVersion: '4.7.1.stable',
    worktree: '/tmp/task'
}

function backend(): Backend {
    const session = {started: false}
    const calls: string[] = []
    const debugCalls: string[] = []
    tauri.invoke.mockImplementation(async (command, args) => {
        const request = (args as {request?: CallRequest} | undefined)?.request ?? {}
        switch (command) {
            case 'list_workspace_files':
                return [
                    {path: 'scripts/player.gd', bytes: SCRIPT.length},
                    {path: 'scripts/player.gd.uid', bytes: 40},
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
                                scene: 'res://main.tscn',
                                revision: 2,
                                dirty: false,
                                canUndo: false,
                                canRedo: false
                            }
                        }
                    case 'scene.get_tree':
                        return {id: 'x', result: SCENE_TREE}
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
                                groups: ['players']
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
                    default:
                        return {id: 'x', result: {}}
                }
            }
            default:
                return undefined
        }
    })
    return {session, calls, debugCalls}
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

function renderWorkspace() {
    return render(
        <InspectorWorkspace
            chat={<p>Chat column</p>}
            onError={vi.fn()}
        />
    )
}

/** Starts the editor session the way the explorer's empty state offers to. */
async function startSession(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', {name: 'Start editor session'}))
    await waitFor(() => {
        expect(screen.getByText('Player')).toBeInTheDocument()
    })
}

beforeEach(() => {
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
    it('frames the explorer, centre, inspector, and bottom regions', () => {
        backend()
        renderWorkspace()

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
        renderWorkspace()

        expect(await screen.findByText('No editor session')).toBeInTheDocument()
        expect(screen.getByText('No problems')).toBeInTheDocument()

        await startSession(user)

        expect(server.session.started).toBe(true)
        expect(server.calls).toContain('scene.get_tree')
    })

    it('fills the inspector from the node chosen in the edited scene', async () => {
        backend()
        const user = userEvent.setup()
        renderWorkspace()
        await startSession(user)

        await user.click(screen.getByText('Player'))

        const inspector = await screen.findByRole('complementary', {name: 'Inspector'})
        await waitFor(() => {
            expect(within(inspector).getByText('Main/Player')).toBeInTheDocument()
        })
        expect(within(inspector).getByText('CharacterBody2D')).toBeInTheDocument()
        expect(within(inspector).getByText('players')).toBeInTheDocument()
        // The reading is labelled as the edited scene, never confused with the running one.
        expect(within(inspector).getByText('Edited')).toBeInTheDocument()
    })

    it('reports a game that is not running as a fact rather than a fault', async () => {
        backend()
        const user = userEvent.setup()
        renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Runtime'}))

        expect(await screen.findByText('The runtime tree could not be read')).toBeInTheDocument()
        expect(
            screen.getAllByText(
                /No game with the Gofer runtime helper is running \(runtime_not_running\)/
            ).length
        ).toBeGreaterThan(0)
    })

    it('opens a worktree file into the script editor and hides generated sidecars', async () => {
        backend()
        const user = userEvent.setup()
        renderWorkspace()

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

    it('jumps from a problem to the line that produced it', async () => {
        backend()
        const user = userEvent.setup()
        renderWorkspace()
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
        renderWorkspace()
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
        renderWorkspace()
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
        renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Output'}))

        expect(await screen.findByText('Godot Engine v4.7.1.stable')).toBeInTheDocument()
        expect(screen.getByText('SCRIPT ERROR: Parse error')).toBeInTheDocument()
    })

    it('runs the project by ensuring an editor session, then launching under the debugger', async () => {
        const server = backend()
        const user = userEvent.setup()
        renderWorkspace()

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
        renderWorkspace()

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
        renderWorkspace()

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
        renderWorkspace()

        const hide = screen.getByRole('button', {name: 'Hide panel'})
        expect(hide).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('No problems')).toBeInTheDocument()

        await user.click(hide)

        const show = screen.getByRole('button', {name: 'Show panel'})
        expect(show).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('No problems')).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Problems'})).toBeInTheDocument()

        await user.click(show)
        expect(screen.getByText('No problems')).toBeInTheDocument()
    })

    it('reaches and activates the centre tabs from the keyboard', async () => {
        backend()
        const user = userEvent.setup()
        renderWorkspace()

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
        renderWorkspace()

        const opener = await screen.findByRole('button', {name: 'Inspector'})
        expect(opener).toHaveAttribute('aria-expanded', 'false')
        // The inspector's own tabs are not in the frame while it is overlaid and closed.
        expect(screen.queryByRole('button', {name: 'Project'})).not.toBeInTheDocument()

        await user.click(opener)

        const dialog = await screen.findByRole('dialog')
        expect(within(dialog).getByRole('button', {name: 'Project'})).toBeInTheDocument()

        await user.click(within(dialog).getByRole('button', {name: /close/i}))

        await waitFor(() => {
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        })
        expect(opener).toHaveFocus()
    })

    it('has no automatically detectable accessibility violations', async () => {
        backend()
        const user = userEvent.setup()
        const {container} = renderWorkspace()
        await startSession(user)

        const result = await axe.run(container)

        expect(result.violations).toEqual([])
    })
})
