import {afterEach, describe, expect, it} from 'vitest'
import {
    createManualScheduler,
    immediateScheduler,
    noInterval,
    repeat,
    schedule,
    setIntervalScheduler,
    setScheduler,
    timerInterval,
    timerScheduler,
    wait
} from './clock'

afterEach(() => {
    setScheduler(timerScheduler)
    setIntervalScheduler(timerInterval)
})

describe('immediateScheduler', () => {
    it('runs the work on the spot', () => {
        const done: string[] = []
        immediateScheduler(() => done.push('now'), 10_000)
        expect(done).toEqual(['now'])
    })

    it('hands back a cancel that does nothing', () => {
        const cancel = immediateScheduler(() => undefined, 0)
        expect(() => {
            cancel()
        }).not.toThrow()
    })
})

describe('createManualScheduler', () => {
    it('holds the work until it is asked to run', () => {
        const clock = createManualScheduler()
        const done: string[] = []
        clock.schedule(() => done.push('later'), 250)
        expect(done).toEqual([])
        expect(clock.pending).toBe(1)
        clock.run()
        expect(done).toEqual(['later'])
    })

    it('does not run work that was called off', () => {
        const clock = createManualScheduler()
        const done: string[] = []
        const cancel = clock.schedule(() => done.push('stale'), 250)
        clock.schedule(() => done.push('fresh'), 250)
        cancel()
        expect(clock.pending).toBe(1)
        clock.run()
        expect(done).toEqual(['fresh'])
    })

    it('runs work that the first run queued in turn', () => {
        const clock = createManualScheduler()
        const done: string[] = []
        clock.schedule(() => {
            done.push('first')
            clock.schedule(() => done.push('second'), 250)
        }, 250)
        clock.run()
        expect(done).toEqual(['first', 'second'])
    })
})

describe('the shared clock', () => {
    it('sends every delay through whichever clock was last set', () => {
        const clock = createManualScheduler()
        setScheduler(clock.schedule)
        const done: string[] = []
        schedule(() => done.push('queued'), 250)
        expect(done).toEqual([])
        clock.run()
        expect(done).toEqual(['queued'])
    })

    it('waits on the shared clock rather than on real time', async () => {
        setScheduler(immediateScheduler)
        await expect(wait(120_000)).resolves.toBeUndefined()
    })
})

describe('repeat', () => {
    it('never comes round on the clock a test runs on', () => {
        setIntervalScheduler(noInterval)
        const done: string[] = []
        const stop = repeat(() => done.push('poll'), 1000)
        stop()
        expect(done).toEqual([])
    })

    it('sends the poll through whichever interval clock was last set', () => {
        let running: (() => void) | undefined
        setIntervalScheduler(work => {
            running = work
            return () => {
                running = undefined
            }
        })
        const done: string[] = []
        const stop = repeat(() => done.push('poll'), 1000)
        running?.()
        running?.()
        expect(done).toEqual(['poll', 'poll'])
        stop()
        expect(running).toBeUndefined()
    })
})
