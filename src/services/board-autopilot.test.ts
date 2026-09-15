import {afterEach, describe, expect, it, vi} from 'vitest'
import {
    autopilotState,
    autopilotStatus,
    autopilotTurnEnded,
    clearAutopilot,
    setAutopilot,
    startAutopilot,
    stopAutopilot,
    takeAutopilotSend,
    watchAutopilot
} from './board-autopilot'

afterEach(clearAutopilot)

const CARD = {id: 'card-1', number: 12, taskId: 'task-1'}

describe('the auto mode store', () => {
    it('starts by picking and stops with the reason it was given', () => {
        startAutopilot()
        expect(autopilotState().phase).toBe('picking')
        stopAutopilot('ready-empty')
        expect(autopilotState()).toEqual({phase: 'off', stop: 'ready-empty'})
    })

    it('forgets the reason when the switch is turned on again', () => {
        stopAutopilot('turn-failed', 'the worker died')
        startAutopilot()
        expect(autopilotState()).toEqual({phase: 'picking'})
    })

    it('hands the send to the task it names, once, and moves on to what follows it', () => {
        setAutopilot({phase: 'opening', card: CARD, send: {taskId: 'task-1', then: 'running'}})
        expect(takeAutopilotSend('task-2')).toBeUndefined()
        expect(autopilotState().phase).toBe('opening')
        expect(takeAutopilotSend('task-1')).toEqual({taskId: 'task-1', then: 'running'})
        expect(autopilotState()).toEqual({phase: 'running', card: CARD})
        expect(takeAutopilotSend('task-1')).toBeUndefined()
    })

    it('records how the turn ended only for the card it is on, and only while it runs', () => {
        setAutopilot({phase: 'running', card: CARD})
        autopilotTurnEnded('task-2', 'complete')
        expect(autopilotState().ended).toBeUndefined()
        autopilotTurnEnded('task-1', 'aborted')
        expect(autopilotState().ended).toBe('aborted')

        setAutopilot({phase: 'opening', card: CARD, send: {taskId: 'task-1', then: 'running'}})
        autopilotTurnEnded('task-1', 'complete')
        expect(autopilotState().ended).toBeUndefined()
    })

    it('wakes its watchers on every change', () => {
        const notify = vi.fn()
        const stop = watchAutopilot(notify)
        startAutopilot()
        stopAutopilot()
        expect(notify).toHaveBeenCalledTimes(2)
        stop()
        startAutopilot()
        expect(notify).toHaveBeenCalledTimes(2)
    })

    it('says where it is in one line, and nothing while it has not run', () => {
        expect(autopilotStatus({phase: 'off'})).toBe('')
        expect(autopilotStatus({phase: 'picking'})).toBe('Auto: picking the next Ready card')
        expect(autopilotStatus({phase: 'running', card: CARD})).toBe('Auto: running card #12')
        expect(autopilotStatus({phase: 'off', stop: 'card-not-reviewed'})).toBe(
            'Auto stopped: the card was not moved to Review'
        )
    })
})
