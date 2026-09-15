/**
 * Auto mode for the board: the next ready card is posted, run, and merged without a hand on it.
 *
 * The state lives here, above the Workspace, because the Workspace is remounted for every task it
 * opens and the loop opens one per card. It is session state: the project reopens with it off.
 */

export type AutopilotPhase = 'off' | 'picking' | 'opening' | 'running' | 'merging' | 'resolving'

export type AutopilotStop =
    | 'ready-empty'
    | 'card-not-reviewed'
    | 'card-gone'
    | 'card-has-task'
    | 'loose-changes'
    | 'post-failed'
    | 'send-failed'
    | 'read-failed'
    | 'turn-aborted'
    | 'turn-failed'
    | 'turn-lost'
    | 'merge-conflict-again'
    | 'merge-failed'
    | 'unsaved-scenes'
    | 'task-missing'

export type TurnEnding = 'complete' | 'aborted' | 'error' | 'lost'

/** The card the loop is on, and the task post gave it. */
export type AutopilotCard = Readonly<{id: string; number: number; taskId: string}>

/** A message the task's Workspace sends once its chat is open; no text means the card's draft. */
export type AutopilotSend = Readonly<{
    taskId: string
    text?: string
    then: 'running' | 'resolving'
}>

export type Autopilot = Readonly<{
    phase: AutopilotPhase
    card?: AutopilotCard
    send?: AutopilotSend
    ended?: TurnEnding
    /** Merge has already been tried once and the conflicts handed to the model. */
    resolvedOnce?: boolean
    /** The last step was refused for now; the next outside signal tries it again. */
    refused?: boolean
    stop?: AutopilotStop
    detail?: string
}>

export const STOP_LABELS: Readonly<Record<AutopilotStop, string>> = {
    'ready-empty': 'nothing left in Ready',
    'card-not-reviewed': 'the card was not moved to Review',
    'card-gone': 'the card is gone',
    'card-has-task': 'the top card already has a task',
    'loose-changes': 'the project has unsaved changes',
    'post-failed': 'the card could not be posted',
    'send-failed': 'the ask could not be sent',
    'read-failed': 'the board or the task list could not be read',
    'turn-aborted': 'the turn was stopped',
    'turn-failed': 'the turn failed',
    'turn-lost': 'the task was left while its turn ran',
    'merge-conflict-again': 'the merge still conflicts after one resolution',
    'merge-failed': 'the merge failed',
    'unsaved-scenes': 'the editor holds unsaved scenes',
    'task-missing': 'the task is gone'
}

/** Goes on the end of the card's ask, so a project with its own prompt still hears it. */
export const AUTO_LINE =
    'When this is done, move the card to review. If you are stuck, comment on the card and leave it in doing.'

/** One line on where auto mode is, or why it stopped. Empty while it is off and has not run. */
export function autopilotStatus(state: Autopilot): string {
    const number = state.card ? ` #${String(state.card.number)}` : ''
    switch (state.phase) {
        case 'off':
            return state.stop ? `Auto stopped: ${STOP_LABELS[state.stop]}` : ''
        case 'picking':
            return 'Auto: picking the next Ready card'
        case 'opening':
            return `Auto: opening card${number}`
        case 'running':
            return `Auto: running card${number}`
        case 'merging':
            return `Auto: merging card${number}`
        case 'resolving':
            return `Auto: resolving conflicts on card${number}`
    }
}

const OFF: Autopilot = {phase: 'off'}

let current: Autopilot = OFF
const watchers = new Set<() => void>()

function publish(next: Autopilot) {
    current = next
    for (const notify of watchers) notify()
}

export function watchAutopilot(notify: () => void) {
    watchers.add(notify)
    return () => {
        watchers.delete(notify)
    }
}

export function autopilotState(): Autopilot {
    return current
}

export function startAutopilot() {
    publish({phase: 'picking'})
}

export function stopAutopilot(stop?: AutopilotStop, detail?: string) {
    publish({phase: 'off', ...(stop && {stop}), ...(detail && {detail})})
}

/**
 * A step's move, applied only if the loop is still where the step found it. A switch turned off
 * while the step was away, or a run started over, is not undone by the step coming back.
 */
export function moveAutopilot(from: Autopilot, to: Autopilot): boolean {
    if (current !== from) return false
    publish(to)
    return true
}

/** Puts the loop somewhere outright; the tests' way in, never a step's. */
export function setAutopilot(next: Autopilot) {
    publish(next)
}

export function haltAutopilot(from: Autopilot, stop: AutopilotStop, detail?: string): boolean {
    return moveAutopilot(from, {phase: 'off', stop, ...(detail && {detail})})
}

/** The Workspace of `taskId` takes what it has to send, once. */
export function takeAutopilotSend(taskId: string): AutopilotSend | undefined {
    const {send, ...rest} = current
    if (send?.taskId !== taskId) return undefined
    publish({...rest, phase: send.then})
    return send
}

/** The Workspace of `taskId` says how its turn ended; another task's turn is not the loop's. */
export function autopilotTurnEnded(taskId: string, ending: TurnEnding) {
    if (current.card?.taskId !== taskId) return
    if (current.phase !== 'running' && current.phase !== 'resolving') return
    publish({...current, ended: ending})
}

export function clearAutopilot() {
    publish(OFF)
}
