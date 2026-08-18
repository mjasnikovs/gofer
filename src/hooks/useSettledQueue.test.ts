import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, renderHook} from '@testing-library/react'
import {useSettledQueue} from './useSettledQueue'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'

const tauri = createDesktopFake()

interface Prompt {
    approvalId: string
}

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

const mount = () =>
    renderHook(() =>
        useSettledQueue<Prompt>({
            requestEvent: 'ai-approval-request',
            settledEvent: 'ai-approval-settled',
            keyOf: prompt => prompt.approvalId
        })
    )

describe('a queue of things the backend is blocked on', () => {
    it('keeps them in the order they arrived', async () => {
        const view = mount()
        await flush()

        send('ai-approval-request', {approvalId: 'a-1'})
        send('ai-approval-request', {approvalId: 'a-2'})

        expect(view.result.current.queue.map(prompt => prompt.approvalId)).toEqual(['a-1', 'a-2'])
    })

    // The backend may re-announce a prompt. A second card for one decision is a card the user can
    // answer twice.
    it('shows one prompt once, however many times it is announced', async () => {
        const view = mount()
        await flush()

        send('ai-approval-request', {approvalId: 'a-1'})
        send('ai-approval-request', {approvalId: 'a-1'})

        expect(view.result.current.queue).toHaveLength(1)
    })

    /*
     * The whole reason the queue follows a settled event rather than the answers sent from here.
     *
     * Three things stop a prompt and only one of them goes through this side: the user answers, it
     * times out, or the run it belonged to ends. A dialog that closed only when it was answered
     * would sit on screen over a decision nobody is waiting for.
     */
    it('drops a prompt that settled without this side answering it', async () => {
        const view = mount()
        await flush()

        send('ai-approval-request', {approvalId: 'a-1'})
        send('ai-approval-settled', {approvalId: 'a-1', approved: false})

        expect(view.result.current.queue).toHaveLength(0)
    })

    // Each surface names its key after itself, and neither is going to be renamed to suit a queue.
    it('reads whichever identifier the settled event carries', async () => {
        const view = renderHook(() =>
            useSettledQueue<{questionId: string}>({
                requestEvent: 'ai-question-request',
                settledEvent: 'ai-question-settled',
                keyOf: prompt => prompt.questionId
            })
        )
        await flush()

        send('ai-question-request', {questionId: 'q-1'})
        expect(view.result.current.queue).toHaveLength(1)

        send('ai-question-settled', {questionId: 'q-1', answered: true})
        expect(view.result.current.queue).toHaveLength(0)
    })

    // Answering resumes the backend at once, so the card must not wait for the settled event that
    // follows. The event still arrives and finds nothing to remove, which is correct.
    it('drops a prompt the moment it is settled from here', async () => {
        const view = mount()
        await flush()

        send('ai-approval-request', {approvalId: 'a-1'})
        send('ai-approval-request', {approvalId: 'a-2'})
        act(() => {
            view.result.current.settle('a-1')
        })

        expect(view.result.current.queue.map(prompt => prompt.approvalId)).toEqual(['a-2'])

        send('ai-approval-settled', {approvalId: 'a-1', approved: true})
        expect(view.result.current.queue.map(prompt => prompt.approvalId)).toEqual(['a-2'])
    })

    it('ignores a settled event that names nothing', async () => {
        const view = mount()
        await flush()

        send('ai-approval-request', {approvalId: 'a-1'})
        send('ai-approval-settled', {approved: true})
        send('ai-approval-settled', null)

        expect(view.result.current.queue).toHaveLength(1)
    })
})
