import {act} from '@testing-library/react'

export async function flush() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
    })
}

export async function flushUntil(isSettled: () => boolean, attempts = 50): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (isSettled()) return
        await flush()
    }
    if (isSettled()) return
    throw new Error(`Nothing settled in ${String(attempts)} flushes`)
}
