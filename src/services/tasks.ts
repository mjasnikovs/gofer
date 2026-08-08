import {invoke} from './desktop'

/**
 * The renderer's half of the task commands: the chat tasks in the sidebar and the worktrees behind
 * them. Named functions rather than command strings scattered through the router, so a rename in
 * Rust breaks the contract test instead of a click.
 */

export function listProjectTasks() {
    return invoke('list_project_tasks')
}

export function createChatTask() {
    return invoke('create_chat_task')
}

/** Answers with the task that took the deleted one's place, so the window has somewhere to go. */
export function deleteChatTask(taskId: string) {
    return invoke('delete_chat_task', {taskId})
}

export function activateChatTask(taskId: string) {
    return invoke('activate_chat_task', {taskId})
}

export function mergeTaskWorktree(taskId: string) {
    return invoke('merge_task_worktree', {taskId})
}
