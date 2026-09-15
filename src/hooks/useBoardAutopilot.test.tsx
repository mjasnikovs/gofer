import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render} from '@testing-library/react'
import {useBoardAutopilot} from './useBoardAutopilot'
import {
    autopilotState,
    autopilotTurnEnded,
    clearAutopilot,
    startAutopilot,
    takeAutopilotSend
} from '../services/board-autopilot'
import {createTaskActions} from '../services/task-actions'
import {clearTurnActivity, setTurnRunning} from '../services/turn-activity'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush, flushUntil} from '../test/flush'
import {CommandFailure, installBackend} from '../test/backend'
import {stopAutopilot} from '../services/board-autopilot'
import type {Backend, BackendAnswers} from '../test/backend'
import type {Card} from '../models/board'
import type {TurnEnding} from '../services/board-autopilot'

const tauri = createDesktopFake()

function card(overrides: Partial<Card> = {}): Card {
    return {
        id: 'card-1',
        number: 1,
        title: 'Make the hero jump higher',
        body: 'Twice the height.',
        owner: 'user',
        status: 'ready',
        taskId: null,
        commentCount: 0,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...overrides
    }
}

const SECOND = card({id: 'card-2', number: 2, title: 'Fix the ladder'})

let server: Backend
let boardChanged: (() => void) | undefined
const openTask = vi.fn()

function Driver() {
    useBoardAutopilot({
        tasks: createTaskActions({
            navigate: () => Promise.resolve(),
            refresh: () => Promise.resolve()
        }),
        openTask
    })
    return null
}

function start(rows: readonly Card[], answers: BackendAnswers = {}) {
    server = installBackend(tauri, {cards: rows, tasks: [], answers})
    tauri.listen.mockImplementation(async (name, handler) => {
        if (name === 'board-changed')
            boardChanged = () => {
                handler({payload: undefined as never})
            }
        return () => undefined
    })
    render(<Driver />)
    startAutopilot()
}

const calls = () => tauri.invoke.mock.calls.map(call => call[0])

function moveCard(id: string, status: Card['status']) {
    server.state.cards = server.state.cards.map(one => (one.id === id ? {...one, status} : one))
}

/** What the task's Workspace does first: takes what it was handed and runs the turn. */
async function runTurn(taskId: string) {
    await flushUntil(() => autopilotState().send?.taskId === taskId)
    const send = takeAutopilotSend(taskId)
    setTurnRunning('chat', true)
    await flush()
    setTurnRunning('chat', false)
    await flush()
    return send
}

/** What it does last: says how the turn ended. */
async function endTurn(taskId: string, ending: TurnEnding = 'complete') {
    autopilotTurnEnded(taskId, ending)
    await flush()
}

const stopped = () => autopilotState().phase === 'off'

beforeEach(() => {
    installDesktopFake(tauri)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    clearAutopilot()
    clearTurnActivity()
    tauri.invoke.mockReset()
    openTask.mockReset()
    boardChanged = undefined
})

describe('auto mode', () => {
    it('posts the top Ready card, opens its task, and hands the Workspace the ask', async () => {
        start([SECOND, card()])
        await flushUntil(() => autopilotState().phase === 'opening')

        expect(tauri.invoke).toHaveBeenCalledWith('card_post_to_gofer', {
            id: 'card-2',
            bringChanges: false
        })
        expect(openTask).toHaveBeenCalledWith('task-1')
        expect(autopilotState()).toEqual({
            phase: 'opening',
            card: {id: 'card-2', number: 2, taskId: 'task-1'},
            send: {taskId: 'task-1', then: 'running'}
        })
    })

    it('merges a card the model moved to Review, then takes the next one', async () => {
        start([card(), SECOND])
        await runTurn('task-1')
        moveCard('card-1', 'review')
        await endTurn('task-1')
        await flushUntil(() => autopilotState().send?.taskId === 'task-2')

        expect(tauri.invoke).toHaveBeenCalledWith('merge_task_branch', {taskId: 'task-1'})
        expect(calls().filter(command => command === 'card_post_to_gofer')).toHaveLength(2)
        expect(autopilotState().card?.id).toBe('card-2')
    })

    it('stops when Ready is empty', async () => {
        start([card({status: 'backlog'})])
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('ready-empty')
        expect(calls()).not.toContain('card_post_to_gofer')
    })

    it('stops on a top card that already has a task', async () => {
        start([card({taskId: 'task-9'})])
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('card-has-task')
    })

    it('stops on loose changes rather than banking them on the wrong branch', async () => {
        start([card()], {pending_project_changes: () => [{path: 'player.gd', isNew: false}]})
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('loose-changes')
        expect(calls()).not.toContain('card_post_to_gofer')
    })

    it('stops when the turn ends with the card still in Doing', async () => {
        start([card()])
        await runTurn('task-1')
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('card-not-reviewed')
        expect(calls()).not.toContain('merge_task_branch')
    })

    it('stops when the card is gone', async () => {
        start([card()])
        await runTurn('task-1')
        server.state.cards = []
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('card-gone')
    })

    it('stops on a stopped turn and on a failed one', async () => {
        start([card()])
        await runTurn('task-1')
        await endTurn('task-1', 'aborted')
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('turn-aborted')

        clearAutopilot()
        cleanup()
        tauri.invoke.mockReset()
        start([SECOND])
        await runTurn('task-1')
        await endTurn('task-1', 'error')
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('turn-failed')
    })

    it('hands one conflict to the model and merges after its turn', async () => {
        let merges = 0
        start([card()], {
            merge_task_branch: (_arguments, answer) => {
                merges += 1
                if (merges === 1) throw new CommandFailure('task_merge_conflicted', 'clash')
                return answer()
            },
            resolve_task_merge: () => ({taskId: 'task-1', conflicts: ['player.gd']})
        })
        await runTurn('task-1')
        moveCard('card-1', 'review')
        await endTurn('task-1')
        const send = await runTurn('task-1')

        expect(send?.then).toBe('resolving')
        expect(send?.text).toContain('- player.gd')
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(merges).toBe(2)
        expect(autopilotState().stop).toBe('ready-empty')
    })

    it('merges straight away when the resolution finds nothing to resolve', async () => {
        let merges = 0
        start([card()], {
            merge_task_branch: (_arguments, answer) => {
                merges += 1
                if (merges === 1) throw new CommandFailure('task_merge_conflicted', 'clash')
                return answer()
            }
        })
        await runTurn('task-1')
        moveCard('card-1', 'review')
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(merges).toBe(2)
        expect(autopilotState().stop).toBe('ready-empty')
    })

    it('stops when the merge still clashes after one resolution', async () => {
        start([card()], {
            merge_task_branch: () => {
                throw new CommandFailure('task_merge_unfinished', 'markers left')
            },
            resolve_task_merge: () => ({taskId: 'task-1', conflicts: ['player.gd']})
        })
        await runTurn('task-1')
        moveCard('card-1', 'review')
        await endTurn('task-1')
        await runTurn('task-1')
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(autopilotState()).toEqual({
            phase: 'off',
            stop: 'merge-conflict-again',
            detail: 'markers left'
        })
    })

    it('stops on any other merge failure, naming it', async () => {
        start([card()], {
            merge_task_branch: () => {
                throw new CommandFailure(
                    'godot_unsaved_scenes_unknown',
                    'the editor did not answer'
                )
            }
        })
        await runTurn('task-1')
        moveCard('card-1', 'review')
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('merge-failed')
        expect(autopilotState().detail).toBe('the editor did not answer')
    })

    it('stops when the task was deleted under it', async () => {
        start([card()])
        await runTurn('task-1')
        moveCard('card-1', 'review')
        server.state.tasks = []
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('task-missing')
    })

    it('waits out a retryable refusal and tries again when the board changes', async () => {
        let merges = 0
        start([card()], {
            merge_task_branch: (_arguments, answer) => {
                merges += 1
                if (merges > 1) return answer()
                const busy = new CommandFailure('ai_request_in_progress', 'busy')
                Object.assign(busy, {retryable: true})
                throw busy
            }
        })
        await runTurn('task-1')
        moveCard('card-1', 'review')
        await endTurn('task-1')
        await flushUntil(() => merges === 1)
        await flush()
        expect(autopilotState()).toMatchObject({phase: 'merging', refused: true, detail: 'busy'})

        boardChanged?.()
        await flushUntil(stopped)
        expect(merges).toBe(2)
        expect(autopilotState().stop).toBe('ready-empty')
    })

    it('does nothing while any turn is running', async () => {
        setTurnRunning('brief', true)
        start([card()])
        await flush()
        await flush()
        expect(calls()).not.toContain('card_post_to_gofer')

        setTurnRunning('brief', false)
        await flushUntil(() => autopilotState().phase === 'opening')
        expect(calls()).toContain('card_post_to_gofer')
    })

    it('stops when the editor holds unsaved scenes, rather than answering for the user', async () => {
        start([card()], {
            merge_task_branch: () => {
                throw new CommandFailure('godot_unsaved_scenes', 'level_1.tscn is unsaved')
            }
        })
        await runTurn('task-1')
        moveCard('card-1', 'review')
        await endTurn('task-1')
        await flushUntil(stopped)
        expect(autopilotState()).toEqual({
            phase: 'off',
            stop: 'unsaved-scenes',
            detail: 'level_1.tscn is unsaved'
        })
        expect(calls()).not.toContain('resolve_task_merge')
    })

    it('stops when the task was left while its turn ran', async () => {
        start([card()])
        await runTurn('task-1')
        await endTurn('task-1', 'lost')
        await flushUntil(stopped)
        expect(autopilotState().stop).toBe('turn-lost')
    })

    it('stays off when the switch is turned off while a step is away', async () => {
        let release: (() => void) | undefined
        start([card()], {
            card_post_to_gofer: (_arguments, answer) =>
                new Promise(resolve => {
                    release = () => {
                        resolve(answer())
                    }
                })
        })
        await flushUntil(() => release !== undefined)
        stopAutopilot()
        release?.()
        await flush()
        await flush()

        expect(autopilotState()).toEqual({phase: 'off'})
        expect(openTask).not.toHaveBeenCalled()
    })

    it('stops by name when the board cannot be read', async () => {
        start([card()], {
            board_list: () => {
                throw new CommandFailure('cards_unavailable', 'the project database is busy')
            }
        })
        await flushUntil(stopped)
        expect(autopilotState()).toEqual({
            phase: 'off',
            stop: 'read-failed',
            detail: 'the project database is busy'
        })
    })

    it('asks the task to open again while it waits to send', async () => {
        start([card()])
        await flushUntil(() => autopilotState().phase === 'opening')
        openTask.mockReset()
        boardChanged?.()
        await flush()
        expect(openTask).toHaveBeenCalledWith('task-1')
    })
})
