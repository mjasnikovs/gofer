export type WriteScheduler = (work: () => void, delayMs: number) => () => void

export const timerScheduler: WriteScheduler = (work, delayMs) => {
    const timer = setTimeout(work, delayMs)
    return () => {
        clearTimeout(timer)
    }
}

export const immediateScheduler: WriteScheduler = work => {
    work()
    return () => undefined
}

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
        get pending() {
            return queued.filter(entry => !entry.isCancelled).length
        },
        run() {
            while (queued.length > 0) {
                const entry = queued.shift()
                if (entry && !entry.isCancelled) entry.work()
            }
        }
    }
}

let current: WriteScheduler = timerScheduler

export const schedule: WriteScheduler = (work, delayMs) => current(work, delayMs)

export function setScheduler(next: WriteScheduler) {
    current = next
}

export function wait(delayMs: number): Promise<void> {
    return new Promise(resolve => {
        schedule(() => {
            resolve()
        }, delayMs)
    })
}

export type IntervalScheduler = (work: () => void, everyMs: number) => () => void

export const timerInterval: IntervalScheduler = (work, everyMs) => {
    const timer = setInterval(work, everyMs)
    return () => {
        clearInterval(timer)
    }
}

export const noInterval: IntervalScheduler = () => () => undefined

let currentInterval: IntervalScheduler = timerInterval

export const repeat: IntervalScheduler = (work, everyMs) => currentInterval(work, everyMs)

export function setIntervalScheduler(next: IntervalScheduler) {
    currentInterval = next
}

export function defer(work: () => void): () => void {
    return timerScheduler(work, 0)
}
