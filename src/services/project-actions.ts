import {toGodotError} from './godot-session'
import type {LayoutAction} from '../models/ui-state'
import type {GodotCall} from '../models/workspace'

export type ProjectDebugger = Readonly<{
    isLaunched: boolean
    launch: () => Promise<void>
    terminate: () => Promise<void>
}>

export type ProjectActionDeps = Readonly<{
    call: GodotCall
    ensureReady: () => Promise<boolean>
    debug: ProjectDebugger
    dispatch: (action: LayoutAction) => void
    report: (message: string) => void
}>

export type ProjectActions = Readonly<{
    run: () => Promise<void>
    stop: () => Promise<void>
    openScene: (path: string) => Promise<void>
    openMainScene: () => Promise<void>
}>

export function resourcePath(path: string) {
    return path.startsWith('res://') ? path : `res://${path}`
}

export function createProjectActions({
    call,
    ensureReady,
    debug,
    dispatch,
    report
}: ProjectActionDeps): ProjectActions {
    const showScene = async (path: string) => {
        await call('scene.open', {path: resourcePath(path)})
        dispatch({type: 'explorer-tab', tab: 'scene'})
    }

    return {
        async run() {
            if (!(await ensureReady())) return
            dispatch({type: 'debug-started'})
            await debug.launch()
        },

        async stop() {
            if (debug.isLaunched) await debug.terminate()
            else await call('runtime.stop')
        },

        async openScene(path) {
            if (!(await ensureReady())) return
            try {
                await showScene(path)
            } catch (error) {
                report(`The scene could not be opened: ${toGodotError(error).message}`)
            }
        },

        async openMainScene() {
            if (!(await ensureReady())) return
            try {
                const settings = await call('project.get_settings')
                if (!settings.mainScene) {
                    report('This project names no main scene, so there is none to open.')
                    return
                }
                await showScene(settings.mainScene)
            } catch (error) {
                report(`The main scene could not be opened: ${toGodotError(error).message}`)
            }
        }
    }
}
