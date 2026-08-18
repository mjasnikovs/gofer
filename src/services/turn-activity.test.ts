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

    /*
     * The sidebar read the chat's flag alone, so it offered New task through a fifteen-minute plan
     * and the backend refused it by name. A brief holds the same single provider operation a chat
     * turn does; that is what makes it stoppable and what stops the checkout moving under it.
     */
    it('counts a brief, which is a turn the chat never sees', () => {
        setTurnRunning('brief', true)
        expect(isTurnRunning()).toBe(true)
    })

    // Two runs cannot really overlap — the backend allows one — but the readers must not care, and
    // one ending must not clear the other's fact.
    it('stays occupied until every run has ended', () => {
        setTurnRunning('chat', true)
        setTurnRunning('brief', true)
        setTurnRunning('chat', false)
        expect(isTurnRunning()).toBe(true)
        setTurnRunning('brief', false)
        expect(isTurnRunning()).toBe(false)
    })

    // A watcher woken for a change that did not happen re-renders the sidebar on every phase event.
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
