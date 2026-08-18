import {useEffect, useMemo, useSyncExternalStore} from 'react'
import {callGodotDebug} from '../services/godot-session'
import {createDebugSession} from '../services/debug-session'
import {isTauri} from '../services/desktop'
import {isDebugBusy, whileTheGameRuns} from '../models/debug-panel'
import type {DebugRequest, DebugResponse, DebugSourceBreakpoints} from '../models/godot'

type DebugSessionOptions = Readonly<{
    /** The breakpoints Monaco's gutter holds, installed with the launch and kept in step after it. */
    breakpoints: readonly DebugSourceBreakpoints[]
    /**
     * Whether the editor is playing the project, as Godot itself reports it.
     *
     * Everything the session holds describes a running game, and the adapter does not always say
     * when one ends. This is what retires the reading instead.
     */
    isPlaying: boolean
    /** Where a failed debugger request is reported. See `DebugDependencies`. */
    onError: (message: string) => void
}>

/**
 * The debugger, as the frame shares it. One instance is owned by `InspectorWorkspace` so the Run
 * control and the debugger panel drive the same session rather than two adapters' worth of state.
 */
export type DebugSession = ReturnType<typeof useDebugSession>

export type {ScopeVariables} from '../models/debug-panel'

/**
 * A debugging session, wired to React.
 *
 * The sequence is `services/debug-session.ts` — the same arrangement `services/turn.ts` has, and
 * for the same reason: the steps are only correct in order, and an order held in refs inside a
 * hook can only be tested by mounting the whole IDE. What is left here is the part that is
 * genuinely React's: subscribing, and retiring a reading of a game that Godot says has stopped.
 */
export function useDebugSession({breakpoints, isPlaying, onError}: DebugSessionOptions) {
    const session = useMemo(
        () =>
            createDebugSession({
                // Outside Tauri there is no adapter to ask. Answering rather than throwing keeps a
                // browser-mounted frame drawing its controls instead of a column of failures.
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
        // Derived on the way out rather than dispatched on a change: there is no render in which
        // the panel still shows a game that has already gone.
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
