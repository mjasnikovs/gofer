import {afterEach, describe, expect, it, vi} from 'vitest'
import {
    clearTurnActivity,
    isTurnRunning,
    setTurnRunning,
    watchTurn
} from '../services/turn-activity'

afterEach(clearTurnActivity)

describe('whether the agent is occupied', () => {
    it('is nobody’s business how, only whether', () => {
        setTurnRunning('chat', true)
        expect(isTurnRunning()).toBe(true)
        setTurnRunning('chat', false)
        expect(isTurnRunning()).toBe(false)
    })

    it('counts a brief, which is a turn the chat never sees', () => {
        setTurnRunning('brief', true)
        expect(isTurnRunning()).toBe(true)
    })

    it('counts a memory run, which no conversation is watching', () => {
        setTurnRunning('memory', true)
        expect(isTurnRunning()).toBe(true)
    })

    it('stays occupied until every run has ended', () => {
        setTurnRunning('chat', true)
        setTurnRunning('brief', true)
        setTurnRunning('chat', false)
        expect(isTurnRunning()).toBe(true)
        setTurnRunning('brief', false)
        expect(isTurnRunning()).toBe(false)
    })

    it('wakes its watchers only when the answer changes', () => {
        const notify = vi.fn()
        const stop = watchTurn(notify)

        setTurnRunning('chat', true)
        expect(notify).toHaveBeenCalledTimes(1)
        setTurnRunning('brief', true)
        expect(notify).toHaveBeenCalledTimes(1)
        setTurnRunning('brief', false)
        expect(notify).toHaveBeenCalledTimes(1)
        setTurnRunning('chat', false)
        expect(notify).toHaveBeenCalledTimes(2)

        stop()
        setTurnRunning('chat', true)
        expect(notify).toHaveBeenCalledTimes(2)
    })
})
