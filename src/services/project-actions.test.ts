import {describe, expect, it, vi} from 'vitest'
import {createProjectActions, resourcePath} from './project-actions'
import {refusal} from '../test/fake-session'
import type {GodotCall} from '../models/workspace'

/**
 * What the frame does to the project, checked without a frame.
 *
 * Each of these used to be a rendered toolbar button and a mounted IDE. They are sequences and
 * branches, so they are checked as sequences and branches.
 */

function actions(
    overrides: Readonly<{
        answer?: (command: string) => Promise<unknown>
        isReady?: boolean
        isLaunched?: boolean
    }> = {}
) {
    const {answer = () => Promise.resolve({}), isReady = true, isLaunched = false} = overrides
    const call = vi.fn((command: string) => answer(command))
    const debug = {
        isLaunched,
        launch: vi.fn(async () => undefined),
        terminate: vi.fn(async () => undefined)
    }
    const dispatch = vi.fn()
    const report = vi.fn()
    const ensureReady = vi.fn(() => Promise.resolve(isReady))
    return {
        project: createProjectActions({
            call: call as unknown as GodotCall,
            ensureReady,
            debug,
            dispatch,
            report
        }),
        call,
        debug,
        dispatch,
        report,
        ensureReady
    }
}

describe('resourcePath', () => {
    it('names a worktree file the way the editor names a scene', () => {
        expect(resourcePath('scenes/main.tscn')).toBe('res://scenes/main.tscn')
    })

    it('leaves a resource path that already is one alone', () => {
        expect(resourcePath('res://scenes/main.tscn')).toBe('res://scenes/main.tscn')
    })
})

describe('running the project', () => {
    it('ensures an editor, shows the debugger, then launches under it', async () => {
        const {project, debug, dispatch, ensureReady} = actions()
        await project.run()
        expect(ensureReady).toHaveBeenCalled()
        expect(dispatch).toHaveBeenCalledWith({type: 'debug-started'})
        expect(debug.launch).toHaveBeenCalled()
    })

    it('launches nothing when no editor could be had', async () => {
        const {project, debug, dispatch} = actions({isReady: false})
        await project.run()
        expect(dispatch).not.toHaveBeenCalled()
        expect(debug.launch).not.toHaveBeenCalled()
    })
})

describe('stopping the project', () => {
    it('terminates the debug session that started the game', async () => {
        const {project, debug, call} = actions({isLaunched: true})
        await project.stop()
        expect(debug.terminate).toHaveBeenCalled()
        expect(call).not.toHaveBeenCalled()
    })

    /**
     * A game the Game tab's own Run started has no debug session behind it. Terminating would fail
     * naming an adapter the user never asked for, so the editor is asked to stop the game instead.
     */
    it('stops a game the editor started by asking the editor', async () => {
        const {project, debug, call} = actions({isLaunched: false})
        await project.stop()
        expect(debug.terminate).not.toHaveBeenCalled()
        expect(call).toHaveBeenCalledWith('runtime.stop')
    })
})

describe('opening a scene', () => {
    it('sends the resource path, and shows what it opened', async () => {
        const {project, call, dispatch} = actions()
        await project.openScene('scenes/main.tscn')
        expect(call).toHaveBeenCalledWith('scene.open', {path: 'res://scenes/main.tscn'})
        expect(dispatch).toHaveBeenCalledWith({type: 'explorer-tab', tab: 'scene'})
    })

    it('reports a scene the editor would not open', async () => {
        const {project, report, dispatch} = actions({
            answer: () => Promise.reject(refusal('scene_missing', 'no such scene'))
        })
        await project.openScene('scenes/gone.tscn')
        expect(report).toHaveBeenCalledWith('The scene could not be opened: no such scene')
        expect(dispatch).not.toHaveBeenCalled()
    })

    it('opens nothing when no editor could be had', async () => {
        const {project, call} = actions({isReady: false})
        await project.openScene('scenes/main.tscn')
        expect(call).not.toHaveBeenCalled()
    })
})

describe('opening the main scene', () => {
    it('opens the scene the project names', async () => {
        const {project, call} = actions({
            answer: command =>
                command === 'project.get_settings' ?
                    Promise.resolve({mainScene: 'scenes/main.tscn'})
                :   Promise.resolve({})
        })
        await project.openMainScene()
        expect(call).toHaveBeenCalledWith('scene.open', {path: 'res://scenes/main.tscn'})
    })

    /** A project with no main scene has none to open, which is a fact rather than a failure. */
    it('says so when the project names none', async () => {
        const {project, call, report} = actions({
            answer: () => Promise.resolve({mainScene: ''})
        })
        await project.openMainScene()
        expect(report).toHaveBeenCalledWith(
            'This project names no main scene, so there is none to open.'
        )
        expect(call).not.toHaveBeenCalledWith('scene.open', expect.anything())
    })
})
