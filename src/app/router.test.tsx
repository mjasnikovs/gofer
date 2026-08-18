import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {RouterProvider, createMemoryHistory} from '@tanstack/react-router'
import {createAppRouter} from './router'
import {preloadSettingsPage, preloadWorkspace} from './routes-preload'
import {immediateScheduler, setScheduler, timerScheduler} from '../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import type {HealthReport} from '../models/health'
import type {TaskSummary} from '../models/app'
import type {SendAiMessageRequest} from '../services/desktop'

const tauri = createDesktopFake()

/**
 * A rejection shaped the way every backend command rejects.
 *
 * An `Error` subclass rather than a bare object: `toCommandError` reads `code` and `message` off
 * whatever it is handed, and the lint rule that only errors may be thrown is right about the rest
 * of the codebase.
 */
class CodedFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly details: Record<string, unknown> = {}
    ) {
        super(message)
    }
    readonly retryable = false
}

const coded = (code: string, message: string, details: Record<string, unknown> = {}) =>
    new CodedFailure(code, message, details)

const tasks: readonly TaskSummary[] = [
    {
        id: 'task-1',
        title: 'Player controller',
        status: 'active',
        isCurrent: true,
        createdAt: 10,
        updatedAt: 20,
        worktree: {
            branchName: 'gofer/task-1',
            worktreePath: '/home/dev/game/.gofer/task-1',
            baseCommit: 'aaaa'
        }
    },
    {
        id: 'task-2',
        title: 'Inventory UI',
        status: 'active',
        isCurrent: false,
        createdAt: 11,
        updatedAt: 19,
        worktree: {
            branchName: 'gofer/task-2',
            worktreePath: '/home/dev/game',
            baseCommit: 'aaaa'
        }
    }
]

const readyWorkspace: HealthReport = {
    workspace: '/home/dev/game',
    workspaceSource: 'configured',
    isReady: true,
    checks: []
}

/**
 * Answers as a desktop build with a healthy workspace, initialized models, and the two tasks above,
 * so a render walks the whole shell: health gate, model splash, side nav, and the workspace.
 */
function answerAsDesktop(overrides: Record<string, unknown> = {}) {
    tauri.invoke.mockImplementation(async (command: string) => {
        if (command in overrides) return overrides[command]
        if (command === 'check_workspace_health') return readyWorkspace
        if (command === 'list_project_tasks') return tasks
        if (command === 'list_workspace_files') return []
        if (command === 'load_chat') return {messages: [], agentMessages: []}
        return undefined
    })
}

/**
 * Loads the router at a path and mounts it, settled far enough to be interacted with.
 *
 * The two route chunks are imported first. The shell reaches its content through `lazy()`, whose
 * fallback is `null` — so without a warm module cache the assertions run against an empty content
 * area and read as a workspace that never rendered.
 */
async function openAt(path: string) {
    await Promise.all([preloadSettingsPage(), preloadWorkspace()])
    const router = createAppRouter(createMemoryHistory({initialEntries: [path]}))
    await router.load()
    render(<RouterProvider router={router} />)
    await flush()
    await flush()
    return router
}

beforeEach(() => {
    // The shell defers its first task refresh past the render, and the workspace debounces its chat
    // saves. Both run on the spot here, so an assertion about the sidebar is never a race.
    setScheduler(immediateScheduler)
    window.localStorage.clear()
    installDesktopFake(tauri)
    answerAsDesktop()
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    setScheduler(timerScheduler)
    vi.clearAllMocks()
})

/**
 * Makes a task the way the sidebar does, without planning it: open the dialog, skip the plan.
 *
 * Skipping is the path that opens a chat, which is what everything below is about. The dialog is
 * mounted only while it is open, so its own title never competes with the control that opens it.
 */
const createTask = async () => {
    await userEvent.click(screen.getByText('New task'))
    await userEvent.click(screen.getByRole('button', {name: 'Skip planning'}))
}

describe('application router', () => {
    it('redirects the root route to the current SQLite task', async () => {
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/']}))

        await router.load()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
        expect(tauri.invoke).toHaveBeenCalledWith('activate_chat_task', {taskId: 'task-1'})
    })

    it('activates a task before resolving its route', async () => {
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/settings']}))
        await router.load()

        await router.navigate({to: '/tasks/$taskId', params: {taskId: 'task-2'}})

        expect(router.state.location.pathname).toBe('/tasks/task-2')
        expect(tauri.invoke).toHaveBeenCalledWith('activate_chat_task', {taskId: 'task-2'})
    })

    // A project with no tasks yet has nothing to redirect to, so the root route stays where it is
    // rather than failing the load.
    it('stays on the root route when the project has no current task', async () => {
        answerAsDesktop({list_project_tasks: []})
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/']}))

        await router.load()

        expect(router.state.location.pathname).toBe('/')
        expect(tauri.invoke).not.toHaveBeenCalledWith('activate_chat_task', expect.anything())
    })

    it('ignores a task list the backend answered with the wrong shape', async () => {
        answerAsDesktop({list_project_tasks: [{id: 'task-1'}, 'not a task']})
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/']}))

        await router.load()

        expect(router.state.location.pathname).toBe('/')
    })

    it('sends the retired /workspace path to the current task', async () => {
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/workspace']}))

        await router.load()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
    })

    it('asks the backend for nothing outside the desktop app', async () => {
        tauri.isTauri.mockReturnValue(false)
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/tasks/task-1']}))

        await router.load()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
        expect(tauri.invoke).not.toHaveBeenCalledWith('list_project_tasks', expect.anything())
        expect(tauri.invoke).not.toHaveBeenCalledWith('activate_chat_task', expect.anything())
    })
})

describe('the application shell', () => {
    it('lists the project tasks beside the workspace once the checks pass', async () => {
        await openAt('/tasks/task-1')

        // The open task is named twice — once in the sidebar, once by the workspace showing it.
        expect(screen.getAllByText('Player controller').length).toBeGreaterThan(1)
        expect(screen.getByText('Inventory UI').closest('a')).toHaveAttribute(
            'href',
            '#/tasks/task-2'
        )
        expect(screen.getByRole('combobox', {name: 'Message input'})).toBeInTheDocument()
    })

    it('opens a new task and moves the window to it', async () => {
        answerAsDesktop({create_chat_task: {taskId: 'task-3'}})
        const router = await openAt('/tasks/task-1')

        await createTask()
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('create_chat_task', {bringChanges: false})
        expect(router.state.location.pathname).toBe('/tasks/task-3')
    })

    // A task the backend refuses to create must leave the window where it was rather than route to
    // a task id that does not exist.
    it('stays put when the new task could not be created', async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'create_chat_task') throw new Error('worktree is locked')
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return tasks
            if (command === 'list_workspace_files') return []
            return undefined
        })
        const router = await openAt('/tasks/task-1')

        await createTask()
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
    })

    it('opens the task the sidebar was clicked on', async () => {
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByText('Inventory UI'))
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-2')
    })

    /**
     * Clicking between two tasks must not put two switches into the backend at once.
     *
     * A task row is a link, and a link has no idea an action is already running — unlike the Merge
     * button, which dedupes its own in-flight action and is why double-clicking it is safe. So every
     * click starts another `activate_chat_task`, and a switch is slow for a reason the click cannot
     * see: it stops the Godot editor first, which is a quit request and a wait of up to ten seconds.
     *
     * They meet in Git. One checkout means one index, and the second switch to reach `git add` dies
     * on `index.lock` — a failure reported to the user in Git's own words. Measured here before the
     * fix: four clicks ten milliseconds apart, three overlapping activations.
     */
    it('never has two task switches in flight at once', async () => {
        let inFlight = 0
        let mostAtOnce = 0
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return tasks
            if (command === 'list_workspace_files') return []
            if (command === 'load_chat') return {messages: [], agentMessages: []}
            if (command === 'activate_chat_task') {
                inFlight += 1
                mostAtOnce = Math.max(mostAtOnce, inFlight)
                // Stopping the editor is the slow part, and it is why a second click arrives first.
                await new Promise(resolve => setTimeout(resolve, 40))
                inFlight -= 1
            }
            return undefined
        })
        await openAt('/tasks/task-1')
        mostAtOnce = 0
        const user = userEvent.setup({delay: null})
        const sideNav = screen.getByRole('navigation', {name: 'Side navigation'})
        const inventory = () => within(sideNav).getByText('Inventory UI')
        const player = () => within(sideNav).getByText('Player controller')

        // Not awaited: a user does not wait for the switch to land before clicking again.
        void user.click(inventory())
        await new Promise(resolve => setTimeout(resolve, 10))
        void user.click(player())
        await new Promise(resolve => setTimeout(resolve, 10))
        void user.click(inventory())
        await new Promise(resolve => setTimeout(resolve, 10))
        void user.click(player())
        await new Promise(resolve => setTimeout(resolve, 400))

        expect(mostAtOnce).toBeLessThanOrEqual(1)
    })

    it('follows the task that took a deleted one’s place', async () => {
        answerAsDesktop({delete_chat_task: {taskId: 'task-2'}})
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByLabelText('Delete task Player controller'))
        await userEvent.click(screen.getByRole('button', {name: 'Delete task'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('delete_chat_task', {taskId: 'task-1'})
        expect(router.state.location.pathname).toBe('/tasks/task-2')
    })

    it('returns to the root route when the last task was deleted', async () => {
        // The list empties as the deletion lands, so the root route this falls back to has no
        // current task to redirect on to. A fixed list would send the window straight back to one.
        let projectTasks: readonly TaskSummary[] = tasks
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return projectTasks
            if (command === 'list_workspace_files') return []
            if (command === 'delete_chat_task') {
                projectTasks = []
                return undefined
            }
            return undefined
        })
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByLabelText('Delete task Player controller'))
        await userEvent.click(screen.getByRole('button', {name: 'Delete task'}))
        await flush()

        expect(router.state.location.pathname).toBe('/')
    })

    it('merges the displayed task through the backend and refreshes the list', async () => {
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('merge_task_branch', {taskId: 'task-1'})
        expect(
            tauri.invoke.mock.calls.filter(call => call[0] === 'list_project_tasks').length
        ).toBeGreaterThan(1)
    })

    /**
     * A merge Git could not do on its own has a way out, and the way out reaches the agent.
     *
     * Every merge failure used to end at one sentence in the composer. A conflict is the one that
     * is not a fault — both branches did real work on the same file — and the only thing left to
     * try was pressing Merge again, which fails identically. The backend gives that failure its own
     * code and the paths; this is the chain from there to a turn the agent can act on.
     */
    it('offers the conflicting merge to the agent and sends it the files', async () => {
        answerAsDesktop()
        const answer = tauri.invoke.getMockImplementation()
        tauri.invoke.mockImplementation(async (command: string, arguments_?: unknown) => {
            if (command === 'merge_task_branch')
                throw coded(
                    'task_merge_conflicted',
                    'This task and the project both changed the same files',
                    {
                        conflicts: ['scenes/Game.tscn', 'scripts/game.gd']
                    }
                )
            if (command === 'resolve_task_merge')
                return {taskId: 'task-1', conflicts: ['scenes/Game.tscn', 'scripts/game.gd']}
            return answer?.(command, arguments_)
        })
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        // The offer names the files, so the user is deciding about something rather than agreeing.
        expect(screen.getByText(/scenes\/Game\.tscn/u)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Let Gofer resolve it'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('resolve_task_merge', {taskId: 'task-1'})
        const sent = tauri.invoke.mock.calls.find(call => call[0] === 'send_ai_message')
        const request = (sent?.[1] as {request?: SendAiMessageRequest} | undefined)?.request
        const prompt = JSON.stringify(request?.messages.at(-1) ?? {})
        expect(prompt).toContain('scenes/Game.tscn')
        expect(prompt).toContain('scripts/game.gd')
        expect(prompt).toContain('<<<<<<<')
    })

    /** A failure that is not a conflict has nothing to offer, so nothing is offered. */
    it('offers nothing when the merge failed for a reason the agent cannot fix', async () => {
        answerAsDesktop()
        const answer = tauri.invoke.getMockImplementation()
        tauri.invoke.mockImplementation(async (command: string, arguments_?: unknown) => {
            if (command === 'merge_task_branch')
                throw coded('task_not_merged', 'The project is not a Git repository')
            return answer?.(command, arguments_)
        })
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        expect(screen.queryByRole('button', {name: 'Let Gofer resolve it'})).toBeNull()
        expect(screen.getByText(/not a Git repository/u)).toBeInTheDocument()
    })

    /**
     * A resolution the agent stopped part-way has a way out of it too.
     *
     * This is the one state the offer above can create and nothing else can: the task sits on an
     * open merge, every later merge is refused for it, and a file still holding both versions is not
     * something anyone fixes by pressing Merge again. Without this the only way out was a terminal.
     */
    it('offers to discard a resolution the agent left half-finished', async () => {
        answerAsDesktop()
        const answer = tauri.invoke.getMockImplementation()
        tauri.invoke.mockImplementation(async (command: string, arguments_?: unknown) => {
            if (command === 'merge_task_branch')
                throw coded(
                    'task_merge_unfinished',
                    'This task is part-way through a merge and these files still hold both versions',
                    {conflicts: ['scenes/Game.tscn']}
                )
            if (command === 'abandon_task_merge') return null
            return answer?.(command, arguments_)
        })
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        // Not the offer to hand it to the agent: it has already had it, and this is the other way.
        expect(screen.queryByRole('button', {name: 'Let Gofer resolve it'})).toBeNull()
        expect(screen.getByText(/scenes\/Game\.tscn/u)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Discard the merge'}))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('abandon_task_merge', {taskId: 'task-1'})
    })

    it('opens the settings page from the sidebar and comes back to the current task', async () => {
        answerAsDesktop({
            load_settings: {
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
            },
            read_agent_prompt: {prompt: 'You are Gofer.', defaultPrompt: 'You are Gofer.'},
            get_rag_cache_status: {path: '/tmp/gofer-rag', sizeBytes: 42, state: 'installed'},
            list_ai_models: []
        })
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByText('Settings'))
        await flush()

        expect(router.state.location.pathname).toBe('/settings')
        // `findBy`, not `flush` plus `getBy`: the dialog is a dynamic import behind a Suspense
        // boundary, which is the one thing on this screen genuinely worth waiting for.
        expect(await screen.findByDisplayValue('Local AI')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Close'}))
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
    })

    /*
     * Settings is a route, so opening it leaves the task route unmatched. The workspace sits
     * underneath the dialog and must not notice: it was remounted once, which threw away the chat
     * runner mid-turn and left a running answer with nowhere to arrive, so the next send hit the
     * backend's "already in progress" guard and the conversation stalled with no way out.
     *
     * `load_chat` runs once per workspace mount, so counting it is counting mounts.
     */
    it('leaves the workspace mounted while settings is open', async () => {
        answerAsDesktop({
            load_settings: {
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
            },
            read_agent_prompt: {prompt: 'You are Gofer.', defaultPrompt: 'You are Gofer.'},
            get_rag_cache_status: {path: '/tmp/gofer-rag', sizeBytes: 42, state: 'installed'},
            list_ai_models: []
        })
        await openAt('/tasks/task-1')
        const chatLoads = () =>
            tauri.invoke.mock.calls.filter(call => call[0] === 'load_chat').length
        const beforeSettings = chatLoads()

        await userEvent.click(screen.getByText('Settings'))
        await flush()
        expect(await screen.findByDisplayValue('Local AI')).toBeInTheDocument()

        expect(chatLoads(), 'opening settings remounted the workspace').toBe(beforeSettings)

        await userEvent.click(screen.getByRole('button', {name: 'Close'}))
        await flush()

        expect(chatLoads(), 'closing settings remounted the workspace').toBe(beforeSettings)
    })

    // Closing settings in a project with no current task has nowhere to return to but the root,
    // which then decides where the window lands.
    it('closes settings to the root route when no task is current', async () => {
        answerAsDesktop({
            list_project_tasks: [],
            load_settings: {
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
                hasApiKey: false
            },
            read_agent_prompt: {prompt: 'You are Gofer.', defaultPrompt: 'You are Gofer.'},
            get_rag_cache_status: {path: '/tmp/gofer-rag', sizeBytes: 0, state: 'not-installed'},
            list_ai_models: []
        })
        const router = await openAt('/settings')

        await userEvent.click(screen.getByRole('button', {name: 'Close'}))
        await flush()

        expect(router.state.location.pathname).toBe('/')
    })

    /*
     * The sidebar was uncontrolled, so it opened at its default width on every launch: closing it,
     * quitting, and opening the project again put it straight back. It is a choice about the work,
     * so the project remembers it the way it remembers which panel was open and how wide it was.
     */
    it('reopens the project with the sidebar the user left closed', async () => {
        const stored = new Map<string, string>()
        tauri.invoke.mockImplementation(async (command: string, args?: unknown) => {
            const state = args as {key?: string; value?: string} | undefined
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return tasks
            if (command === 'list_workspace_files') return []
            if (command === 'read_project_state') return stored.get(state?.key ?? '') ?? null
            if (command === 'write_project_state') {
                if (state?.key !== undefined && state.value !== undefined) {
                    stored.set(state.key, state.value)
                }
            }
            return undefined
        })

        await openAt('/tasks/task-1')
        await userEvent.click(screen.getByRole('button', {name: 'Collapse sidebar'}))
        await flush()

        expect(screen.getByRole('button', {name: 'Expand sidebar'})).toBeInTheDocument()
        expect(stored.get('ui.sideNav')).toBe(JSON.stringify({isCollapsed: true, width: 280}))

        // The window closing and opening again, against the same stored project state.
        cleanup()
        await openAt('/tasks/task-1')

        expect(
            screen.getByRole('button', {name: 'Expand sidebar'}),
            'the sidebar reopened after being left closed'
        ).toBeInTheDocument()
    })

    it('holds the workspace behind the health gate while the project is unusable', async () => {
        answerAsDesktop({
            check_workspace_health: {
                workspace: '/home/dev/game',
                workspaceSource: 'working-directory',
                isReady: false,
                checks: [
                    {
                        id: 'godot-project',
                        title: 'Godot project',
                        status: 'blocked',
                        detail: '/home/dev/game has no project.godot.'
                    }
                ]
            } satisfies HealthReport
        })

        await openAt('/tasks/task-1')

        expect(screen.getByText('Godot project')).toBeInTheDocument()
        expect(screen.queryByText('Player controller')).not.toBeInTheDocument()
    })
})

/**
 * Switching, creating, deleting and merging a task all move the project's one checkout, and each
 * stops the Godot editor before it does — a quit request and a wait of up to ten seconds. For that
 * whole time the window looks idle and every control still answers, so a second operation is one
 * click away and the two meet inside Git.
 *
 * The rule is one busy state for the window. While a task operation is running, nothing that would
 * start another is offered, and the sidebar says why it is not.
 */
describe('while a task operation is running', () => {
    /** Holds one backend command open, so the window can be read mid-operation. */
    function holdOpen(command: string, answer?: unknown) {
        // Replaced by the executor below, which `Promise` runs before this returns.
        let release = (): void => undefined
        const held = new Promise<void>(resolve => {
            release = () => {
                resolve()
            }
        })
        tauri.invoke.mockImplementation(async (name: string) => {
            if (name === command) {
                await held
                return answer
            }
            if (name === 'check_workspace_health') return readyWorkspace
            if (name === 'list_project_tasks') return tasks
            if (name === 'list_workspace_files') return []
            if (name === 'load_chat') return {messages: [], agentMessages: []}
            return undefined
        })
        return release
    }

    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    /** A task row is a link while it is offered and a disabled button while it is not. */
    const taskRow = (title: string) => within(sideNav()).getByText(title).closest('a, button')

    /**
     * Whether a control is offered. A disabled navigation item becomes a `<button disabled>`, while
     * a disabled button keeps its element and says so with `aria-disabled` — the design system's
     * own choice, and either way the control does not act.
     */
    function isOffered(element: Element | null) {
        expect(element, 'the control is on screen').not.toBeNull()
        if (element instanceof HTMLButtonElement && element.disabled) return false
        return element?.getAttribute('aria-disabled') !== 'true'
    }

    /** Every control that would start a second task operation. */
    function expectTaskControlsLocked() {
        expect(isOffered(taskRow('Inventory UI')), 'the other task').toBe(false)
        expect(isOffered(taskRow('Player controller')), 'the open task').toBe(false)
        expect(isOffered(taskRow('New task')), 'New task').toBe(false)
        expect(isOffered(screen.getByLabelText('Delete task Player controller')), 'delete').toBe(
            false
        )
        expect(isOffered(screen.getByRole('button', {name: 'Merge task'})), 'merge').toBe(false)
        expect(sideNav(), 'the sidebar says an operation is running').toHaveAttribute(
            'aria-busy',
            'true'
        )
    }

    it('locks every task control while a switch is running', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen('activate_chat_task')

        await userEvent.click(within(sideNav()).getByText('Inventory UI'))
        await flush()

        expectTaskControlsLocked()
        release()
    })

    // The lock is the only thing standing between a fast clicker and Git's index.lock, so a click
    // that lands on a locked row must not reach the backend at all.
    it('ignores a second switch clicked while the first is running', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen('activate_chat_task')
        // Opening the window activated a task of its own; only the clicks are being counted.
        const switchesSoFar = () =>
            tauri.invoke.mock.calls.filter(call => call[0] === 'activate_chat_task').length
        const before = switchesSoFar()

        await userEvent.click(within(sideNav()).getByText('Inventory UI'))
        await flush()
        await userEvent.click(within(sideNav()).getByText('Player controller'))
        await flush()

        expect(switchesSoFar() - before, 'one switch was started, so one reached the backend').toBe(
            1
        )
        release()
    })

    it('gives every task control back once the switch settles', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen('activate_chat_task')
        await userEvent.click(within(sideNav()).getByText('Inventory UI'))
        await flush()

        release()
        await flush()
        await flush()

        expect(isOffered(taskRow('Inventory UI')), 'the other task').toBe(true)
        expect(isOffered(taskRow('New task')), 'New task').toBe(true)
        expect(isOffered(screen.getByLabelText('Delete task Player controller')), 'delete').toBe(
            true
        )
        expect(isOffered(screen.getByRole('button', {name: 'Merge task'})), 'merge').toBe(true)
        expect(sideNav()).not.toHaveAttribute('aria-busy', 'true')
    })

    // A merge visits the base branch and comes back, so the files under the editor move twice. A
    // switch started in the middle of that is the same collision as two switches.
    it('locks every task control while a merge is running', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen('merge_task_branch', {
            taskId: 'task-1',
            headCommit: 'aaaa',
            mergedCommit: 'bbbb'
        })

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        expect(isOffered(taskRow('Inventory UI')), 'the other task').toBe(false)
        expect(isOffered(taskRow('New task')), 'New task').toBe(false)
        expect(isOffered(screen.getByLabelText('Delete task Player controller')), 'delete').toBe(
            false
        )
        expect(sideNav()).toHaveAttribute('aria-busy', 'true')
        release()
    })

    it('locks every task control while a task is being created', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen('create_chat_task', {taskId: 'task-3'})

        await createTask()
        await flush()

        expectTaskControlsLocked()
        release()
    })

    it('locks every task control while a task is being deleted', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen('delete_chat_task', {taskId: 'task-2'})

        await userEvent.click(screen.getByLabelText('Delete task Player controller'))
        await userEvent.click(screen.getByRole('button', {name: 'Delete task'}))
        await flush()

        expectTaskControlsLocked()
        release()
    })
})

/*
 * A switch is not instant, and the window has to stay honest for as long as it is running.
 *
 * Opening a task stops the Godot editor first — a quit request and a wait of up to ten seconds —
 * and creating one commits and moves the checkout before that. For all of it the route already
 * names the task being opened while the workspace is still keyed on the task being left, and the
 * refreshed list already calls the new task current. The window used to read the title from the one
 * and the conversation from the other, so it drew the new task's name over the previous task's
 * chat: a task that looked opened, holding someone else's conversation.
 */
describe('while a switch is still running', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    /** The title above the conversation. The sidebar heading is a level 1 of its own. */
    const workspaceTitle = () =>
        screen.getAllByRole('heading', {level: 1}).find(heading => !sideNav().contains(heading))
            ?.textContent
    const openChat = 'Validate docs/tasks/20'

    /**
     * A backend that holds one conversation per task and answers `load_chat` about the active one,
     * with the switch onto `heldTask` stopped until the returned release is called.
     */
    function answerWithChatsPerTask(heldTask: string) {
        let activeTaskId = 'task-1'
        let list: readonly TaskSummary[] = tasks
        let release = (): void => undefined
        const held = new Promise<void>(resolve => {
            release = () => {
                resolve()
            }
        })
        const chats: Record<string, readonly unknown[]> = {
            'task-1': [{id: 1, sender: 'user', text: openChat, timestamp: 1}],
            'task-2': [{id: 2, sender: 'user', text: 'Inventory grid', timestamp: 2}],
            'task-3': []
        }
        tauri.invoke.mockImplementation(async (command: string, payload?: unknown) => {
            const arguments_ = (payload ?? {}) as Record<string, string>
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return list
            if (command === 'list_workspace_files') return []
            if (command === 'load_chat')
                return {
                    taskId: activeTaskId,
                    messages: chats[activeTaskId] ?? [],
                    agentMessages: []
                }
            if (command === 'save_chat') {
                const chat = arguments_ as unknown as {
                    chat: {taskId?: string; messages: readonly unknown[]}
                }
                chats[chat.chat.taskId ?? activeTaskId] = chat.chat.messages
                return undefined
            }
            if (command === 'create_chat_task') {
                // The backend records the new task and calls it current before it moves the
                // checkout, so the list the window refreshes next already names it.
                activeTaskId = 'task-3'
                list = [
                    ...tasks.map(task => ({...task, isCurrent: false})),
                    {
                        id: 'task-3',
                        title: 'New task',
                        status: 'active' as const,
                        isCurrent: true,
                        createdAt: 12,
                        updatedAt: 12
                    }
                ]
                return {taskId: 'task-3'}
            }
            if (command === 'activate_chat_task') {
                if (arguments_['taskId'] === heldTask) await held
                activeTaskId = arguments_['taskId'] ?? activeTaskId
                list = list.map(task => ({...task, isCurrent: task.id === activeTaskId}))
                return undefined
            }
            return undefined
        })
        return {
            release: () => {
                release()
            },
            chatOf: (taskId: string) => chats[taskId] ?? []
        }
    }

    it('keeps naming the task whose chat is still on screen, then opens the new one', async () => {
        const backend = answerWithChatsPerTask('task-3')
        const router = await openAt('/tasks/task-1')

        await createTask()
        await flush()
        await flush()

        // The route has moved. The workspace has not, so neither has the title above it.
        expect(router.state.location.pathname).toBe('/tasks/task-3')
        expect(workspaceTitle(), 'the title names the chat below it').toBe('Player controller')
        expect(screen.getByText(openChat)).toBeInTheDocument()

        backend.release()
        await flush()
        await flush()

        expect(workspaceTitle()).toBe('New task')
        expect(screen.queryByText(openChat), 'the new task opens on its own chat').toBeNull()
        // Skipping the plan sends nothing. It makes the task and leaves the user at the composer,
        // so a message here would mean the window had spoken for them.
        expect(backend.chatOf('task-3'), 'a skipped task opens on an empty chat').toEqual([])
        expect(backend.chatOf('task-1'), 'the conversation stayed on its own task').toHaveLength(1)
    })

    // The same window, reached the other way: a switch between two existing tasks is the slow one,
    // because it is the one that stops the editor.
    it('keeps naming the open task while the sidebar opens another', async () => {
        const backend = answerWithChatsPerTask('task-2')
        await openAt('/tasks/task-1')

        await userEvent.click(within(sideNav()).getByText('Inventory UI'))
        await flush()
        await flush()

        expect(workspaceTitle()).toBe('Player controller')
        expect(screen.getByText(openChat)).toBeInTheDocument()

        backend.release()
        await flush()
        await flush()

        expect(workspaceTitle()).toBe('Inventory UI')
        expect(screen.getByText('Inventory grid')).toBeInTheDocument()
        expect(screen.queryByText(openChat)).toBeNull()
    })
})

/*
 * A switch the backend refuses must not take the window with it.
 *
 * Opening a task is a route loader, and a loader that rejects is caught by the root boundary: the
 * whole application — sidebar, workspace, conversation — is replaced by an error page that nothing
 * short of a restart clears. The refusal itself is ordinary: a turn is still running, or another
 * task operation still holds the checkout.
 */
describe('when the backend refuses to open a task', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const refusal = coded(
        'ai_request_in_progress',
        'Wait for the current answer to finish before opening another task'
    )

    /** Refuses every switch away from the task the window opens on. */
    function answerWithRefusedSwitch() {
        tauri.invoke.mockImplementation(async (command: string, payload?: unknown) => {
            const arguments_ = (payload ?? {}) as Record<string, string>
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return tasks
            if (command === 'list_workspace_files') return []
            if (command === 'load_chat')
                return {
                    taskId: 'task-1',
                    messages: [
                        {id: 1, sender: 'user', text: 'The open conversation', timestamp: 1}
                    ],
                    agentMessages: []
                }
            if (command === 'activate_chat_task') {
                if (arguments_['taskId'] === 'task-1') return undefined
                throw refusal
            }
            return undefined
        })
    }

    it('keeps the window on the task it is showing', async () => {
        answerWithRefusedSwitch()
        const router = await openAt('/tasks/task-1')

        await userEvent.click(within(sideNav()).getByText('Inventory UI'))
        await flush()
        await flush()

        // The window is still a window: the refusal is not a reason to lose the sidebar, the
        // workspace, or the conversation the user was reading.
        expect(sideNav()).toBeInTheDocument()
        expect(screen.getByText('The open conversation')).toBeInTheDocument()
        expect(router.state.location.pathname, 'and it names the task it kept').toBe(
            '/tasks/task-1'
        )
    })

    // A task created while a turn runs used to be made, checked out, and then refused by the very
    // next step. The backend refuses the creation itself now, so the window has nothing to follow.
    it('stays put when the new task was refused', async () => {
        tauri.invoke.mockImplementation(async (command: string) => {
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return tasks
            if (command === 'list_workspace_files') return []
            if (command === 'load_chat')
                return {
                    taskId: 'task-1',
                    messages: [
                        {id: 1, sender: 'user', text: 'The open conversation', timestamp: 1}
                    ],
                    agentMessages: []
                }
            if (command === 'create_chat_task') throw refusal
            return undefined
        })
        const router = await openAt('/tasks/task-1')

        await createTask()
        await flush()
        await flush()

        expect(sideNav()).toBeInTheDocument()
        expect(screen.getByText('The open conversation')).toBeInTheDocument()
        expect(router.state.location.pathname).toBe('/tasks/task-1')
    })
})

/*
 * The refusals above are prevented rather than reported.
 *
 * Every one of them is a state the sidebar can see, and a control that is offered, pressed, and then
 * refused is a worse answer than a control that is not offered. What a withheld control still owes
 * the user is the reason, which is why the lock is hoverable rather than silent.
 */
describe('while the agent is answering', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const taskRow = (title: string) => within(sideNav()).getByText(title).closest('a, button')
    const REASON = /Stop it to open or create a task/

    /** Holds one turn open, so the window can be read while the agent is still working. */
    function holdTurnOpen() {
        let end = (): void => undefined
        const turn = new Promise<void>(resolve => {
            end = () => {
                resolve()
            }
        })
        const answer = tauri.invoke.getMockImplementation()
        tauri.invoke.mockImplementation(async (command: string, arguments_?: unknown) => {
            if (command === 'send_ai_message') return turn
            return answer?.(command, arguments_)
        })
        return () => {
            end()
        }
    }

    async function startAnswering() {
        await userEvent.type(
            screen.getByRole('combobox', {name: 'Message input'}),
            'Build the level{enter}'
        )
        await flush()
    }

    it('offers no task control, and says why on hover', async () => {
        await openAt('/tasks/task-1')
        const endTurn = holdTurnOpen()

        await startAnswering()

        expect(taskRow('New task'), 'New task').toBeDisabled()
        expect(taskRow('Inventory UI'), 'the other task').toBeDisabled()
        expect(screen.getByLabelText('Delete task Player controller')).toHaveAttribute(
            'aria-disabled',
            'true'
        )
        // A disabled control that explains nothing reads as a broken one.
        await userEvent.hover(within(sideNav()).getByText('New task'))
        // Astryx renders the hint twice — the visible bubble and its accessible copy.
        expect((await screen.findAllByText(REASON)).length).toBeGreaterThan(0)
        endTurn()
    })

    it('gives every task control back when the turn ends', async () => {
        await openAt('/tasks/task-1')
        const endTurn = holdTurnOpen()
        await startAnswering()
        expect(taskRow('New task')).toBeDisabled()

        endTurn()
        await flush()
        await flush()

        expect(taskRow('New task')).toBeEnabled()
        expect(taskRow('Inventory UI')).toBeEnabled()
    })
})

/*
 * A task opened a second time is the one the window used to get wrong.
 *
 * The router keeps a loaded match per route, so returning to a task it has already opened resolves
 * from that cache at once. The workspace is keyed on the task, so it remounted and read the chat
 * immediately — while the switch it had asked for was still running. `load_chat` answered about
 * whichever task the backend had active, which at that moment was the task being left, so a
 * revisited task arrived holding the previous conversation and kept it until something else
 * remounted the workspace.
 *
 * Both halves are held here: the read names the task it wants, and the switch lands before anything
 * mounts to read.
 */
describe('opening a task the window has already opened once', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const open = async (title: string) => {
        await userEvent.click(within(sideNav()).getByText(title))
        await flush()
        await flush()
    }

    /** A backend that answers `load_chat` about the task it is asked for, as the real one does. */
    function answerPerTask() {
        let activeTaskId = 'task-1'
        const order: string[] = []
        const chats: Record<string, readonly unknown[]> = {
            'task-1': [{id: 1, sender: 'user', text: 'The player chat', timestamp: 1}],
            'task-2': [{id: 2, sender: 'user', text: 'The inventory chat', timestamp: 2}]
        }
        let hold: Promise<void> | undefined
        let release = (): void => undefined
        tauri.invoke.mockImplementation(async (command: string, payload?: unknown) => {
            const arguments_ = (payload ?? {}) as Record<string, string | undefined>
            if (command === 'check_workspace_health') return readyWorkspace
            if (command === 'list_project_tasks') return tasks
            if (command === 'list_workspace_files') return []
            if (command === 'load_chat') {
                const asked = arguments_['taskId'] ?? activeTaskId
                order.push(`load(${asked})`)
                return {taskId: asked, messages: chats[asked] ?? [], agentMessages: []}
            }
            if (command === 'activate_chat_task') {
                if (hold) await hold
                // A real switch stops the editor and moves the checkout. Never instant, so never
                // instant here either: an activation that resolved in the same microtask as the
                // click would hide the very ordering these tests are about.
                for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
                activeTaskId = arguments_['taskId'] ?? activeTaskId
                order.push(`activated(${activeTaskId})`)
                return undefined
            }
            return undefined
        })
        return {
            order,
            /** Holds the next switch open, so the window can be read while it runs. */
            holdNextSwitch() {
                hold = new Promise<void>(resolve => {
                    release = () => {
                        resolve()
                        hold = undefined
                    }
                })
            },
            release: () => {
                release()
            }
        }
    }

    it('shows that task’s conversation, not the one it came from', async () => {
        answerPerTask()
        await openAt('/tasks/task-1')
        await open('Inventory UI')
        expect(screen.getByText('The inventory chat')).toBeInTheDocument()

        // Back to the first task, which the router already holds a loaded match for.
        await open('Player controller')

        expect(screen.getByText('The player chat')).toBeInTheDocument()
        expect(screen.queryByText('The inventory chat')).toBeNull()
    })

    // Every read names its task. An unnamed read is answered about whichever task the backend has
    // active, which is the question the window is not asking.
    it('asks for the conversation by name', async () => {
        answerPerTask()
        await openAt('/tasks/task-1')
        await open('Inventory UI')

        const reads = tauri.invoke.mock.calls.filter(call => call[0] === 'load_chat')
        expect(reads.length).toBeGreaterThan(0)
        for (const [, payload] of reads)
            expect((payload as {taskId?: string} | undefined)?.taskId).toMatch(/^task-[12]$/u)
    })

    it('does not read the chat until the switch it asked for has landed', async () => {
        const backend = answerPerTask()
        await openAt('/tasks/task-1')
        await open('Inventory UI')
        backend.holdNextSwitch()

        await open('Player controller')

        // Mid-switch the window is still the one it was: the task it left, whole.
        expect(screen.getByText('The inventory chat')).toBeInTheDocument()
        expect(backend.order.at(-1), 'nothing was read while the switch ran').toBe('load(task-2)')

        backend.release()
        await flush()
        await flush()

        expect(screen.getByText('The player chat')).toBeInTheDocument()
        expect(backend.order.slice(-2)).toEqual(['activated(task-1)', 'load(task-1)'])
    })
})
