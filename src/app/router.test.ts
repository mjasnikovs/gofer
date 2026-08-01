import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMemoryHistory} from '@tanstack/react-router'
import {createAppRouter} from './router'

type InvokeFunction = (command: string, args?: unknown) => Promise<unknown>
type IsTauriFunction = () => boolean

const tauri = vi.hoisted(() => ({
    invoke: vi.fn<InvokeFunction>(),
    isTauri: vi.fn<IsTauriFunction>()
}))

vi.mock('../services/desktop', () => ({invoke: tauri.invoke, isTauri: tauri.isTauri}))

const tasks = [
    {
        id: 'task-1',
        title: 'Player controller',
        status: 'active',
        isCurrent: true,
        createdAt: 10,
        updatedAt: 20
    },
    {
        id: 'task-2',
        title: 'Inventory UI',
        status: 'active',
        isCurrent: false,
        createdAt: 11,
        updatedAt: 19
    }
] as const

beforeEach(() => {
    tauri.isTauri.mockReturnValue(true)
    tauri.invoke.mockImplementation(async command => {
        if (command === 'list_project_tasks') return tasks
        return undefined
    })
})

describe('application router', () => {
    it('redirects the root route to the current SQLite task', async () => {
        const history = createMemoryHistory({initialEntries: ['/']})
        const router = createAppRouter(history)

        await router.load()

        expect(router.state.location.pathname).toBe('/tasks/task-1')
        expect(tauri.invoke).toHaveBeenCalledWith('activate_chat_task', {taskId: 'task-1'})
    })

    it('activates a task before resolving its route', async () => {
        const history = createMemoryHistory({initialEntries: ['/settings']})
        const router = createAppRouter(history)
        await router.load()

        await router.navigate({to: '/tasks/$taskId', params: {taskId: 'task-2'}})

        expect(router.state.location.pathname).toBe('/tasks/task-2')
        expect(tauri.invoke).toHaveBeenCalledWith('activate_chat_task', {taskId: 'task-2'})
    })
})
