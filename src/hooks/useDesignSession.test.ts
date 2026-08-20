import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, renderHook} from '@testing-library/react'
import {useDesignSession} from './useDesignSession'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'
import type {UserQuestionPrompt} from '../models/brief'

const tauri = createDesktopFake()

/** What the backend would send, delivered to whoever subscribed to that event. */
const handlers = new Map<string, (payload: unknown) => void>()

const send = (name: string, payload: unknown) => {
    act(() => {
        handlers.get(name)?.(payload)
    })
}

beforeEach(() => {
    tauri.invoke.mockReset()
    tauri.listen.mockReset()
    handlers.clear()
    installDesktopFake(tauri)
    tauri.listen.mockImplementation(async (name, handler) => {
        handlers.set(name, payload => {
            handler({event: name, id: 1, payload} as never)
        })
        return () => handlers.delete(name)
    })
})

afterEach(() => {
    removeDesktopFake()
    vi.restoreAllMocks()
})

const round = (over: Partial<UserQuestionPrompt> = {}): UserQuestionPrompt => ({
    questionId: 'q-1',
    question: 'Where does the health bar sit?',
    options: [],
    sketches: [{label: 'Bar across the top', html: '<p>a</p>'}],
    why: '',
    revision: 1,
    designSession: 'design-1',
    ...over
})

const mount = (questions: readonly UserQuestionPrompt[] = [], isTurnRunning = true) =>
    renderHook(props => useDesignSession(props), {
        initialProps: {questions, isTurnRunning}
    })

/*
 * The card between a design loop's two edges.
 *
 * `useSettledQueue` drops a prompt the moment it is answered, which is right — nobody is waiting on
 * it any more. What was wrong was the card following it out and coming back a minute later looking
 * like a new question.
 */
describe('holding one design loop on screen', () => {
    it('shows the question that is waiting', async () => {
        const view = mount([round()])
        await flush()
        send('ai-design-opened', {sessionId: 'design-1'})

        expect(view.result.current.prompt?.questionId).toBe('q-1')
        expect(view.result.current.isRedrawing).toBe(false)
    })

    /** The round is answered, the next drawing does not exist yet, and the card stays put. */
    it('keeps the card while the agent redraws', async () => {
        const view = mount([round()])
        await flush()
        send('ai-design-opened', {sessionId: 'design-1'})

        view.rerender({questions: [], isTurnRunning: true})

        expect(view.result.current.prompt?.questionId).toBe('q-1')
        expect(view.result.current.isRedrawing).toBe(true)
    })

    it('lets go when the loop says it is finished', async () => {
        const view = mount([round()])
        await flush()
        send('ai-design-opened', {sessionId: 'design-1'})
        view.rerender({questions: [], isTurnRunning: true})

        send('ai-design-closed', {sessionId: 'design-1'})

        expect(view.result.current.prompt).toBeUndefined()
        expect(view.result.current.isRedrawing).toBe(false)
    })

    /*
     * The net under a close that never arrives.
     *
     * A cancelled turn rejects every call back to Rust, including the one the design tool sends
     * while unwinding — so the moment the close matters most is the moment it cannot be sent.
     */
    it('lets go when the turn stops, however the loop ended', async () => {
        const view = mount([round()])
        await flush()
        send('ai-design-opened', {sessionId: 'design-1'})
        view.rerender({questions: [], isTurnRunning: true})

        view.rerender({questions: [], isTurnRunning: false})

        expect(view.result.current.prompt).toBeUndefined()
    })

    /** An ordinary question is unchanged: answered, gone, and no card left behind. */
    it('holds nothing for a question that belongs to no loop', async () => {
        const {designSession: _loop, ...plain} = round()
        const view = mount([plain])
        await flush()

        expect(view.result.current.prompt?.questionId).toBe('q-1')

        view.rerender({questions: [], isTurnRunning: true})

        expect(view.result.current.prompt).toBeUndefined()
        expect(view.result.current.isRedrawing).toBe(false)
    })

    /*
     * A design question can arrive with no turn behind it, and it must draw rather than crash.
     *
     * Remembering the prompt on one rule and dropping it on another that is true at the same moment
     * is a render that sets state, re-renders, unsets it, and never stops. React ends that with
     * "Too many re-renders", which takes the whole window down over a card.
     */
    it('draws a design question with no loop behind it rather than looping', async () => {
        const view = mount([round()], false)
        await flush()

        expect(view.result.current.prompt?.questionId).toBe('q-1')
        expect(view.result.current.isRedrawing).toBe(false)
    })

    /*
     * Two designs at once, which the agent can start because it dispatches its tool calls in
     * parallel.
     *
     * Remembered as one identifier, the second loop to open took the card and the first one's rounds
     * stopped holding — so the older design went back to flickering the moment a newer one began.
     */
    it('holds a round of either loop when two are open', async () => {
        const view = mount([], true)
        await flush()
        send('ai-design-opened', {sessionId: 'design-1'})
        send('ai-design-opened', {sessionId: 'design-2'})

        // A round of the loop that opened FIRST, which is the one a single identifier forgot.
        view.rerender({questions: [round()], isTurnRunning: true})
        view.rerender({questions: [], isTurnRunning: true})
        expect(view.result.current.isRedrawing).toBe(true)
        expect(view.result.current.prompt?.designSession).toBe('design-1')

        // And a round of the second, held under its own identifier rather than replacing the first.
        view.rerender({
            questions: [round({questionId: 'q-2', designSession: 'design-2'})],
            isTurnRunning: true
        })
        view.rerender({questions: [], isTurnRunning: true})
        expect(view.result.current.prompt?.questionId).toBe('q-2')
    })

    /** Closing one loop leaves the other alone: they end at different times and always will. */
    it('closing one loop does not take down the other', async () => {
        const view = mount([], true)
        await flush()
        send('ai-design-opened', {sessionId: 'design-1'})
        send('ai-design-opened', {sessionId: 'design-2'})
        view.rerender({questions: [round()], isTurnRunning: true})
        view.rerender({questions: [], isTurnRunning: true})

        send('ai-design-closed', {sessionId: 'design-2'})

        expect(view.result.current.isRedrawing).toBe(true)
        expect(view.result.current.prompt?.designSession).toBe('design-1')
    })

    /** A close arriving late from a finished loop must not take down the card of the current one. */
    it('ignores a close belonging to a different loop', async () => {
        const view = mount([round()])
        await flush()
        send('ai-design-opened', {sessionId: 'design-1'})
        view.rerender({questions: [], isTurnRunning: true})

        send('ai-design-closed', {sessionId: 'design-0'})

        expect(view.result.current.isRedrawing).toBe(true)
    })
})
