import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {RouterProvider, createMemoryHistory} from '@tanstack/react-router'
import {createAppRouter} from './router'
import {preloadSettingsPage, preloadWorkspace} from './routes-preload'
import {immediateScheduler, setScheduler, timerScheduler} from '../services/clock'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import type {HealthReport} from '../models/health'
import type {TaskSummary} from '../models/app'

const tauri = createDesktopFake()

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
        updatedAt: 19
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
        expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('opens a new task and moves the window to it', async () => {
        answerAsDesktop({create_chat_task: {taskId: 'task-3'}})
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByText('New task'))
        await flush()

        expect(tauri.invoke).toHaveBeenCalledWith('create_chat_task', undefined)
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

        await userEvent.click(screen.getByText('New task'))
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
    })

    it('opens the task the sidebar was clicked on', async () => {
        const router = await openAt('/tasks/task-1')

        await userEvent.click(screen.getByText('Inventory UI'))
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-2')
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

        expect(tauri.invoke).toHaveBeenCalledWith('merge_task_worktree', {taskId: 'task-1'})
        expect(
            tauri.invoke.mock.calls.filter(call => call[0] === 'list_project_tasks').length
        ).toBeGreaterThan(1)
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
        expect(screen.getByDisplayValue('Local AI')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Close'}))
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
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
