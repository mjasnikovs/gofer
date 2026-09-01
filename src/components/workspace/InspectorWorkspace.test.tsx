import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import {InspectorWorkspace} from './InspectorWorkspace'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import {AskedQuestionsContext} from '../../hooks/useUserQuestions'
import type {UserQuestionPrompt} from '../../models/brief'
import {RECONCILE_MS} from '../../hooks/useGodotSession'
import type {ChatReference} from '../../utils/chat-references'
import type {MonacoStubState} from '../../test/monaco-stub'
import {
    immediateScheduler,
    noInterval,
    setIntervalScheduler,
    setScheduler,
    timerInterval
} from '../../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import {FRAME, ICON_PNG, MAIN_SCENE, SCRIPT, installBackend} from '../../test/backend'
import type {BackendOptions} from '../../test/backend'

const tauri = createDesktopFake()

const editor = vi.hoisted(() => ({
    state: undefined as MonacoStubState | undefined,
    loadFailure: undefined as string | undefined
}))

vi.mock('../../services/monaco-runtime', async () => {
    const {createMonacoStub} = await import('../../test/monaco-stub')
    const stub = createMonacoStub()
    editor.state = stub.state
    return {
        loadMonaco: () =>
            editor.loadFailure === undefined ?
                Promise.resolve(stub.monaco)
            :   Promise.reject(new Error(editor.loadFailure))
    }
})

const backend = (options: BackendOptions = {}) => installBackend(tauri, options)

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

async function renderWorkspace(onError: (message: string) => void = vi.fn()) {
    const rendered = render(
        <InspectorWorkspace
            chat={<p>Chat column</p>}
            onError={onError}
        />
    )
    await flush()
    expect(screen.getByRole('navigation', {name: 'Explorer'})).toBeInTheDocument()
    return rendered
}

async function renderWithChatReferences(added: ChatReference[]) {
    const rendered = render(
        <ChatReferenceContext.Provider
            value={{
                add: reference => {
                    added.push(reference)
                },
                paste: () => undefined
            }}
        >
            <InspectorWorkspace
                chat={<p>Chat column</p>}
                onError={vi.fn()}
            />
        </ChatReferenceContext.Provider>
    )
    await flush()
    expect(screen.getByRole('navigation', {name: 'Explorer'})).toBeInTheDocument()
    return rendered
}

function startSessionButton() {
    return within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
        name: 'Start Godot'
    })
}

async function startSession(user: ReturnType<typeof userEvent.setup>) {
    await user.click(startSessionButton())
    await flush()

    expect(screen.getByText('Player')).toBeInTheDocument()
}

async function startSessionWithoutScene(user: ReturnType<typeof userEvent.setup>) {
    await user.click(startSessionButton())
    await flush()

    expect(screen.getByText('No scene is open')).toBeInTheDocument()
}

beforeEach(() => {
    setScheduler(immediateScheduler)
    installDesktopFake(tauri)
    setIntervalScheduler(noInterval)
    narrowViewport(false)
    editor.state?.reset()
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    editor.loadFailure = undefined
    vi.useRealTimers()
    vi.clearAllMocks()
})

function driveTheTick() {
    vi.useFakeTimers({shouldAdvanceTime: true})
    setIntervalScheduler(timerInterval)
}

describe('InspectorWorkspace', () => {
    it('frames the explorer, centre, inspector, and bottom regions', async () => {
        backend()
        await renderWorkspace()

        for (const label of ['Scene', 'Runtime', 'Files'])
            expect(screen.getByRole('button', {name: label})).toBeInTheDocument()
        for (const label of [
            'Chat',
            'Scripts',
            'Game',
            'Docs',
            'Memory',
            'Design',
            'Skills',
            'Changes'
        ])
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

        await flush()
        expect(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByText(
                'No editor running'
            )
        ).toBeInTheDocument()
        expect(screen.getByText('No problems')).toBeInTheDocument()

        await startSession(user)

        expect(server.state.session.started).toBe(true)
        expect(server.log.calls).toContain('scene.get_tree')
    })

    it('stops presenting an editor whose process is gone, within one tick', async () => {
        driveTheTick()
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)
        expect(screen.getByText(/4\.7\.2\.stable · res:\/\/main\.tscn/)).toBeInTheDocument()

        server.state.session.state = 'error'
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECONCILE_MS)
        })
        await flush()

        expect(screen.getByText('Editor stopped')).toBeInTheDocument()
        expect(startSessionButton()).toBeInTheDocument()
    })

    it('stops offering to stop a game the editor is no longer playing', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await flush()
        await user.click(screen.getByRole('button', {name: 'Run Game'}))
        await flush()

        expect(server.log.debugCalls).toContain('launch')
        expect(screen.getByRole('button', {name: 'Stop Game'})).toBeInTheDocument()
        expect(screen.getByText('Stopped: breakpoint')).toBeInTheDocument()

        act(() => {
            server.publishSessionState('ready')
        })
        await flush()

        expect(screen.getByRole('button', {name: 'Run Game'})).toBeInTheDocument()
        expect(screen.queryByText('Stopped: breakpoint')).not.toBeInTheDocument()
        expect(screen.queryByText('amount')).not.toBeInTheDocument()
    })

    it('picks up the session it did not start itself', async () => {
        driveTheTick()
        const server = backend()
        await renderWorkspace()

        expect(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByText(
                'No editor running'
            )
        ).toBeInTheDocument()

        server.state.session.started = true
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECONCILE_MS)
        })
        await flush()

        expect(screen.getByText('Player')).toBeInTheDocument()
        expect(server.log.calls).toContain('scene.get_tree')
    })

    it('subscribes again to the editor that replaces one that died', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        const subscriptions = () =>
            tauri.invoke.mock.calls.filter(call => call[0] === 'subscribe_godot_events').length
        expect(subscriptions()).toBe(1)

        const announce = tauri.listen.mock.calls.find(
            call => call[0] === 'godot-session-event'
        )?.[1] as ((received: {payload: {type: string; state: string}}) => void) | undefined
        act(() => {
            announce?.({payload: {type: 'stateChanged', state: 'error'}})
        })

        await user.click(startSessionButton())

        await flushUntil(() => subscriptions() === 2)
        expect(subscriptions()).toBe(2)
    })

    it('does not report a failed read when the session it was reading is gone', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        server.state.session.started = false
        const before = server.log.calls.length
        await user.click(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
                name: 'Refresh'
            })
        )

        await flushUntil(() => server.log.calls.length > before)
        expect(server.log.calls.length).toBeGreaterThan(before)
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

        await flush()
        const inspector = screen.getByRole('complementary', {name: 'Inspector'})
        await flush()

        expect(within(inspector).getByText('Main/Player')).toBeInTheDocument()
        expect(within(inspector).getByText('CharacterBody2D')).toBeInTheDocument()
        expect(within(inspector).getByText('players')).toBeInTheDocument()
        expect(
            within(inspector).getByText('body_entered → /Main._on_player_body_entered')
        ).toBeInTheDocument()
        expect(within(inspector).getByText('Edited')).toBeInTheDocument()
    })

    it('draws each node with the icon the editor draws it with', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await flush()
        const player = screen.getByAltText('CharacterBody2D')
        expect(player).toHaveAttribute('src', `data:image/png;base64,${ICON_PNG}`)
        expect(server.log.iconRequests[0]).toEqual(['Node2D', 'PlayerBody'])

        await user.click(screen.getByRole('button', {name: 'Refresh'}))
        await flush()

        expect(server.log.calls.filter(call => call === 'scene.get_tree').length).toBe(2)
        expect(server.log.iconRequests).toHaveLength(1)
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

        await flush()
        expect(screen.getByText('The game is not running')).toBeInTheDocument()
        expect(screen.queryByText('The runtime tree could not be read')).not.toBeInTheDocument()
    })

    it('opens a project file into the script editor and hides generated sidecars', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Files'}))

        await flush()
        expect(screen.getByText('player.gd')).toBeInTheDocument()
        expect(screen.queryByText('player.gd.uid')).not.toBeInTheDocument()
        expect(screen.queryByText('plugin.gd')).not.toBeInTheDocument()

        await user.click(screen.getByText('player.gd'))

        await flush()

        expect(editor.state?.editors).toBe(1)
        expect(editor.state?.activeText()).toBe(SCRIPT)
    })

    it('opens a scene in the editor rather than as text in Monaco', async () => {
        const server = backend({openScene: ''})
        const user = userEvent.setup()
        await renderWorkspace()
        await startSessionWithoutScene(user)

        await user.click(screen.getByRole('button', {name: 'Files'}))
        await flush()
        await user.click(screen.getByText('main.tscn'))

        await flush()

        expect(server.log.sceneOpens).toEqual(['res://scenes/main.tscn'])
        expect(editor.state?.editors).toBe(0)
    })

    it('drops the chosen node when the editor moves to another scene', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByText('Player'))
        await flush()
        const inspector = screen.getByRole('complementary', {name: 'Inspector'})
        await flush()

        expect(within(inspector).getByText('Main/Player')).toBeInTheDocument()

        act(() => {
            server.publishSceneChanged('res://scenes/level_1.tscn')
        })

        await flush()

        expect(within(inspector).getByText('Nothing selected')).toBeInTheDocument()
        expect(within(inspector).queryByText('Main/Player')).not.toBeInTheDocument()
        expect(
            within(inspector).queryByText(/was not found in the edited scene/u)
        ).not.toBeInTheDocument()
    })

    it('offers the scene the project runs when the editor is editing none', async () => {
        const server = backend({openScene: ''})
        const user = userEvent.setup()
        await renderWorkspace()
        await startSessionWithoutScene(user)

        await flush()
        await user.click(screen.getByRole('button', {name: 'Open main scene'}))

        await flush()

        expect(server.log.sceneOpens).toEqual([MAIN_SCENE])
        expect(server.log.calls).toContain('project.get_settings')
    })

    it('reports a launch the debugger refused instead of leaving the button unchanged', async () => {
        backend({canLaunch: false})
        const onError = vi.fn()
        const user = userEvent.setup()
        await renderWorkspace(onError)

        await flush()
        await user.click(screen.getByRole('button', {name: 'Run Game'}))

        await flush()

        expect(onError).toHaveBeenCalledWith(
            expect.stringContaining('No scene is open and the project names no main scene')
        )
        expect(screen.getByRole('button', {name: 'Run Game'})).toBeInTheDocument()
    })

    it('jumps from a problem to the line that produced it', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await flush()

        expect(
            tauri.invoke.mock.calls.some(call => call[0] === 'subscribe_script_diagnostics')
        ).toBe(true)
        server.publishDiagnostics('scripts/player.gd', [
            {
                range: {start: {line: 2, character: 0}, end: {line: 2, character: 4}},
                message: 'Unexpected identifier',
                severity: 1
            }
        ])

        await flush()
        const problem = screen.getByText('Unexpected identifier')
        await user.click(problem)

        await flush()

        expect(editor.state?.revealed).toEqual([3])
    })

    it('searches the project and editor settings separately', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Project'}))
        expect((await screen.findAllByText('application/config/name')).length).toBeGreaterThan(0)
        expect(screen.getAllByText('Fixture').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Restart').length).toBeGreaterThan(1)

        await user.click(screen.getByRole('button', {name: 'Editor'}))
        expect(
            (await screen.findAllByText('interface/editor/single_window_mode')).length
        ).toBeGreaterThan(0)
        expect(
            screen.getAllByText(/Editor settings are machine-wide and outside the project/).length
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

        await flush()
        const frame = screen.getByRole('img', {name: /the running game/i})
        expect(frame).toHaveAttribute('src', `data:image/png;base64,${FRAME.data}`)
    })

    it('follows the editor output with its severities', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByRole('button', {name: 'Output'}))

        await flush()
        expect(screen.getByText('Godot Engine v4.7.2.stable')).toBeInTheDocument()
        expect(screen.getByText('SCRIPT ERROR: Parse error')).toBeInTheDocument()
    })

    it('runs the project by ensuring an editor session, then launching under the debugger', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await flush()
        await user.click(screen.getByRole('button', {name: 'Run Game'}))

        await flush()

        expect(server.state.session.started).toBe(true)
        await flush()

        expect(server.log.debugCalls).toContain('launch')
        await flush()
        expect(screen.getByText('Stopped: breakpoint')).toBeInTheDocument()
        await flush()
        expect(screen.getByText('amount')).toBeInTheDocument()

        await user.click(screen.getByRole('button', {name: 'Stop Game'}))
        await flush()

        expect(server.log.debugCalls).toContain('terminate')
    })

    it('searches recorded output from sessions that have already stopped', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Output'}))
        await user.click(screen.getByRole('radio', {name: 'History'}))

        expect(screen.getByText('Nothing found')).toBeInTheDocument()
        await user.type(screen.getByRole('textbox', {name: 'Search recorded output'}), 'Invalid')

        await flush()
        expect(
            screen.getByText('ERROR: Invalid call in a session that already stopped')
        ).toBeInTheDocument()
        expect(screen.getByText(/run session-0/)).toBeInTheDocument()
    })

    it('opens the sketches panel from its own tab', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Design'}))

        expect(screen.getByRole('radio', {name: /All/u})).toBeInTheDocument()
    })

    it('opens the skills panel from its own tab', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Skills'}))

        expect(await screen.findByRole('button', {name: 'Add folder…'})).toBeInTheDocument()
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

        await flush()
        expect(screen.getByText('Physics introduction')).toBeInTheDocument()
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

        await flush()
        const show = screen.getByRole('button', {name: 'Show panel'})
        expect(show).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByText('No problems')).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Problems'})).toBeInTheDocument()

        await user.click(show)
        await flush()
        expect(screen.getByText('No problems')).toBeInTheDocument()
    })

    it('reaches and activates the centre tabs from the keyboard', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        const docs = screen.getByRole('button', {name: 'Docs'})
        docs.focus()
        expect(docs).toHaveFocus()
        await user.keyboard('{Enter}')

        await flush()
        expect(
            screen.getByRole('textbox', {name: 'Ask the Godot documentation'})
        ).toBeInTheDocument()
    })

    it('overlays the inspector below the responsive breakpoint and returns focus', async () => {
        backend()
        narrowViewport(true)
        const user = userEvent.setup()
        await renderWorkspace()

        await flush()
        const opener = screen.getByRole('button', {name: 'Inspector'})
        expect(opener).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('button', {name: 'Project'})).not.toBeInTheDocument()

        await user.click(opener)

        await flush()
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByRole('button', {name: 'Project'})).toBeInTheDocument()

        await user.click(within(dialog).getByRole('button', {name: /close/i}))

        await flush()

        expect(opener).toHaveFocus()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

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

        await flush()

        expect(editor.state?.activeText()).toBe(SCRIPT)
        expect(document.querySelector('[data-tab-value="scripts/player.gd"]')).toHaveTextContent(
            'player.gd'
        )
        expect(editor.state?.restored).toContainEqual({cursorLine: 3})
        await flush()

        expect(editor.state?.decorations).toHaveLength(1)
        expect(editor.state?.decorations[0]?.range).toMatchObject({startLineNumber: 3})
        expect(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
                name: 'Files'
            })
        ).toHaveAttribute('aria-current', 'true')
    })

    it('shows a code editor that will not load in the frame, not in the chat column', async () => {
        editor.loadFailure = 'the bundle is missing'
        const onError = vi.fn()
        backend({
            stored: {
                'ui.workspace': {
                    centerTab: 'scripts',
                    openScripts: ['scripts/player.gd'],
                    activeScript: 'scripts/player.gd'
                }
            }
        })

        await renderWorkspace(onError)
        await flush()

        expect(screen.getByText('The workspace could not do that')).toBeInTheDocument()
        expect(screen.getByText(/The code editor could not be loaded/)).toHaveTextContent(
            'the bundle is missing'
        )
        expect(onError).toHaveBeenCalledWith(
            expect.stringContaining('The code editor could not be loaded')
        )
    })

    it('says nothing about a remembered script that no longer opens', async () => {
        const onError = vi.fn()
        backend({stored: {'ui.workspace': {openScripts: ['scripts/deleted.gd']}}})

        await renderWorkspace(onError)

        await flush()

        expect(screen.getByRole('button', {name: 'Chat'})).toBeInTheDocument()
        expect(onError).not.toHaveBeenCalled()
        expect(screen.queryByText(/could not be opened/)).not.toBeInTheDocument()
    })

    it('records the tab the user moved to', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Game'}))

        await flush()

        expect(
            server.log.writes.filter(write => write.key === 'ui.workspace').at(-1)?.value
        ).toMatchObject({centerTab: 'game'})
    })

    it('brings the chat forward when a question starts waiting', async () => {
        backend()
        const user = userEvent.setup()
        const waiting: UserQuestionPrompt = {
            questionId: 'q-1',
            question: 'Where does the pause menu live?',
            options: [],
            sketches: [],
            why: 'it changes the scene tree',
            revision: 1,
            isDelegated: false
        }
        const frame = (questions: readonly UserQuestionPrompt[]) => (
            <AskedQuestionsContext value={{questions, answer: vi.fn()}}>
                <InspectorWorkspace
                    chat={<p>Chat column</p>}
                    onError={vi.fn()}
                />
            </AskedQuestionsContext>
        )
        const view = render(frame([]))
        await flush()
        await user.click(screen.getByRole('button', {name: 'Game'}))
        await flush()
        expect(screen.queryByText('Chat column')).not.toBeInTheDocument()

        view.rerender(frame([waiting]))
        await flush()

        expect(screen.getByText('Chat column')).toBeInTheDocument()
    })

    it('records the node the user chose, with the scene it was chosen in', async () => {
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByText('Player'))

        await flush()

        expect(
            server.log.writes.filter(write => write.key === 'ui.workspace').at(-1)?.value
        ).toMatchObject({
            selection: {
                scene: 'res://main.tscn',
                selection: {origin: 'edited', path: 'Main/Player'}
            }
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
