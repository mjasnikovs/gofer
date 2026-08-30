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

let server: Backend
function project(options: BackendOptions = {}) {
    server = installBackend(tauri, {tasks, files: [], ...options})
    return server
}

const said = (id: number, text: string): Message => ({id, sender: 'user', text, timestamp: id})

const mergeCalls = () =>
    tauri.invoke.mock.calls
        .filter(call => call[0] === 'merge_task_branch')
        .map(call => call[1] as {taskId: string; unsavedWork?: string})

const currentTask = () => server.state.tasks.find(task => task.isCurrent)?.id

const after = (held: Promise<void>) => async (_: unknown, answer: () => unknown) => {
    await held
    return answer()
}

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

    it('never has two task switches in flight at once', async () => {
        let inFlight = 0
        let mostAtOnce = 0
        project({
            answers: {
                activate_chat_task: async (_, answer) => {
                    inFlight += 1
                    mostAtOnce = Math.max(mostAtOnce, inFlight)
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

        expect(screen.queryByRole('button', {name: 'Merge task'})).toBeNull()
    })

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

    it('asks about work the editor is holding and saves it before merging', async () => {
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

        expect(screen.getByText(/res:\/\/levels\/forest\.tscn/u)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Save and merge'}))
        await flush()

        expect(mergeCalls().at(-1)).toEqual({taskId: 'task-1', unsavedWork: 'save'})
        expect(
            screen.queryByRole('button', {name: 'Merge task'}),
            'the merge went through'
        ).toBeNull()
    })

    it('merges without saving when that is what the user chose', async () => {
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
        expect(await screen.findByDisplayValue('Local AI')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Close'}))
        await flush()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
    })

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

    it('closes settings to the root route when no task is current', async () => {
        project({tasks: []})
        const router = await openAt('/settings')

        await userEvent.click(screen.getByRole('button', {name: 'Close'}))
        await flush()

        expect(router.state.location.pathname).toBe('/')
    })

    it('reopens the project with the sidebar the user left closed', async () => {
        await openAt('/tasks/task-1')
        await userEvent.click(screen.getByRole('button', {name: 'Collapse sidebar'}))
        await flush()

        expect(screen.getByRole('button', {name: 'Expand sidebar'})).toBeInTheDocument()
        expect(server.state.stored['ui.sideNav']).toEqual({isCollapsed: true, width: 280})

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

describe('while a task operation is running', () => {
    function holdOpen(held: (waiting: Promise<void>) => BackendAnswers) {
        const {held: waiting, release} = gate()
        project({answers: held(waiting)})
        return release
    }

    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const taskRow = (title: string) => within(sideNav()).getByText(title).closest('a, button')

    function isOffered(element: Element | null) {
        expect(element, 'the control is on screen').not.toBeNull()
        if (element instanceof HTMLButtonElement && element.disabled) return false
        return element?.getAttribute('aria-disabled') !== 'true'
    }

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

    it('ignores a second switch clicked while the first is running', async () => {
        await openAt('/tasks/task-1')
        const release = holdOpen(waiting => ({activate_chat_task: after(waiting)}))
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

describe('while a switch is still running', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const workspaceTitle = () =>
        screen.getAllByRole('heading', {level: 1}).find(heading => !sideNav().contains(heading))
            ?.textContent
    const openChat = 'Validate docs/tasks/20'

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

        expect(router.state.location.pathname).toBe('/tasks/task-3')
        expect(workspaceTitle(), 'the title names the chat below it').toBe('Player controller')
        expect(screen.getByText(openChat)).toBeInTheDocument()

        backend.release()
        await flush()
        await flush()

        expect(workspaceTitle()).toBe('New task')
        expect(screen.queryByText(openChat), 'the new task opens on its own chat').toBeNull()
        expect(backend.chatOf('task-3'), 'a skipped task opens on an empty chat').toEqual([])
        expect(backend.chatOf('task-1'), 'the conversation stayed on its own task').toHaveLength(1)
    })

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

describe('when the backend refuses to open a task', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const refusal = coded(
        'ai_request_in_progress',
        'Wait for the current answer to finish before opening another task'
    )

    const openConversation = {
        'task-1': {
            taskId: 'task-1',
            messages: [said(1, 'The open conversation')],
            agentMessages: []
        }
    }

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

        expect(sideNav()).toBeInTheDocument()
        expect(screen.getByText('The open conversation')).toBeInTheDocument()
        expect(router.state.location.pathname, 'and it names the task it kept').toBe(
            '/tasks/task-1'
        )
    })

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

describe('while the agent is answering', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const taskRow = (title: string) => within(sideNav()).getByText(title).closest('a, button')
    const REASON = /Stop it to open or create a task/

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
        await userEvent.hover(within(sideNav()).getByText('New task'))
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

describe('opening a task the window has already opened once', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const open = async (title: string) => {
        await userEvent.click(within(sideNav()).getByText(title))
        await flush()
        await flush()
    }

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
                    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve()
                    const chat = answer()
                    order.push(`activated(${taskId})`)
                    return chat
                }
            }
        })
        return {
            order,
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

        await open('Player controller')

        expect(screen.getByText('The player chat')).toBeInTheDocument()
        expect(screen.queryByText('The inventory chat')).toBeNull()
    })

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

        expect(screen.getByText('The inventory chat')).toBeInTheDocument()
        expect(backend.order.at(-1), 'nothing was read while the switch ran').toBe('load(task-2)')

        backend.release()
        await flush()
        await flush()

        expect(screen.getByText('The player chat')).toBeInTheDocument()
        expect(backend.order.slice(-2)).toEqual(['activated(task-1)', 'load(task-1)'])
    })
})

describe('a task from made to deleted', () => {
    const sideNav = () => screen.getByRole('navigation', {name: 'Side navigation'})
    const composer = () => screen.getByRole('combobox', {name: 'Message input'})
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

        expect(taskRows()).toHaveLength(2)
        expect(router.state.location.pathname).toBe('/tasks/task-2')
        expect(currentTask()).toBe('task-2')
        expect(
            screen.queryByText('The player chat'),
            'a new task opens on an empty chat'
        ).toBeNull()

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

        expect(router.state.location.pathname).toBe('/tasks/task-1')
        expect(server.state.tasks.map(task => task.id)).toEqual(['task-1'])
        expect(
            draftKey('task-2') in server.state.stored,
            'the unsent message went with the task'
        ).toBe(false)
    })
})
