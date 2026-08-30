import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {judgeProjectMemory, sweepProjectMemory} from './project-memory'
import {clearTurnActivity, isTurnRunning} from './turn-activity'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'

const tauri = createDesktopFake()

let backend: (...call: unknown[]) => Promise<unknown>

beforeEach(() => {
    installDesktopFake(tauri)
    tauri.invoke.mockImplementation((command, arguments_) => backend(command, arguments_))
})

afterEach(() => {
    clearTurnActivity()
    removeDesktopFake()
})

function heldCall() {
    let answer: (value: unknown) => void = () => undefined
    const held = new Promise(resolve => {
        answer = resolve
    })
    backend = () => held
    return answer
}

describe('a memory run is a turn, and the window has to know', () => {
    it('marks the window busy for the whole of a sweep', async () => {
        const answer = heldCall()
        const sweeping = sweepProjectMemory({requestId: 1, memoryIds: ['memory-1', 'memory-2']})

        await vi.waitFor(() => {
            expect(isTurnRunning()).toBe(true)
        })
        answer([])
        await sweeping
        expect(isTurnRunning()).toBe(false)
    })

    it('marks the window busy for one judged row too', async () => {
        const answer = heldCall()
        const judging = judgeProjectMemory({requestId: 2, memoryId: 'memory-1'})

        await vi.waitFor(() => {
            expect(isTurnRunning()).toBe(true)
        })
        answer({id: 'memory-1'})
        await judging
        expect(isTurnRunning()).toBe(false)
    })

    it('lets go when the run fails', async () => {
        backend = () => Promise.reject(new Error('the sub-agent could not start'))

        await expect(sweepProjectMemory({requestId: 3, memoryIds: ['memory-1']})).rejects.toThrow()
        expect(isTurnRunning()).toBe(false)
    })
})
