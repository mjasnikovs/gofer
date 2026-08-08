import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
    activateChatTask,
    createChatTask,
    deleteChatTask,
    listProjectTasks,
    mergeTaskWorktree
} from './tasks'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'

const tauri = createDesktopFake()

beforeEach(() => {
    installDesktopFake(tauri)
    tauri.invoke.mockResolvedValue(undefined)
})

afterEach(() => {
    removeDesktopFake()
})

/*
 * These wrappers exist so no caller writes a command name itself, which means the only thing worth
 * checking about them is the name and the payload each one sends. A rename in Rust is caught by
 * `desktop.contract.test.ts`; this file catches a wrapper sending the wrong one of the five.
 */
describe('task commands', () => {
    it('asks the backend for the project task list', async () => {
        tauri.invoke.mockResolvedValue([{id: 'task-1'}])

        await expect(listProjectTasks()).resolves.toEqual([{id: 'task-1'}])
        expect(tauri.invoke).toHaveBeenCalledWith('list_project_tasks', undefined)
    })

    it('creates a task and passes back what the backend named it', async () => {
        tauri.invoke.mockResolvedValue({taskId: 'task-2'})

        await expect(createChatTask()).resolves.toEqual({taskId: 'task-2'})
        expect(tauri.invoke).toHaveBeenCalledWith('create_chat_task', undefined)
    })

    it('names the task it deletes, activates, and merges', async () => {
        await deleteChatTask('task-1')
        await activateChatTask('task-2')
        await mergeTaskWorktree('task-3')

        expect(tauri.invoke).toHaveBeenCalledWith('delete_chat_task', {taskId: 'task-1'})
        expect(tauri.invoke).toHaveBeenCalledWith('activate_chat_task', {taskId: 'task-2'})
        expect(tauri.invoke).toHaveBeenCalledWith('merge_task_worktree', {taskId: 'task-3'})
    })

    it('lets a backend failure reach the caller rather than swallowing it', async () => {
        tauri.invoke.mockRejectedValue(new Error('worktree has uncommitted changes'))

        await expect(mergeTaskWorktree('task-1')).rejects.toThrow('uncommitted changes')
    })
})
