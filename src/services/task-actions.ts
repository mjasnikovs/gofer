import {invoke, isTauri} from './desktop'
import {clearThumbnails} from './file-thumbnails'
import {isPendingChange, isTaskSummary} from '../models/app'
import type {PendingChange, TaskSummary} from '../models/app'
import type {UnsavedWork} from '../models/unsaved-work'

export type TaskDestination = string | undefined

let running = 0
const watchers = new Set<() => void>()

export function watchTaskOperation(notify: () => void) {
    watchers.add(notify)
    return () => {
        watchers.delete(notify)
    }
}

export function isTaskOperationRunning() {
    return running > 0
}

async function whileRunning<T>(operation: () => Promise<T>): Promise<T> {
    running += 1
    for (const notify of watchers) notify()
    try {
        return await operation()
    } finally {
        running -= 1
        for (const notify of watchers) notify()
    }
}

export type TaskActionDeps = Readonly<{
    navigate: (taskId: TaskDestination) => Promise<void>
    refresh: () => Promise<void>
}>

export type TaskActions = Readonly<{
    open: (taskId: string) => Promise<void>
    create: (bringChanges?: boolean) => Promise<void>
    remove: (taskId: string) => Promise<void>
    merge: (task: TaskSummary | undefined, unsavedWork?: UnsavedWork) => Promise<void>
    resolveMerge: (task: TaskSummary | undefined) => Promise<readonly string[]>
    abandonMerge: (task: TaskSummary | undefined) => Promise<void>
}>

export async function listTasks(): Promise<readonly TaskSummary[]> {
    if (!isTauri()) return []
    const response = await invoke('list_project_tasks')
    if (!Array.isArray(response) || !response.every(isTaskSummary)) return []
    return response
}

export async function activateTask(taskId: string) {
    if (!isTauri()) return
    await whileRunning(async () => {
        await invoke('activate_chat_task', {taskId})
        clearThumbnails()
    })
}

export async function listPendingChanges(): Promise<readonly PendingChange[]> {
    if (!isTauri()) return []
    const changes = await invoke('pending_project_changes').catch(() => [])
    if (!Array.isArray(changes) || !changes.every(isPendingChange)) return []
    return changes
}

export function createTaskActions({navigate, refresh}: TaskActionDeps): TaskActions {
    return {
        async open(taskId) {
            if (isTaskOperationRunning()) return
            await navigate(taskId)
        },

        async create(bringChanges = false) {
            if (!isTauri()) return
            const created = await whileRunning(() => invoke('create_chat_task', {bringChanges}))
            if (!created.taskId) return
            await refresh()
            await navigate(created.taskId)
        },

        async remove(taskId) {
            if (!isTauri()) return
            const replacement = await whileRunning(() =>
                invoke('delete_chat_task', {taskId}).catch(() => undefined)
            )
            await refresh()
            await navigate(replacement?.taskId)
        },

        async merge(task, unsavedWork) {
            if (!task?.worktree) {
                throw new Error(
                    'This task has no branch to merge. Reopen it from the sidebar and try again.'
                )
            }
            await whileRunning(() =>
                invoke('merge_task_branch', {taskId: task.id, ...(unsavedWork && {unsavedWork})})
            )
            await refresh()
        },

        async resolveMerge(task) {
            if (!task?.worktree) {
                throw new Error(
                    'This task has no branch to merge. Reopen it from the sidebar and try again.'
                )
            }
            const resolved = await whileRunning(() =>
                invoke('resolve_task_merge', {taskId: task.id})
            )
            await refresh()
            return resolved.conflicts
        },

        async abandonMerge(task) {
            if (!task?.worktree) return
            await whileRunning(() => invoke('abandon_task_merge', {taskId: task.id}))
            await refresh()
        }
    }
}
