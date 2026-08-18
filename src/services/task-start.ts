import type {TaskMode} from '../models/brief'

/**
 * What a newly created task should do the moment its workspace opens.
 *
 * A handoff exists because the two halves happen in different places and cannot be joined by props.
 * The ask is typed in the new-task dialog, which the sidebar owns; the thing that can act on it is
 * the workspace, which does not exist until the route has changed to the task that was just made.
 * Passing it down would mean threading a value the whole tree ignores through every screen between
 * them, and holding it in a route parameter would put the user's prose in the URL.
 *
 * Neither mode sends a message. A planned task's first message is the specification the phases
 * write, and a drafted one's is whatever the user presses Send on — the dialog's ask is put in the
 * composer, where it can still be changed or thrown away.
 *
 * Deliberately single-use. `take` removes it, so a workspace that remounts — a refresh, a switch
 * away and back — does not start the same task a second time.
 */
export type TaskStart = Readonly<{
    prompt: string
    mode: TaskMode
}>

const staged = new Map<string, TaskStart>()

export function stageTaskStart(taskId: string, start: TaskStart) {
    staged.set(taskId, start)
}

/**
 * The staged start for a task, without consuming it.
 *
 * For a caller that has to know WHICH mode is waiting before it knows whether it can act on it: a
 * plan can run the moment the chat is read, a draft cannot be written until the remembered draft is
 * read too. Taking one it cannot act on would drop it.
 */
export function peekTaskStart(taskId: string): TaskStart | undefined {
    return staged.get(taskId)
}

/** The staged start for a task, once. Absent for a task opened from the sidebar, which is ordinary. */
export function takeTaskStart(taskId: string): TaskStart | undefined {
    const start = staged.get(taskId)
    staged.delete(taskId)
    return start
}

/** Drops everything staged. Only the tests need this; nothing in the application clears the map. */
export function clearStagedTaskStarts() {
    staged.clear()
}
