import {invoke, isTauri} from './desktop'
import {isPendingChange, isTaskSummary} from '../models/app'
import type {PendingChange, TaskSummary} from '../models/app'
import type {UnsavedWork} from '../models/unsaved-work'

/**
 * What the window does to a task, as opposed to which task it draws.
 *
 * Creating, deleting and merging a task are each a sequence rather than a command: a created task
 * is not the displayed one until the window follows it, a deleted one leaves the route naming a
 * task that no longer exists, and merging one that has no branch is a control that would do
 * nothing at all when pressed. Those rules used to live in the router's body, where the only way to
 * check any of them was to mount the whole shell.
 *
 * Nothing here is React. The router builds one of these from the navigation it owns and hands the
 * results to buttons.
 */

/** Where an action leaves the window. `undefined` is the workspace with no task named. */
export type TaskDestination = string | undefined

/**
 * Whether a task operation is running, for everything that must not offer a second one.
 *
 * Held here rather than in the shell because the four operations do not share a caller: creating,
 * deleting and merging are actions the router builds, while opening one is a route loader that runs
 * before any component of the shell exists. A flag in React state would be set by three of them and
 * missed by the fourth — the one that matters most, because it is the one a user repeats by clicking
 * the sidebar again.
 *
 * Why the window needs to know at all: every one of these moves the project's single checkout, and
 * each stops the Godot editor before it does. That is a quit request and a wait of up to ten
 * seconds, during which the window used to look idle and answer every control. The backend now
 * refuses the second operation, but a refusal the user did not need to see is better than one they
 * did.
 */
let running = 0
const watchers = new Set<() => void>()

/** Subscribes to [`isTaskOperationRunning`], in the shape `useSyncExternalStore` wants. */
export function watchTaskOperation(notify: () => void) {
    watchers.add(notify)
    return () => {
        watchers.delete(notify)
    }
}

export function isTaskOperationRunning() {
    return running > 0
}

/** Counts one operation in and out, whatever it answers. */
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
    /** Re-reads the list, so the sidebar shows what the action did. */
    refresh: () => Promise<void>
}>

export type TaskActions = Readonly<{
    /** Opens an existing task. The only action that changes nothing but the route. */
    open: (taskId: string) => Promise<void>
    /**
     * Makes a task and opens it.
     *
     * `bringChanges` decides what happens to files loose in the checkout. Left alone they are
     * committed onto the task being closed, which is how a file the user copied in by hand
     * disappears from disk the moment the new branch is checked out.
     */
    create: (bringChanges?: boolean) => Promise<void>
    remove: (taskId: string) => Promise<void>
    /**
     * Merges the task the window is displaying, or says why it cannot.
     *
     * `unsavedWork` is the answer to the question the merge asks about the Godot editor. Left out,
     * a merge that would throw away unsaved scenes is refused and names them; `save` writes them
     * first and `discard` is the user saying to let them go.
     */
    merge: (task: TaskSummary | undefined, unsavedWork?: UnsavedWork) => Promise<void>
    /**
     * Brings the project's branch into the task, and answers what clashed.
     *
     * Offered after a merge Git could not do on its own. The conflict lands in the task's own
     * worktree as files holding both versions, which is what the agent can then be asked to fix.
     */
    resolveMerge: (task: TaskSummary | undefined) => Promise<readonly string[]>
    /** Throws away an unfinished resolution merge and leaves the task as it was. */
    abandonMerge: (task: TaskSummary | undefined) => Promise<void>
}>

/**
 * Every task the project has, or none.
 *
 * A list that is not a list of tasks is answered as empty rather than thrown: the sidebar is drawn
 * from this on every refresh, and a shape nobody recognises is not worth taking the window down
 * for.
 */
export async function listTasks(): Promise<readonly TaskSummary[]> {
    if (!isTauri()) return []
    const response = await invoke('list_project_tasks')
    if (!Array.isArray(response) || !response.every(isTaskSummary)) return []
    return response
}

/**
 * Makes the task the route names the one the backend is working in.
 *
 * Ordering: this has to land before the workspace reads the chat, because `load_chat` answers about
 * whichever task is active. The router runs it as a route loader, which is what puts it before the
 * component mounting underneath.
 */
export async function activateTask(taskId: string) {
    if (!isTauri()) return
    await whileRunning(async () => {
        await invoke('activate_chat_task', {taskId})
    })
}

/**
 * What the checkout is carrying that no commit has.
 *
 * Answered as empty rather than thrown: this only decides whether the new-task dialog asks an extra
 * question, and a project with no repository yet has nothing to ask about.
 */
export async function listPendingChanges(): Promise<readonly PendingChange[]> {
    if (!isTauri()) return []
    const changes = await invoke('pending_project_changes').catch(() => [])
    if (!Array.isArray(changes) || !changes.every(isPendingChange)) return []
    return changes
}

export function createTaskActions({navigate, refresh}: TaskActionDeps): TaskActions {
    return {
        async open(taskId) {
            // A click that arrives while the last one is still opening a task is the click the
            // sidebar has already stopped offering. Answering it anyway would put a second switch
            // into a backend that has one working tree.
            if (isTaskOperationRunning()) return
            await navigate(taskId)
        },

        // The failure is answered rather than swallowed. A creation is refused for reasons the
        // click cannot see — a turn still running, another task operation holding the checkout —
        // and a button that quietly does nothing is the same as a broken one.
        //
        // Nothing is staged with it. A new task opens on an empty composer, and what it should do
        // is whatever the user types there — including planning, which is a control beside Send.
        async create(bringChanges = false) {
            if (!isTauri()) return
            const created = await whileRunning(() => invoke('create_chat_task', {bringChanges}))
            if (!created.taskId) return
            await refresh()
            await navigate(created.taskId)
        },

        // The backend answers with the task that took the deleted one's place, so the window
        // follows it rather than being left on a route whose task no longer exists.
        async remove(taskId) {
            if (!isTauri()) return
            const replacement = await whileRunning(() =>
                invoke('delete_chat_task', {taskId}).catch(() => undefined)
            )
            await refresh()
            await navigate(replacement?.taskId)
        },

        // Saying nothing is the one thing this must not do. The button is offered by the same
        // record this reads, so the two disagreeing means the list went stale under the window —
        // and returning quietly left a control that did nothing at all when pressed, with no
        // failure anywhere to explain it.
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
