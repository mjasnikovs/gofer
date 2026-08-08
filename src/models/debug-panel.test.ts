import {describe, expect, it} from 'vitest'
import {INITIAL_DEBUG_PANEL, isDebugBusy, reduceDebug} from './debug-panel'
import type {DebugAction, DebugPanel, ScopeVariables} from './debug-panel'
import type {DebugStackFrame, DebugStopped} from './godot'

/** Applies a run of actions in order, which is the only way the panel ever reaches a state. */
function apply(...actions: readonly DebugAction[]): DebugPanel {
    return actions.reduce(reduceDebug, INITIAL_DEBUG_PANEL)
}

const STOP: DebugStopped = {reason: 'breakpoint', threadId: 1, allThreadsStopped: true}

const FRAMES: readonly DebugStackFrame[] = [
    {id: 1, name: '_physics_process', path: 'player.gd', line: 12, column: 1},
    {id: 2, name: '_ready', path: 'main.gd', line: 4, column: 1}
]

const SCOPES: readonly ScopeVariables[] = [
    {
        scope: {name: 'Locals', variablesReference: 7, expensive: false},
        variables: [{name: 'speed', value: '2.0', type: 'float', variablesReference: 0}]
    }
]

const running = apply({type: 'launched'}, {type: 'stopped', stop: STOP})

describe('launching', () => {
    it('starts with nothing launched, nothing stopped and nothing running', () => {
        expect(INITIAL_DEBUG_PANEL.isLaunched).toBe(false)
        expect(INITIAL_DEBUG_PANEL.stopped).toBeUndefined()
        expect(isDebugBusy(INITIAL_DEBUG_PANEL)).toBe(false)
    })

    /** A relaunch must not open on the frames of the run before it. */
    it('clears the previous run when a new one launches', () => {
        const relaunched = apply(
            {type: 'launched'},
            {type: 'stopped', stop: STOP},
            {type: 'stack-read', frames: FRAMES},
            {type: 'scopes-read', scopes: SCOPES},
            {type: 'launched'}
        )
        expect(relaunched.isLaunched).toBe(true)
        expect(relaunched.stopped).toBeUndefined()
        expect(relaunched.frames).toEqual([])
        expect(relaunched.scopes).toEqual([])
    })
})

describe('stopping', () => {
    it('selects the top frame with the stack it came in', () => {
        const stacked = reduceDebug(running, {type: 'stack-read', frames: FRAMES})
        expect(stacked.frames).toEqual(FRAMES)
        expect(stacked.frameId).toBe(1)
    })

    /** Variables belonging to no frame are worse than none: they read as the current ones. */
    it('drops the scopes when the stack comes back empty', () => {
        const stacked = apply(
            {type: 'launched'},
            {type: 'stopped', stop: STOP},
            {type: 'stack-read', frames: FRAMES},
            {type: 'scopes-read', scopes: SCOPES},
            {type: 'stack-read', frames: []}
        )
        expect(stacked.frameId).toBeUndefined()
        expect(stacked.scopes).toEqual([])
    })

    it('keeps the scopes on screen while another frame is being read', () => {
        const stacked = apply(
            {type: 'launched'},
            {type: 'stopped', stop: STOP},
            {type: 'stack-read', frames: FRAMES},
            {type: 'scopes-read', scopes: SCOPES},
            {type: 'frame-chosen', frameId: 2}
        )
        expect(stacked.frameId).toBe(2)
        expect(stacked.scopes).toEqual(SCOPES)
    })
})

describe('resuming', () => {
    /*
     * The whole point of the machine. Frames read at the last stop describe a game that is running
     * again, and leaving them up says the debugger is stopped somewhere it is not.
     */
    it('forgets the stop, the stack and the scopes when the game runs on', () => {
        const resumed = apply(
            {type: 'launched'},
            {type: 'stopped', stop: STOP},
            {type: 'stack-read', frames: FRAMES},
            {type: 'scopes-read', scopes: SCOPES},
            {type: 'resuming'}
        )
        expect(resumed.stopped).toBeUndefined()
        expect(resumed.frames).toEqual([])
        expect(resumed.frameId).toBeUndefined()
        expect(resumed.scopes).toEqual([])
        // Still launched: the game is running, not gone.
        expect(resumed.isLaunched).toBe(true)
    })

    it('ends the session when the debuggee is gone', () => {
        const finished = apply(
            {type: 'launched'},
            {type: 'stopped', stop: STOP},
            {type: 'stack-read', frames: FRAMES},
            {type: 'finished'}
        )
        expect(finished.isLaunched).toBe(false)
        expect(finished.stopped).toBeUndefined()
        expect(finished.frames).toEqual([])
    })
})

describe('what the user is waiting on', () => {
    /*
     * Reading a frame issues one request per scope. A flag would come back to life between them
     * and let a second click through mid-read.
     */
    it('stays busy until every overlapping request has answered', () => {
        const two = apply({type: 'began'}, {type: 'began'}, {type: 'ended'})
        expect(isDebugBusy(two)).toBe(true)
        expect(isDebugBusy(reduceDebug(two, {type: 'ended'}))).toBe(false)
    })

    /** A count that can go negative disables every control for the rest of the session. */
    it('never counts below nothing running', () => {
        expect(apply({type: 'ended'}, {type: 'ended'}, {type: 'began'}).running).toBe(1)
    })

    it('shows the failure and retires it on the next answer', () => {
        const failed = apply({
            type: 'failed',
            error: {code: 'adapter_error', message: 'no debug adapter', retryable: false}
        })
        expect(failed.error?.message).toBe('no debug adapter')
        expect(reduceDebug(failed, {type: 'succeeded'}).error).toBeUndefined()
    })

    /** Nothing changed, so nothing re-renders: an answer with no failure on screen is a no-op. */
    it('answers with the same value when there was no failure to retire', () => {
        expect(reduceDebug(INITIAL_DEBUG_PANEL, {type: 'succeeded'})).toBe(INITIAL_DEBUG_PANEL)
    })
})
