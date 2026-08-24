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
    /** Set by the one test about an editor that will not load. Cleared after every test. */
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
    await flush()
    expect(screen.getByRole('navigation', {name: 'Explorer'})).toBeInTheDocument()
    return rendered
}

/** The same frame, with somewhere for a panel to put what the user asked to talk about. */
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

/** The explorer's own offer to start one. The inspector beside it makes the same offer. */
function startSessionButton() {
    return within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
        name: 'Start Godot'
    })
}

/** Starts the editor session the way the explorer's empty state offers to. */
async function startSession(user: ReturnType<typeof userEvent.setup>) {
    await user.click(startSessionButton())
    await flush()

    expect(screen.getByText('Player')).toBeInTheDocument()
}

/** The same start, for a session whose editor is editing no scene yet. */
async function startSessionWithoutScene(user: ReturnType<typeof userEvent.setup>) {
    await user.click(startSessionButton())
    await flush()

    expect(screen.getByText('No scene is open')).toBeInTheDocument()
}

beforeEach(() => {
    /*
     * Interface state is written through a 250 ms debounce. It coalesces a drag or a burst of
     * typing into one write; it does not decide what is written. Running it on the spot here keeps
     * that out of the test's budget, so an assertion about a stored layout is never also a race
     * against the clock on a loaded machine.
     */
    setScheduler(immediateScheduler)
    installDesktopFake(tauri)
    // The setup file leaves every poll switched off; the two tests below that are ABOUT the tick
    // turn it back on for themselves. Restated here because `afterEach` restores it.
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

/**
 * Turns the session reconcile back on, for the two tests whose subject IS the tick.
 *
 * Every other test runs with no poll at all — see `src/test/setup.ts`. Here the interval is put
 * back on Vitest's fake clock, so the tick happens when the test says it does rather than when the
 * machine gets round to it.
 */
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
        for (const label of ['Chat', 'Scripts', 'Game', 'Docs', 'Memory', 'Design'])
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

    /**
     * The editor is killed and nothing announces it. The badge still has to flip.
     *
     * Reproduced by accident in a live sweep — the user closed the Godot window — and the badge
     * went on reading ready over a dead process, with every call behind it failing and nothing on
     * screen saying why. Rust works the state out from the child process now, so an editor that
     * exited answers as failed the next time it is asked. Nothing has to have been listening: the
     * only thing standing between the death and the screen is one tick of the reconcile.
     */
    it('stops presenting an editor whose process is gone, within one tick', async () => {
        driveTheTick()
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)
        expect(screen.getByText(/4\.7\.2\.stable · res:\/\/main\.tscn/)).toBeInTheDocument()

        // No event, no announcement: the editor is gone, so there is nothing left to send one. All
        // that changed is the answer Rust derives from the child the next time it is asked.
        server.state.session.state = 'error'
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECONCILE_MS)
        })
        await flush()

        expect(screen.getByText('Editor stopped')).toBeInTheDocument()
        expect(startSessionButton()).toBeInTheDocument()
    })

    /**
     * The game ends and the debugger is not told. The toolbar still has to stop offering Stop.
     *
     * The adapter reports a debuggee that ends while it is watching for the next stop, and says
     * nothing at all about one killed from outside or one that took its editor with it. The launch
     * was believed until contradicted, so Stop Game sat there over a game that had been gone for
     * an hour, with the stack of its last breakpoint still on screen underneath.
     */
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

        // The game is gone, however it went. The editor reports its own play state, and that is
        // the whole of what the toolbar and the debugger panel read.
        act(() => {
            server.publishSessionState('ready')
        })
        await flush()

        expect(screen.getByRole('button', {name: 'Run Game'})).toBeInTheDocument()
        expect(screen.queryByText('Stopped: breakpoint')).not.toBeInTheDocument()
        expect(screen.queryByText('amount')).not.toBeInTheDocument()
    })

    /**
     * The window is not the only thing that starts an editor: an agent turn does, and so does a task
     * that takes the worktree. Rust is the only place that knows one is running, and the renderer
     * used to ask it once on mount and then believe its own copy — so an editor somebody else
     * brought up was on screen, and the workspace still offered to start one, until a reload.
     */
    it('picks up the session it did not start itself', async () => {
        driveTheTick()
        const server = backend()
        await renderWorkspace()

        expect(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByText(
                'No editor running'
            )
        ).toBeInTheDocument()

        // No click: the editor comes up behind the window's back.
        server.state.session.started = true
        await act(async () => {
            await vi.advanceTimersByTimeAsync(RECONCILE_MS)
        })
        await flush()

        expect(screen.getByText('Player')).toBeInTheDocument()
        expect(server.log.calls).toContain('scene.get_tree')
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

        await user.click(startSessionButton())

        // The second subscription is the event worth waiting on, and it lands behind the start
        // call rather than with it. One flush was betting a single macrotask covers that chain; a
        // `waitFor` then bet a 1000 ms budget on it, which a loaded suite is exactly what defeats.
        // Flushed until it lands instead: as many macrotasks as the chain has links, and no clock.
        await flushUntil(() => subscriptions() === 2)
        expect(subscriptions()).toBe(2)
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

        server.state.session.started = false
        const before = server.log.calls.length
        await user.click(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
                name: 'Refresh'
            })
        )

        // The read reaching the stopped session is the event worth waiting on, and it is a chain
        // rather than a moment: the click, the read it starts, and the answer that comes back
        // saying the session is gone. Flushed until it lands, so the wait is counted in macrotasks
        // rather than in milliseconds a loaded machine spends elsewhere.
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

        await flush()
        const player = screen.getByAltText('CharacterBody2D')
        expect(player).toHaveAttribute('src', `data:image/png;base64,${ICON_PNG}`)
        // The script class the node carries is what was asked for, not the engine class beneath it.
        expect(server.log.iconRequests[0]).toEqual(['Node2D', 'PlayerBody'])

        // A second read of the same tree is not a second request for artwork that cannot change.
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

        // The addon answers `runtime.get_tree` with an error code whenever no game holds its
        // helper, which is true of every session that has not pressed Run. The panel has an empty
        // message for exactly that, and reporting it as a failed read would have made the message
        // unreachable and told the user something had gone wrong.
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

        // The editor owns the edited scene: a scene opened as text would leave the tree, the
        // inspector, and Run reading nothing while looking like it had been opened.
        await flush()

        // The editor names a scene by its resource path; the explorer names a file by its
        // place in the worktree, and the editor has never heard of that name.
        expect(server.log.sceneOpens).toEqual(['res://scenes/main.tscn'])
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
        const server = backend()
        const user = userEvent.setup()
        await renderWorkspace()
        await startSession(user)

        await user.click(screen.getByText('Player'))
        await flush()
        const inspector = screen.getByRole('complementary', {name: 'Inspector'})
        await flush()

        expect(within(inspector).getByText('Main/Player')).toBeInTheDocument()

        // The editor moves to another scene, which is where the old path stops meaning anything.
        act(() => {
            server.publishSceneChanged('res://scenes/level_1.tscn')
        })

        await flush()

        expect(within(inspector).getByText('Nothing selected')).toBeInTheDocument()
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
        // The game never started, so the control still offers to start it.
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
        // The column header, plus the badge on the one setting that asks for a restart.
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

        // No session is running: Run is one action, because the debug adapter belongs to the
        // editor and there is nothing to launch the game with until the editor is up.
        await flush()
        await user.click(screen.getByRole('button', {name: 'Run Game'}))

        await flush()

        expect(server.state.session.started).toBe(true)
        await flush()

        expect(server.log.debugCalls).toContain('launch')
        // The bottom panel follows the game to the debugger, where the stop it hit is readable.
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

        // The archive answers with no editor running at all, which is when it is worth having.
        expect(screen.getByText('Nothing found')).toBeInTheDocument()
        await user.type(screen.getByRole('textbox', {name: 'Search recorded output'}), 'Invalid')

        await flush()
        expect(
            screen.getByText('ERROR: Invalid call in a session that already stopped')
        ).toBeInTheDocument()
        expect(screen.getByText(/run session-0/)).toBeInTheDocument()
    })

    /** The tab draws its own view, not the one the ternary happens to end on. */
    it('opens the sketches panel from its own tab', async () => {
        backend()
        const user = userEvent.setup()
        await renderWorkspace()

        await user.click(screen.getByRole('button', {name: 'Design'}))

        expect(screen.getByRole('radio', {name: /All/u})).toBeInTheDocument()
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

        // The click's state update is committed on React's schedule, not on the promise this
        // interaction returns: on a loaded machine the label is still the old one when the click
        // resolves. Waiting for the button asserts what the user sees rather than how fast the
        // machine running the test happens to be.
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
        // The inspector's own tabs are not in the frame while it is overlaid and closed.
        expect(screen.queryByRole('button', {name: 'Project'})).not.toBeInTheDocument()

        await user.click(opener)

        await flush()
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByRole('button', {name: 'Project'})).toBeInTheDocument()

        await user.click(within(dialog).getByRole('button', {name: /close/i}))

        // Focus coming back is the close completing, and it is a positive fact to wait on. The
        // dialog's absence is then read at that moment rather than on the first poll after the
        // click, when it would still be open and the assertion would pass anyway.
        await flush()

        expect(opener).toHaveFocus()
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
        await flush()

        expect(editor.state?.activeText()).toBe(SCRIPT)
        // The script is open, in the centre tab it was open in, at the line it was left on.
        expect(document.querySelector('[data-tab-value="scripts/player.gd"]')).toHaveTextContent(
            'player.gd'
        )
        expect(editor.state?.restored).toContainEqual({cursorLine: 3})
        // Its breakpoint came back with it, which is what makes the next Run stop there.
        await flush()

        expect(editor.state?.decorations).toHaveLength(1)
        expect(editor.state?.decorations[0]?.range).toMatchObject({startLineNumber: 3})
        // The explorer opened on Files rather than on the scene tree it defaults to.
        expect(
            within(screen.getByRole('navigation', {name: 'Explorer'})).getByRole('button', {
                name: 'Files'
            })
        ).toHaveAttribute('aria-current', 'page')
    })

    /*
     * An editor that will not load says so in the frame, not into a column that is not on screen.
     *
     * The script editor renders only while the scripts tab is open, and the chat composer — where
     * the workspace's errors used to be written — mounts only while the chat tab is. The two can
     * never be on screen together, so the message was written where it could not be read. There is
     * one sink now, and this is the assertion that could not be made before.
     */
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
        // And it still reaches the conversation, which is where it belongs afterwards.
        expect(onError).toHaveBeenCalledWith(
            expect.stringContaining('The code editor could not be loaded')
        )
    })

    /** A tab from a file that has since been deleted is simply not there, not an error banner. */
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

    /**
     * A question the agent is blocked on has to be somewhere the user can see it.
     *
     * Both places one is drawn — the block inside the tool call, and the slot beside the composer —
     * are in the chat column, and the chat column is mounted only while the Chat tab is showing. So
     * a question asked while the user was watching the game appeared nowhere at all and the tool
     * blocked for its full thirty minutes. Approvals never had this: their dialog is mounted beside
     * the frame rather than inside it.
     */
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
