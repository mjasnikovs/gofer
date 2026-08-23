import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {RouterProvider, createMemoryHistory} from '@tanstack/react-router'
import {createAppRouter} from './router'
import {preloadSettingsPage, preloadWorkspace} from './routes-preload'
import {immediateScheduler, setScheduler, timerScheduler} from '../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import {installBackend} from '../test/backend'
import {draftKey} from '../services/ui-state'
import type {Backend, BackendAnswers, BackendOptions} from '../test/backend'
import type {HealthReport} from '../models/health'
import type {Message} from '../models/chat'
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

/**
 * The project this suite opens: the two tasks above, a healthy workspace, an empty explorer.
 *
 * A render walks the whole shell from here — health gate, model splash, side nav, workspace — and
 * every task operation below moves the fake's own tasks rather than a canned reply, so what the
 * sidebar shows afterwards is what the backend did.
 */
let server: Backend
function project(options: BackendOptions = {}) {
    server = installBackend(tauri, {tasks, files: [], ...options})
    return server
}

/** One thing the user said, as a stored conversation holds it. */
const said = (id: number, text: string): Message => ({id, sender: 'user', text, timestamp: id})

/** Every merge the window asked for. The answer about unsaved work is the user's, so it matters. */
const mergeCalls = () =>
    tauri.invoke.mock.calls
        .filter(call => call[0] === 'merge_task_branch')
        .map(call => call[1] as {taskId: string; unsavedWork?: string})

/** Which task the backend is working in, which is what a switch is for. */
const currentTask = () => server.state.tasks.find(task => task.isCurrent)?.id

/**
 * An answer that does the real thing, but not until the test lets go of it.
 *
 * Every task operation stops the Godot editor first — a quit request and a wait of up to ten
 * seconds — so a held command is what the window looks like for most of a switch.
 */
const after = (held: Promise<void>) => async (_: unknown, answer: () => unknown) => {
    await held
    return answer()
}

/** A promise the test resolves by hand, and the release that resolves it. */
function gate() {
    let release = (): void => undefined
    const held = new Promise<void>(resolve => {
        release = () => {
            resolve()
        }
    })
    return {
        held,
        release: () => {
            release()
        }
    }
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
    project()
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    setScheduler(timerScheduler)
    vi.clearAllMocks()
})

/**
 * Makes a task the way the sidebar does.
 *
 * One press. The dialog only exists to ask about files loose in the checkout, and the fake backend
 * below reports none — so with nothing to ask, New task makes one on the spot and opens its chat.
 */
const createTask = async () => {
    await userEvent.click(screen.getByText('New task'))
    await flush()
}

describe('application router', () => {
    it('redirects the root route to the current SQLite task', async () => {
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/']}))

        await router.load()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
        expect(currentTask()).toBe('task-1')
    })

    it('activates a task before resolving its route', async () => {
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/settings']}))
        await router.load()

        await router.navigate({to: '/tasks/$taskId', params: {taskId: 'task-2'}})

        expect(router.state.location.pathname).toBe('/tasks/task-2')
        expect(currentTask(), 'the backend is working in the task the route names').toBe('task-2')
    })

    // A project with no tasks yet has nothing to redirect to, so the root route stays where it is
    // rather than failing the load.
    it('stays on the root route when the project has no current task', async () => {
        project({tasks: []})
        const router = createAppRouter(createMemoryHistory({initialEntries: ['/']}))

        await router.load()

        expect(router.state.location.pathname).toBe('/')
        expect(tauri.invoke).not.toHaveBeenCalledWith('activate_chat_task', expect.anything())
    })

    it('ignores a task list the backend answered with the wrong shape', async () => {
        project({answers: {list_project_tasks: () => [{id: 'task-1'}, 'not a task']}})
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
        const router = await openAt('/tasks/task-1')

        await createTask()
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-3')
        expect(server.state.tasks, 'the project has the task it made').toHaveLength(3)
        expect(currentTask()).toBe('task-3')
    })

    // A task the backend refuses to create must leave the window where it was rather than route to
    // a task id that does not exist.
    it('stays put when the new task could not be created', async () => {
        project({
            answers: {
                create_chat_task: () => {
                    throw coded('task_not_created', 'worktree is locked')
                }
            }
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
        project({
            answers: {
                activate_chat_task: async (_, answer) => {
                    inFlight += 1
                    mostAtOnce = Math.max(mostAtOnce, inFlight)
                    // Stopping the editor is the slow part, and it is why a second click arrives
                    // first.
                    await new Promise(resolve => setTimeout(resolve, 40))
                    inFlight -= 1
                    return answer()
                }
            }
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
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByLabelText('Delete task Player controller'))
        await userEvent.click(screen.getByRole('button', {name: 'Delete task'}))
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-2')
        expect(screen.queryByText('Player controller'), 'the deleted task is gone').toBeNull()
        expect(currentTask()).toBe('task-2')
    })

    it('returns to the root route when the last task was deleted', async () => {
        // The one task the project has, so the deletion empties the list and the root route it
        // falls back to has no current task to redirect on to.
        project({tasks: tasks.slice(0, 1)})
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByLabelText('Delete task Player controller'))
        await userEvent.click(screen.getByRole('button', {name: 'Delete task'}))
        await flush()

        expect(router.state.location.pathname).toBe('/')
        expect(server.state.tasks).toEqual([])
    })

    it('merges the displayed task through the backend and refreshes the list', async () => {
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        // The branch is merged, so the control that merges it is not offered a second time — which
        // is only true if the sidebar re-read the list the merge changed.
        expect(screen.queryByRole('button', {name: 'Merge task'})).toBeNull()
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
        project({
            answers: {
                merge_task_branch: () => {
                    throw coded(
                        'task_merge_conflicted',
                        'This task and the project both changed the same files',
                        {conflicts: ['scenes/Game.tscn', 'scripts/game.gd']}
                    )
                },
                resolve_task_merge: ({taskId}) => ({
                    taskId,
                    conflicts: ['scenes/Game.tscn', 'scripts/game.gd']
                })
            }
        })
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        // The offer names the files, so the user is deciding about something rather than agreeing.
        expect(screen.getByText(/scenes\/Game\.tscn/u)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Let Gofer resolve it'}))
        await flush()

        const sent = tauri.invoke.mock.calls.find(call => call[0] === 'send_ai_message')
        const request = (sent?.[1] as {request?: SendAiMessageRequest} | undefined)?.request
        const prompt = JSON.stringify(request?.messages.at(-1) ?? {})
        expect(prompt).toContain('scenes/Game.tscn')
        expect(prompt).toContain('scripts/game.gd')
        expect(prompt).toContain('<<<<<<<')
    })

    /**
     * The warning the merge never gave.
     *
     * Merging stops the Godot editor, and the stop is the editor's own quit — it saves nothing and
     * asks nothing. A user painting a tilemap pressed Merge and lost the work with no warning
     * anywhere. The backend now refuses that merge and names the scenes; this is the chain from
     * there to the editor writing them and the merge going through.
     */
    it('asks about work the editor is holding and saves it before merging', async () => {
        // Refused once, the way the backend refuses a merge that would throw unsaved scenes away;
        // the answer the user gives is carried on the retry, and the fake merges for real then.
        let asked = false
        project({
            answers: {
                merge_task_branch: (_, answer) => {
                    if (asked) return answer()
                    asked = true
                    throw coded(
                        'godot_unsaved_scenes',
                        'The Godot editor is still holding changes',
                        {scenes: ['res://levels/forest.tscn']}
                    )
                }
            }
        })
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()

        // Named, not counted: which scene is unsaved is what decides the answer.
        expect(screen.getByText(/res:\/\/levels\/forest\.tscn/u)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Save and merge'}))
        await flush()

        expect(mergeCalls().at(-1)).toEqual({taskId: 'task-1', unsavedWork: 'save'})
        expect(
            screen.queryByRole('button', {name: 'Merge task'}),
            'the merge went through'
        ).toBeNull()
    })

    /** The other answer, which is the one that loses the work — so it has to be the user's. */
    it('merges without saving when that is what the user chose', async () => {
        // Refused once, the way the backend refuses a merge that would throw unsaved scenes away;
        // the answer the user gives is carried on the retry, and the fake merges for real then.
        let asked = false
        project({
            answers: {
                merge_task_branch: (_, answer) => {
                    if (asked) return answer()
                    asked = true
                    throw coded(
                        'godot_unsaved_scenes',
                        'The Godot editor is still holding changes',
                        {scenes: ['res://levels/forest.tscn']}
                    )
                }
            }
        })
        await openAt('/tasks/task-1')

        await userEvent.click(screen.getByRole('button', {name: 'Merge task'}))
        await flush()
        await userEvent.click(screen.getByRole('button', {name: 'Merge without saving'}))
        await flush()

        expect(mergeCalls().at(-1)).toEqual({taskId: 'task-1', unsavedWork: 'discard'})
        expect(
            screen.queryByRole('button', {name: 'Merge task'}),
            'the merge went through'
        ).toBeNull()
    })

    /** A failure that is not a conflict has nothing to offer, so nothing is offered. */
    it('offers nothing when the merge failed for a reason the agent cannot fix', async () => {
        project({
            answers: {
                merge_task_branch: () => {
                    throw coded('task_not_merged', 'The project is not a Git repository')
                }
            }
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
        project({
            answers: {
                merge_task_branch: () => {
                    throw coded(
                        'task_merge_unfinished',
                        'This task is part-way through a merge and these files still hold both '
                            + 'versions',
                        {conflicts: ['scenes/Game.tscn']}
                    )
                }
            }
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
        project({tasks: []})
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
        await openAt('/tasks/task-1')
        await userEvent.click(screen.getByRole('button', {name: 'Collapse sidebar'}))
        await flush()

        expect(screen.getByRole('button', {name: 'Expand sidebar'})).toBeInTheDocument()
        expect(server.state.stored['ui.sideNav']).toEqual({isCollapsed: true, width: 280})

        // The window closing and opening again, against the same stored project state.
        cleanup()
        await openAt('/tasks/task-1')

        expect(
            screen.getByRole('button', {name: 'Expand sidebar'}),
            'the sidebar reopened after being left closed'
        ).toBeInTheDocument()
    })

    it('holds the workspace behind the health gate while the project is unusable', async () => {
        project({
            health: {
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
    /**
     * Holds one backend command open, so the window can be read mid-operation.
     *
     * The command still does the real thing when it is let go of. What is held is the wait a switch
     * really has: stopping the Godot editor is a quit request and up to ten seconds.
     */
    function holdOpen(held: (waiting: Promise<void>) => BackendAnswers) {
        const {held: waiting, release} = gate()
        project({answers: held(waiting)})
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
        const release = holdOpen(waiting => ({activate_chat_task: after(waiting)}))

        await userEvent.click(within(sideNav()).getByText('Inventory UI'))
        await flush()

        expectTaskControlsLocked()
        release()
    })

    // The lock is the only thing standing between a fast clicker and Git's index.lock, so a click
    // that lands on a locked row must not reach the backend at all.
    it('ignores a second switch clicked while the first is running', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen(waiting => ({activate_chat_task: after(waiting)}))
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
        const release = holdOpen(waiting => ({activate_chat_task: after(waiting)}))
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
        const release = holdOpen(waiting => ({merge_task_branch: after(waiting)}))

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
        const release = holdOpen(waiting => ({create_chat_task: after(waiting)}))

        await createTask()
        await flush()

        expectTaskControlsLocked()
        release()
    })

    it('locks every task control while a task is being deleted', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen(waiting => ({delete_chat_task: after(waiting)}))

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
        const {held, release} = gate()
        const holding = project({
            chats: {
                'task-1': {taskId: 'task-1', messages: [said(1, openChat)], agentMessages: []},
                'task-2': {
                    taskId: 'task-2',
                    messages: [said(2, 'Inventory grid')],
                    agentMessages: []
                }
            },
            answers: {
                activate_chat_task: async ({taskId}, answer) => {
                    if (taskId === heldTask) await held
                    return answer()
                }
            }
        })
        return {
            release,
            chatOf: (taskId: string) => holding.state.chats.get(taskId)?.messages ?? []
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

    /** The conversation the window opens on, which a refused switch must not take with it. */
    const openConversation = {
        'task-1': {
            taskId: 'task-1',
            messages: [said(1, 'The open conversation')],
            agentMessages: []
        }
    }

    /** Refuses every switch away from the task the window opens on. */
    function answerWithRefusedSwitch() {
        project({
            chats: openConversation,
            answers: {
                activate_chat_task: ({taskId}, answer) => {
                    if (taskId !== 'task-1') throw refusal
                    return answer()
                }
            }
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
        project({
            chats: openConversation,
            answers: {
                create_chat_task: () => {
                    throw refusal
                }
            }
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
        const {held, release} = gate()
        project({answers: {send_ai_message: () => held}})
        return release
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
        const order: string[] = []
        let hold: Promise<void> | undefined
        let release = (): void => undefined
        project({
            chats: {
                'task-1': {
                    taskId: 'task-1',
                    messages: [said(1, 'The player chat')],
                    agentMessages: []
                },
                'task-2': {
                    taskId: 'task-2',
                    messages: [said(2, 'The inventory chat')],
                    agentMessages: []
                }
            },
            answers: {
                load_chat: ({taskId}, answer) => {
                    order.push(`load(${taskId ?? currentTask() ?? ''})`)
                    return answer()
                },
                activate_chat_task: async ({taskId}, answer) => {
                    if (hold) await hold
                    // A real switch stops the editor and moves the checkout. Never instant, so
                    // never instant here either: an activation that resolved in the same microtask
                    // as the click would hide the very ordering these tests are about.
                    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
                    const chat = answer()
                    order.push(`activated(${taskId})`)
                    return chat
                }
            }
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

/*
 * One task's whole life, which nothing could drive before.
 *
 * A task is three things the Ledger keeps together: the row the sidebar lists, the conversation
 * stored against it, and the unsent message under `ui.draft.<taskId>`. The fake answered each of
 * those with one canned value, so a test could see that `create_chat_task` had been called and
 * never that the project now had two tasks, that the second opened on its own conversation, or
 * that deleting it took the draft with it — the `DELETE FROM project_state` beside the row in
 * `Tasks::delete`.
 */
describe('a task from made to deleted', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const composer = () => screen.getByRole('combobox', {name: 'Message input'})
    /** The task rows the sidebar is listing. By route, because two tasks can share a title. */
    const taskRows = () =>
        within(sideNav())
            .getAllByRole('link')
            .filter(row => row.getAttribute('href')?.startsWith('#/tasks/'))
    const rowFor = (taskId: string) =>
        taskRows().find(row => row.getAttribute('href') === `#/tasks/${taskId}`)
    const open = async (taskId: string) => {
        const row = rowFor(taskId)
        if (!row) throw new Error(`The sidebar is not listing ${taskId}`)
        await userEvent.click(row)
        await flush()
        await flush()
    }

    it('opens on its own chat, keeps its own draft, and takes the draft with it', async () => {
        // One task to start with, so the second one is the one this makes.
        project({
            tasks: tasks.slice(0, 1),
            chats: {
                'task-1': {
                    taskId: 'task-1',
                    messages: [said(1, 'The player chat')],
                    agentMessages: []
                }
            }
        })
        const router = await openAt('/tasks/task-1')
        expect(taskRows()).toHaveLength(1)
        expect(screen.getByText('The player chat')).toBeInTheDocument()

        await createTask()
        await flush()

        // Two tasks, and the window is on the one it just made — holding that task's conversation
        // rather than the one it came from.
        expect(taskRows()).toHaveLength(2)
        expect(router.state.location.pathname).toBe('/tasks/task-2')
        expect(currentTask()).toBe('task-2')
        expect(
            screen.queryByText('The player chat'),
            'a new task opens on an empty chat'
        ).toBeNull()

        // An unsent message belongs to the conversation it was written in.
        await userEvent.type(composer(), 'half a thought about the inventory')
        await flush()

        expect(server.state.stored[draftKey('task-2')]).toBe('half a thought about the inventory')

        await open('task-1')

        expect(screen.getByText('The player chat')).toBeInTheDocument()
        expect(composer(), 'the draft stayed with its own task').not.toHaveTextContent('inventory')

        await open('task-2')

        expect(composer()).toHaveTextContent('half a thought about the inventory')

        await userEvent.click(screen.getByLabelText('Delete task New task'))
        await userEvent.click(screen.getByRole('button', {name: 'Delete task'}))
        await flush()

        // The task that took its place, and nothing of the deleted one left anywhere.
        expect(router.state.location.pathname).toBe('/tasks/task-1')
        expect(server.state.tasks.map(task => task.id)).toEqual(['task-1'])
        expect(
            draftKey('task-2') in server.state.stored,
            'the unsent message went with the task'
        ).toBe(false)
    })
})
