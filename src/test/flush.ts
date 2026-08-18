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
