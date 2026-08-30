import {useEffect, useMemo, useSyncExternalStore} from 'react'
import {callGodotDebug} from '../services/godot-session'
import {createDebugSession} from '../services/debug-session'
import {isTauri} from '../services/desktop'
import {isDebugBusy, whileTheGameRuns} from '../models/debug-panel'
import type {DebugRequest, DebugResponse, DebugSourceBreakpoints} from '../models/godot'

type DebugSessionOptions = Readonly<{
    breakpoints: readonly DebugSourceBreakpoints[]
    isPlaying: boolean
    onError: (message: string) => void
}>

export type DebugSession = ReturnType<typeof useDebugSession>

export type {ScopeVariables} from '../models/debug-panel'

export function useDebugSession({breakpoints, isPlaying, onError}: DebugSessionOptions) {
    const session = useMemo(
        () =>
            createDebugSession({
                call: (input: DebugRequest): Promise<DebugResponse> =>
                    isTauri() ? callGodotDebug(input) : new Promise<DebugResponse>(() => undefined),
                onError
            }),
        [onError]
    )
    const panel = useSyncExternalStore(session.subscribe, session.state)

    useEffect(() => {
        session.setBreakpoints(breakpoints)
    }, [breakpoints, session])

    return useMemo(() => {
        const shown = whileTheGameRuns(panel, isPlaying)
        return {
            ...shown,
            isBusy: isDebugBusy(shown),
            launch: session.launch,
            pause: session.pause,
            resume: session.resume,
            selectFrame: session.selectFrame,
            terminate: session.terminate
        }
    }, [isPlaying, panel, session])
}
