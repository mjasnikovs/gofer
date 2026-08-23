/**
 * Whether the agent is occupied, for every part of the window that needs to know.
 *
 * There is one such fact in the backend — the single provider operation `refuse_during_turn` guards
 * — and this is its one copy on this side. Two half-copies used to exist: the chat runner's
 * `isStreaming`, published here, and a brief's `isRunning`, published nowhere. The sidebar read only
 * the first, so it offered New task during a fifteen-minute plan and the backend refused it by name.
 *
 * A memory judgement and a memory sweep are turns for the same reason and were the third case of
 * exactly that: `AiTurn::begin` is entered by `run_judge` and `run_sweep` as much as by `run_turn`,
 * and nothing on this side said so. A sweep of eighty rows is over an hour of a window that
 * believed nothing was running. They go through one wrapper in `project-memory` rather than a call
 * at each command, so a fourth run kind is a name here and a route through that wrapper.
 *
 * Why anything outside the conversation needs it: opening or creating a task moves the project's one
 * checkout, and whatever is running is holding file hashes and an open stream against the files that
 * would move. A control that is offered, pressed, and then refused is a worse answer than a control
 * that is not offered.
 *
 * Held here, in the shape `useSyncExternalStore` wants, because the parts that read it are mounted
 * side by side rather than one inside the other — exactly like the task operation flag next door in
 * `task-actions`.
 */

/**
 * The kinds of run there are. A new one adds a name here and one call; nothing that READS this
 * changes, which is the point of holding the fact rather than ORing two of them at each reader.
 */
export type TurnKind = 'chat' | 'brief' | 'memory'

const running = new Set<TurnKind>()
const watchers = new Set<() => void>()

/** Subscribes to [`isTurnRunning`], in the shape `useSyncExternalStore` wants. */
export function watchTurn(notify: () => void) {
    watchers.add(notify)
    return () => {
        watchers.delete(notify)
    }
}

/** Whether the agent is occupied by anything at all. */
export function isTurnRunning() {
    return running.size > 0
}

/** Told by whoever begins or ends a run of that kind, which is the only thing that knows. */
export function setTurnRunning(kind: TurnKind, next: boolean) {
    const was = isTurnRunning()
    if (next) running.add(kind)
    else running.delete(kind)
    if (was === isTurnRunning()) return
    for (const notify of watchers) notify()
}

/** Forgets every run. For tests, which share one module across cases. */
export function clearTurnActivity() {
    running.clear()
    for (const notify of watchers) notify()
}
