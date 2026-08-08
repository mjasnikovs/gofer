import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMemoryHistory} from '@tanstack/react-router'
import {createAppRouter} from './router'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'

const tauri = createDesktopFake()

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
    installDesktopFake(tauri)
    tauri.invoke.mockImplementation(async command => {
        if (command === 'list_project_tasks') return tasks
        return undefined
    })
})

afterEach(() => {
    removeDesktopFake()
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
