import {useCallback, useEffect, useRef, useState} from 'react'
import {isTauri, listen} from '../services/desktop'
import type {DesktopEvent} from '../services/desktop'

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
    const identify = useRef(keyOf)
    useEffect(() => {
        identify.current = keyOf
    }, [keyOf])

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
                    (
                        previous.some(
                            prompt => identify.current(prompt) === identify.current(arriving)
                        )
                    ) ?
                        previous
                    :   [...previous, arriving]
                )
            })
        )
        track(
            listen(settledEvent, event => {
                if (isCancelled) return
                const key = settledKey(event.payload)
                if (key === undefined) return
                setQueue(previous => previous.filter(prompt => identify.current(prompt) !== key))
            })
        )
        return () => {
            isCancelled = true
            for (const dispose of disposers) dispose()
        }
    }, [requestEvent, settledEvent])

    const settle = useCallback((key: string) => {
        setQueue(previous => previous.filter(prompt => identify.current(prompt) !== key))
    }, [])

    return {queue, settle}
}

function settledKey(payload: unknown): string | undefined {
    if (typeof payload !== 'object' || payload === null) return undefined
    for (const [name, value] of Object.entries(payload)) {
        if (name.endsWith('Id') && typeof value === 'string') return value
    }
    return undefined
}
