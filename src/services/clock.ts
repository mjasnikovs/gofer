/**
 * The one clock the application's delays run on.
 *
 * Every debounce, every poll and every deferral in Gofer asks this module for its timing rather
 * than calling `setTimeout` itself. The reason is what it costs not to: a module that creates its
 * own timer can only be tested by waiting for it, the wait is real seconds on a machine that may
 * be busy compiling Godot, and the cost is invisible in the test's own source. One swappable clock
 * turns "wait 250 ms and hope" into "the write happened".
 */

/** Runs `work` once the delay has passed, and hands back a way to call it off. */
export type WriteScheduler = (work: () => void, delayMs: number) => () => void

/** The real clock. What the application runs on. */
export const timerScheduler: WriteScheduler = (work, delayMs) => {
    const timer = setTimeout(work, delayMs)
    return () => {
        clearTimeout(timer)
    }
}

/**
 * No clock at all: the work happens on the spot.
 *
 * Coalescing is a debounce's only job, and dropping it costs a test nothing — the assertion is
 * that the right value arrived, never that it arrived once.
 */
export const immediateScheduler: WriteScheduler = work => {
    work()
    return () => undefined
}

/** No clock that ever fires: nothing deferred happens until the test asks for it. */
export function createManualScheduler() {
    const queued: {work: () => void; delayMs: number; isCancelled: boolean}[] = []
    const schedule: WriteScheduler = (work, delayMs) => {
        const entry = {work, delayMs, isCancelled: false}
        queued.push(entry)
        return () => {
            entry.isCancelled = true
        }
    }
    return {
        schedule,
        /** How many delays are outstanding, which is what a debounce is for. */
        get pending() {
            return queued.filter(entry => !entry.isCancelled).length
        },
        /** Runs everything waiting, including anything those runs queue in turn. */
        run() {
            while (queued.length > 0) {
                const entry = queued.shift()
                if (entry && !entry.isCancelled) entry.work()
            }
        }
    }
}

let current: WriteScheduler = timerScheduler

/** Asks the current clock for a delay. Every module in the application goes through this. */
export const schedule: WriteScheduler = (work, delayMs) => current(work, delayMs)

/**
 * Swaps the clock the whole application runs on.
 *
 * Tests call this once in their setup; the application never calls it at all.
 */
export function setScheduler(next: WriteScheduler) {
    current = next
}

/** Waits out a delay on the shared clock, for the retry loops that cannot be written as effects. */
export function wait(delayMs: number): Promise<void> {
    return new Promise(resolve => {
        schedule(() => {
            resolve()
        }, delayMs)
    })
}

/**
 * Repeating is its own kind of clock, not a debounce that happens twice.
 *
 * They are kept apart because the useful test setting differs: a debounce wants to fire at once,
 * and a poll wants never to fire on its own — a test that asks for the second page should say so
 * rather than race the first one.
 */
export type IntervalScheduler = (work: () => void, everyMs: number) => () => void

/** The real clock. What the application runs on. */
export const timerInterval: IntervalScheduler = (work, everyMs) => {
    const timer = setInterval(work, everyMs)
    return () => {
        clearInterval(timer)
    }
}

/** A poll that never comes round again. What a test runs on unless it says otherwise. */
export const noInterval: IntervalScheduler = () => () => undefined

let currentInterval: IntervalScheduler = timerInterval

/** Asks the current clock to run `work` over and over, and hands back a way to stop it. */
export const repeat: IntervalScheduler = (work, everyMs) => currentInterval(work, everyMs)

export function setIntervalScheduler(next: IntervalScheduler) {
    currentInterval = next
}

/**
 * Runs `work` after the browser has finished with the current render, and hands back a cancel.
 *
 * Deliberately on the real clock rather than the swappable one. This is not a delay anybody is
 * waiting out — it is ordering, and the two callers rely on the cancel to collapse a mount and its
 * StrictMode double into one call. A scheduler that fires on the spot would defeat exactly that.
 */
export function defer(work: () => void): () => void {
    return timerScheduler(work, 0)
}
