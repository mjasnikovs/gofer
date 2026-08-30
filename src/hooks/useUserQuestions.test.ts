import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, renderHook} from '@testing-library/react'
import {useUserQuestions} from './useUserQuestions'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import {flush} from '../test/flush'

const tauri = createDesktopFake()

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
    tauri.invoke.mockResolvedValue(undefined)
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

const mount = () => {
    const onError = vi.fn<(message: string) => void>()
    const view = renderHook(() => useUserQuestions({onError}))
    return {onError, view}
}

const ask = () => {
    send('ai-question-request', {
        questionId: 'q-1',
        question: 'Where does the menu live?',
        options: ['its own scene'],
        sketches: [],
        why: '',
        revision: 1
    })
}

describe('the questions the agent is waiting on', () => {
    it('queues what arrives', async () => {
        const {view} = mount()
        await flush()

        ask()
        expect(view.result.current.questions).toHaveLength(1)
        expect(view.result.current.questions[0]?.question).toBe('Where does the menu live?')
    })

    it('sends what the user wrote', async () => {
        const {view} = mount()
        await flush()
        ask()

        act(() => {
            view.result.current.answer({questionId: 'q-1', answer: 'its own scene'})
        })

        expect(tauri.invoke).toHaveBeenCalledWith('respond_user_question', {
            request: {questionId: 'q-1', answer: 'its own scene'}
        })
        expect(view.result.current.questions).toHaveLength(0)
    })

    it('sends a skip as a skip', async () => {
        const {view} = mount()
        await flush()
        ask()

        act(() => {
            view.result.current.answer({questionId: 'q-1', skipped: true})
        })

        expect(tauri.invoke).toHaveBeenCalledWith('respond_user_question', {
            request: {questionId: 'q-1', skipped: true}
        })
    })

    it('reports an answer the backend would not take', async () => {
        tauri.invoke.mockRejectedValue(new Error('nothing is waiting for that question'))
        const {view, onError} = mount()
        await flush()
        ask()

        act(() => {
            view.result.current.answer({questionId: 'q-1', answer: 'anything'})
        })
        await flush()

        expect(onError).toHaveBeenCalledWith(expect.stringContaining('nothing is waiting'))
    })
})
