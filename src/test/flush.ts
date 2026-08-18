import {act} from '@testing-library/react'

/**
 * Lets React finish: every pending effect, and every promise already settled behind it.
 *
 * This is what replaced `waitFor` almost everywhere. `waitFor` polls a 1000 ms budget every 50 ms
 * and returns on the first poll that passes, so it pays wall-clock time for something the test can
 * already know, scores "was briefly true" as "is true", and fails on a loaded machine for reasons
 * that have nothing to do with the code. With the backend answering from a fake and the debounce
 * clock swapped out, there is nothing left to wait *for* — only work to let finish.
 *
 * `waitFor` still belongs where something genuinely external is being awaited. Nothing here is.
 */
export async function flush() {
    await act(async () => {
        // A macrotask, not a delay: yielding to the task queue once drains every microtask behind
        // it, however deep the promise chain. Awaiting a fixed number of `Promise.resolve()` turns
        // instead would make the test depend on how many `await`s the code happens to have.
        await new Promise(resolve => setTimeout(resolve, 0))
    })
}

/**
 * Flushes until something is true, without ever asking the clock.
 *
 * The other half of the note above. `flush` is one macrotask, and one is not always enough: a click
 * whose handler starts a read, whose answer starts a subscription, is three links deep and needs
 * three. `waitFor` is the usual answer to that and is the wrong one here — it spends a 1000 ms
 * budget it measures in wall-clock time, so it fails on a loaded machine for reasons that have
 * nothing to do with the code, which is exactly the flake it was reached for to fix.
 *
 * This waits on the same thing without a deadline. Every attempt is one macrotask, so a chain of
 * any depth settles in as many attempts as it has links, however busy the machine is — a loaded CPU
 * makes each attempt later, not fewer. The ceiling is only there so a condition that will never
 * hold fails as a test rather than as a hang.
 */
export async function flushUntil(isSettled: () => boolean, attempts = 50): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (isSettled()) return
        await flush()
    }
    if (isSettled()) return
    throw new Error(`Nothing settled in ${String(attempts)} flushes`)
}
