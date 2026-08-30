import {describe, expect, it} from 'vitest'
import {INITIAL_SESSION_VIEW, reduceSession} from './godot-session-state'
import type {SessionAction, SessionView} from './godot-session-state'
import type {GodotSessionSummary} from './godot'

function apply(...actions: readonly SessionAction[]): SessionView {
    return actions.reduce(reduceSession, INITIAL_SESSION_VIEW)
}

const SESSION: GodotSessionSummary = {
    sessionId: 'session-0',
    state: 'ready',
    rpcAddress: '127.0.0.1:9100',
    lspPort: 6005,
    dapPort: 6006,
    godotVersion: 'Godot Engine v4.7.2.stable',
    worktree: '/home/dev/game'
}

const SCENE = {path: 'res://main.tscn', revision: 3, dirty: false}

describe('starting and stopping', () => {
    it('starts offline with nothing running', () => {
        expect(INITIAL_SESSION_VIEW.state).toBe('offline')
        expect(INITIAL_SESSION_VIEW.session).toBeUndefined()
        expect(INITIAL_SESSION_VIEW.isBusy).toBe(false)
    })

    it('takes the state the started session reports rather than assuming one', () => {
        const started = apply(
            {type: 'working'},
            {type: 'started', session: {...SESSION, state: 'starting'}}
        )
        expect(started.state).toBe('starting')
        expect(started.session?.sessionId).toBe('session-0')
        expect(started.isBusy).toBe(false)
    })

    it('lands in error and stops being busy when the start throws', () => {
        const failed = apply({type: 'working'}, {type: 'start-failed'})
        expect(failed.state).toBe('error')
        expect(failed.isBusy).toBe(false)
    })

    it('forgets the edited scene along with the session', () => {
        const stopped = apply(
            {type: 'started', session: SESSION},
            {type: 'scene-changed', scene: SCENE},
            {type: 'working'},
            {type: 'stopped'}
        )
        expect(stopped.state).toBe('offline')
        expect(stopped.session).toBeUndefined()
        expect(stopped.scene).toBeUndefined()
    })

    it('leaves the session alone when the stop would not go through', () => {
        const refused = apply(
            {type: 'started', session: SESSION},
            {type: 'working'},
            {type: 'settled'}
        )
        expect(refused.state).toBe('ready')
        expect(refused.session?.sessionId).toBe('session-0')
        expect(refused.isBusy).toBe(false)
    })

    it('adopts a session the backend was already supervising without claiming to be busy', () => {
        const found = apply({type: 'found', session: SESSION})
        expect(found.state).toBe('ready')
        expect(found.isBusy).toBe(false)
    })
})

describe('the epochs the panels depend on', () => {
    it('moves the scene epoch once per scene change', () => {
        const edited = apply(
            {type: 'scene-changed', scene: SCENE},
            {type: 'scene-changed', scene: {...SCENE, path: 'res://level.tscn', revision: 1}}
        )
        expect(edited.sceneEpoch).toBe(2)
        expect(edited.scene?.path).toBe('res://level.tscn')
        expect(edited.runtimeEpoch).toBe(0)
    })

    it('moves the runtime epoch when the game starts and when it stops', () => {
        const played = apply({type: 'runtime-changed'}, {type: 'runtime-changed'})
        expect(played.runtimeEpoch).toBe(2)
        expect(played.sceneEpoch).toBe(0)
    })

    it('moves the runtime epoch every time the session reaches a running state', () => {
        const restarted = apply(
            {type: 'state-changed', state: 'playing'},
            {type: 'state-changed', state: 'ready'},
            {type: 'state-changed', state: 'playing'}
        )
        expect(restarted.runtimeEpoch).toBe(3)
        expect(restarted.state).toBe('playing')
    })

    it('leaves the runtime epoch alone for states with no game in them', () => {
        const settling = apply(
            {type: 'state-changed', state: 'starting'},
            {type: 'state-changed', state: 'importing'},
            {type: 'state-changed', state: 'stopping'}
        )
        expect(settling.runtimeEpoch).toBe(0)
        expect(settling.state).toBe('stopping')
    })

    it('keeps the session summary across a state change', () => {
        const moved = apply(
            {type: 'started', session: SESSION},
            {type: 'state-changed', state: 'playing'}
        )
        expect(moved.session?.godotVersion).toBe('Godot Engine v4.7.2.stable')
        expect(moved.state).toBe('playing')
    })
})
