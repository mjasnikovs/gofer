import {useCallback, useEffect, useState} from 'react'
import {invoke, isTauri, listen} from '../services/desktop'

type GodotProcessOptions = Readonly<{
    taskId?: string | undefined
    onError: (message: string) => void
    onStart: () => void
}>

/**
 * Tracks the managed Godot process and exposes run and stop actions.
 *
 * Run state follows the backend's `started` and `finished` events rather than the launch call, so
 * a process that exits on its own still clears the running flag.
 */
export function useGodotProcess({taskId, onError, onStart}: GodotProcessOptions) {
    const [isGodotRunning, setIsGodotRunning] = useState(false)

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let unlisten: (() => void) | undefined
        void listen('godot-process-event', event => {
            if (isCancelled) return
            if (event.payload.eventType === 'started') setIsGodotRunning(true)
            if (event.payload.eventType === 'finished') setIsGodotRunning(false)
            if (event.payload.level === 'error' && event.payload.message) {
                onError(`Godot: ${event.payload.message}`)
            }
        }).then(dispose => {
            if (isCancelled) {
                dispose()
                return
            }
            unlisten = dispose
        })
        return () => {
            isCancelled = true
            unlisten?.()
        }
    }, [onError])

    const runGodot = useCallback(() => {
        onStart()
        void invoke('launch_godot', {request: {taskId, editor: false}}).catch((error: unknown) => {
            setIsGodotRunning(false)
            onError(`Godot could not be launched: ${String(error)}`)
        })
    }, [onError, onStart, taskId])

    const stopGodot = useCallback(() => {
        void invoke('cancel_godot').catch((error: unknown) => {
            onError(`Godot could not be stopped: ${String(error)}`)
        })
    }, [onError])

    return {isGodotRunning, runGodot, stopGodot}
}
