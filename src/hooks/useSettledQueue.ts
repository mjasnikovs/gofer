import {useCallback, useEffect, useState} from 'react'
import {isTauri, listen} from '../services/desktop'
import type {DesktopEvent} from '../services/desktop'

/**
 * A queue of things the backend is blocked on, kept in arrival order.
 *
 * Two surfaces need exactly this and for the same reason: an approval and a question are both a
 * paused backend. Something over there is holding a thread open until this side answers, and there
 * are three ways that can stop — the user answers, it times out, or the run it belonged to ends.
 * Only the first of those goes through this side at all, which is the whole reason the queue follows
 * a *settled* event rather than the answers sent from here. A dialog that closed only when it was
 * answered would sit on screen over a decision nobody is waiting for.
 *
 * Generic over the prompt, keyed by whatever identifies one. Both events carry that key, and the
 * request event is deduplicated on it: the backend may re-announce a prompt, and a second card for
 * one decision is a card the user can answer twice.
 */
export function useSettledQueue<T>({
    requestEvent,
    settledEvent,
    keyOf
}: Readonly<{
    requestEvent: DesktopEvent
    settledEvent: DesktopEvent
    keyOf: (prompt: T) => string
}>) {
    const [queue, setQueue] = useState<readonly T[]>([])

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        const disposers: (() => void)[] = []
        const track = (pending: Promise<() => void>) => {
            void pending.then(dispose => {
                if (isCancelled) dispose()
                else disposers.push(dispose)
            })
        }
        track(
            listen(requestEvent, event => {
                if (isCancelled) return
                const arriving = event.payload as T
                setQueue(previous =>
                    previous.some(prompt => keyOf(prompt) === keyOf(arriving)) ? previous : (
                        [...previous, arriving]
                    )
                )
            })
        )
        track(
            listen(settledEvent, event => {
                if (isCancelled) return
                const key = settledKey(event.payload)
                if (key === undefined) return
                setQueue(previous => previous.filter(prompt => keyOf(prompt) !== key))
            })
        )
        return () => {
            isCancelled = true
            for (const dispose of disposers) dispose()
        }
    }, [requestEvent, settledEvent, keyOf])

    /**
     * Drops one prompt without waiting for its settled event.
     *
     * Called the moment an answer is sent, because the backend resumes as soon as it has one and the
     * card must not outlive that. The settled event still arrives and finds nothing to remove, which
     * is the correct outcome rather than a race.
     */
    const settle = useCallback((key: string) => {
        setQueue(previous => previous.filter(prompt => keyOf(prompt) !== key))
        // `keyOf` is read through the closure rather than listed, so answering never re-subscribes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return {queue, settle}
}

/**
 * The identifier a settled event carries, whatever it calls it.
 *
 * The two settled events name their key after their own surface — `approvalId`, `questionId` — and
 * neither is going to be renamed to suit this. Reading whichever string-valued `*Id` field is present
 * keeps the queue generic without asking the backend to speak a shape it has no other reason to.
 */
function settledKey(payload: unknown): string | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined
    for (const [name, value] of Object.entries(payload)) {
        if (name.endsWith('Id') && typeof value === 'string') return value
    }
    return undefined
}
