import {useEffect, useLayoutEffect, useRef} from 'react'
import {cardsIn} from '../models/board'
import {conflictPrompt, isMergeClash} from '../models/merge-prompt'
import {UNSAVED_WORK_CODE} from '../models/unsaved-work'
import {
    autopilotState,
    haltAutopilot,
    moveAutopilot,
    watchAutopilot
} from '../services/board-autopilot'
import type {Autopilot, AutopilotCard} from '../services/board-autopilot'
import {listCards, postCardToGofer, watchBoard} from '../services/board'
import {
    isTaskOperationRunning,
    listPendingChanges,
    listTasks,
    watchTaskOperation
} from '../services/task-actions'
import type {TaskActions} from '../services/task-actions'
import {isTurnRunning, watchTurn} from '../services/turn-activity'
import {toCommandError} from '../utils/command-error'

export type AutopilotDeps = Readonly<{
    tasks: TaskActions
    openTask: (taskId: string) => void
}>

/**
 * Drives the board's auto mode: one step per tick, a tick whenever a turn, a task operation, the
 * board or the mode itself changes. Mounted once, above the Workspace that every opened task
 * replaces. The Workspace does the sending and reports the turn's end; nothing else is its job.
 */
export function useBoardAutopilot(deps: AutopilotDeps) {
    const newest = useRef(deps)
    const inFlight = useRef(false)

    useLayoutEffect(() => {
        newest.current = deps
    })

    useEffect(() => {
        const tick = () => {
            if (inFlight.current) return
            const state = autopilotState()
            if (state.phase === 'off' || isTurnRunning() || isTaskOperationRunning()) return
            // Claimed before the step runs: a step that changes the phase before its first await
            // wakes this tick again from inside itself.
            inFlight.current = true
            const work = step(state, newest.current)
            if (!work) {
                inFlight.current = false
                return
            }
            void work
                .catch((error: unknown) => {
                    haltAutopilot(state, 'read-failed', toCommandError(error).message)
                })
                .finally(() => {
                    inFlight.current = false
                    // A step that moved the phase may have made the next one due already. One
                    // refused for now waits for the next signal from outside.
                    const next = autopilotState()
                    if (next !== state && !next.refused) tick()
                })
        }
        const stops = [watchAutopilot(tick), watchTurn(tick), watchTaskOperation(tick)]
        let cancelled = false
        void watchBoard(tick).then(unlisten => {
            if (cancelled) unlisten()
            else stops.push(unlisten)
        })
        tick()
        return () => {
            cancelled = true
            for (const stop of stops) stop()
        }
    }, [])
}

/** The one action a phase owes, or nothing when the phase is waiting on the Workspace. */
function step(state: Autopilot, deps: AutopilotDeps): Promise<void> | undefined {
    switch (state.phase) {
        case 'picking':
            return pick(state, deps)
        case 'opening':
            // The route can be moved from under a post, and a merge does not move it at all;
            // asking again is free when the task is already open.
            if (state.card) deps.openTask(state.card.taskId)
            return undefined
        case 'running':
        case 'resolving':
            return state.card && state.ended ? afterTurn(state, state.card) : undefined
        case 'merging':
            return state.card ? merge(state, state.card, deps.tasks) : undefined
        default:
            return undefined
    }
}

/** A refusal that asks to be tried later: the phase stays, the reason shows, nothing re-ticks. */
function refused(state: Autopilot, detail: string) {
    moveAutopilot(state, {...state, refused: true, detail})
}

async function pick(state: Autopilot, {openTask}: AutopilotDeps) {
    if ((await listPendingChanges()).length > 0) {
        haltAutopilot(state, 'loose-changes')
        return
    }
    const top = cardsIn(await listCards(), 'ready')[0]
    if (!top) {
        haltAutopilot(state, 'ready-empty')
        return
    }
    if (top.taskId !== null) {
        haltAutopilot(state, 'card-has-task')
        return
    }
    if (autopilotState() !== state) return
    let taskId: string | undefined
    try {
        taskId = (await postCardToGofer(top.id, false)).taskId
    } catch (error) {
        const failure = toCommandError(error)
        if (failure.retryable) refused(state, failure.message)
        else haltAutopilot(state, 'post-failed', failure.message)
        return
    }
    if (taskId === undefined) {
        haltAutopilot(state, 'post-failed', 'The post named no task.')
        return
    }
    const moved = moveAutopilot(state, {
        phase: 'opening',
        card: {id: top.id, number: top.number, taskId},
        send: {taskId, then: 'running'}
    })
    if (moved) openTask(taskId)
}

async function afterTurn(state: Autopilot, card: AutopilotCard) {
    if (state.ended === 'aborted') {
        haltAutopilot(state, 'turn-aborted')
        return
    }
    if (state.ended === 'error') {
        haltAutopilot(state, 'turn-failed')
        return
    }
    if (state.ended === 'lost') {
        haltAutopilot(state, 'turn-lost')
        return
    }
    if (state.phase === 'running') {
        const found = (await listCards()).find(one => one.id === card.id)
        if (!found) {
            haltAutopilot(state, 'card-gone')
            return
        }
        if (found.status !== 'review') {
            haltAutopilot(state, 'card-not-reviewed')
            return
        }
    }
    moveAutopilot(state, {phase: 'merging', card, ...(state.resolvedOnce && {resolvedOnce: true})})
}

async function merge(state: Autopilot, card: AutopilotCard, tasks: TaskActions) {
    const task = (await listTasks()).find(one => one.id === card.taskId)
    if (!task) {
        haltAutopilot(state, 'task-missing')
        return
    }
    if (autopilotState() !== state) return
    try {
        // No answer about unsaved scenes: the merge refuses when the editor holds any, and only
        // a person decides whether that work is saved or lost.
        await tasks.merge(task)
        moveAutopilot(state, {phase: 'picking'})
        return
    } catch (error) {
        const failure = toCommandError(error)
        if (failure.retryable) {
            refused(state, failure.message)
            return
        }
        if (failure.code === UNSAVED_WORK_CODE) {
            haltAutopilot(state, 'unsaved-scenes', failure.message)
            return
        }
        if (!isMergeClash(failure.code)) {
            haltAutopilot(state, 'merge-failed', failure.message)
            return
        }
        if (state.resolvedOnce) {
            haltAutopilot(state, 'merge-conflict-again', failure.message)
            return
        }
    }
    if (autopilotState() !== state) return
    let conflicts: readonly string[]
    try {
        conflicts = await tasks.resolveMerge(task)
    } catch (error) {
        haltAutopilot(state, 'merge-failed', toCommandError(error).message)
        return
    }
    if (conflicts.length === 0) {
        moveAutopilot(state, {phase: 'merging', card, resolvedOnce: true})
        return
    }
    moveAutopilot(state, {
        phase: 'opening',
        card,
        resolvedOnce: true,
        send: {taskId: card.taskId, text: conflictPrompt(conflicts), then: 'resolving'}
    })
}
