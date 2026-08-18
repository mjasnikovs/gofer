import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {activateTask, createTaskActions, listTasks} from './task-actions'
import {installBackend} from '../test/backend'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import type {BackendAnswers} from '../test/backend'
import type {TaskSummary} from '../models/app'

/**
 * What the window does to a task, checked without a window.
 *
 * Each of these used to be a callback in the router's body, so the only way to reach the
 * delete-follows-the-replacement rule or the merge refusal was to mount the whole shell and press
 * a button. They are sequences and branches, so they are checked as sequences and branches.
 */

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
    return {
        id: 'task-1',
        title: 'A task',
        status: 'active',
        isCurrent: true,
        createdAt: 1,
        updatedAt: 1,
        ...overrides
    }
}

const WORKTREE = {
    branchName: 'gofer/task-1',
    worktreePath: '/tmp/worktree',
    baseCommit: 'abc'
}

function actions(answers: BackendAnswers = {}) {
    const fake = createDesktopFake()
    installDesktopFake(fake)
    installBackend(fake, {answers})
    const navigate = vi.fn(async () => undefined)
    const refresh = vi.fn(async () => undefined)
    return {tasks: createTaskActions({navigate, refresh}), navigate, refresh, fake}
}

beforeEach(() => {
    removeDesktopFake()
})

afterEach(() => {
    removeDesktopFake()
})

describe('listTasks', () => {
    it('answers with the tasks the project has', async () => {
        const stored = task()
        actions({list_project_tasks: () => [stored]})
        expect(await listTasks()).toEqual([stored])
    })

    it('answers empty rather than throwing when the list is not a list of tasks', async () => {
        actions({list_project_tasks: () => [{id: 'task-1'}]})
        expect(await listTasks()).toEqual([])
    })
})

describe('activateTask', () => {
    it('names the task the backend should work in', async () => {
        const {fake} = actions()
        await activateTask('task-7')
        expect(fake.invoke).toHaveBeenCalledWith('activate_chat_task', {taskId: 'task-7'})
    })
})

describe('creating a task', () => {
    it('refreshes the list, then follows the task it made', async () => {
        const {tasks, navigate, refresh} = actions({create_chat_task: () => ({taskId: 'task-9'})})
        await tasks.create()
        expect(refresh).toHaveBeenCalled()
        expect(navigate).toHaveBeenCalledWith('task-9')
    })

    // The refusal is the caller's to show — the sidebar puts it on screen — so it is answered
    // rather than swallowed. What must not happen is the window moving to a task that was refused.
    it('leaves the window where it is and says why the backend refused', async () => {
        const {tasks, navigate, refresh} = actions({
            create_chat_task: () => {
                throw new Error('no')
            }
        })
        await expect(tasks.create()).rejects.toThrow('no')
        expect(refresh).not.toHaveBeenCalled()
        expect(navigate).not.toHaveBeenCalled()
    })
})

describe('deleting a task', () => {
    it('follows the task the backend named as the replacement', async () => {
        const {tasks, navigate} = actions({delete_chat_task: () => ({taskId: 'task-2'})})
        await tasks.remove('task-1')
        expect(navigate).toHaveBeenCalledWith('task-2')
    })

    it('goes to the workspace with no task when nothing replaced it', async () => {
        const {tasks, navigate} = actions({delete_chat_task: () => ({})})
        await tasks.remove('task-1')
        expect(navigate).toHaveBeenCalledWith(undefined)
    })

    it('still refreshes the list when the delete fails', async () => {
        const {tasks, refresh, navigate} = actions({
            delete_chat_task: () => {
                throw new Error('no')
            }
        })
        await tasks.remove('task-1')
        expect(refresh).toHaveBeenCalled()
        expect(navigate).toHaveBeenCalledWith(undefined)
    })
})

describe('merging a task', () => {
    it('merges the task and refreshes the list', async () => {
        const {tasks, refresh, fake} = actions()
        await tasks.merge(task({worktree: WORKTREE}))
        expect(fake.invoke).toHaveBeenCalledWith('merge_task_branch', {taskId: 'task-1'})
        expect(refresh).toHaveBeenCalled()
    })

    it('says why a task with no branch cannot be merged, rather than doing nothing', async () => {
        const {tasks, fake} = actions()
        await expect(tasks.merge(task())).rejects.toThrow(/no branch to merge/)
        expect(fake.invoke).not.toHaveBeenCalledWith('merge_task_branch', expect.anything())
    })

    it('refuses the same way when no task is displayed at all', async () => {
        const {tasks} = actions()
        await expect(tasks.merge(undefined)).rejects.toThrow(/no branch to merge/)
    })
})
