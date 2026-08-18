import {toGodotError} from './godot-session'
import type {LayoutAction} from '../models/ui-state'
import type {GodotCall} from '../models/workspace'

/**
 * What the frame does to the project, as opposed to what it draws.
 *
 * Running a game, stopping it, and opening a scene are each a sequence rather than a command: an
 * editor has to be there first, a worktree path is not a resource path, and a game started by the
 * editor's own play button is not stopped the way one started by the debugger is. Those rules used
 * to live in a component body, where the only way to check any of them was to mount the whole IDE.
 *
 * Nothing here is React. The frame builds one of these from the session it owns and hands the
 * results to buttons.
 */

/** What these actions need of the debugger. Two questions and two commands, nothing more. */
export type ProjectDebugger = Readonly<{
    isLaunched: boolean
    launch: () => Promise<void>
    terminate: () => Promise<void>
}>

export type ProjectActionDeps = Readonly<{
    call: GodotCall
    /** Guarantees an editor that can answer, and says whether it got one. */
    ensureReady: () => Promise<boolean>
    debug: ProjectDebugger
    /** Moves the layout: to the debugger when a run starts, to the scene when one opens. */
    dispatch: (action: LayoutAction) => void
    report: (message: string) => void
}>

export type ProjectActions = Readonly<{
    /** Ensures an editor, then launches the game under Godot's own debug adapter. */
    run: () => Promise<void>
    /** Stops whatever is running, by the route that started it. */
    stop: () => Promise<void>
    /** Opens one scene in the managed editor, named by its place in the worktree. */
    openScene: (path: string) => Promise<void>
    /** Opens the scene `project.godot` names, which is the scene Run plays. */
    openMainScene: () => Promise<void>
}>

/**
 * The editor names a scene by its resource path; the explorer names a file by its worktree path.
 *
 * Sending the worktree path asks the editor to open a scene it has never heard of, which is why
 * this is a rule of the action rather than something each caller remembers.
 */
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
    /** Opens a scene the editor is known to be able to open, and shows what it opened. */
    const showScene = async (path: string) => {
        await call('scene.open', {path: resourcePath(path)})
        // The editor owns the edited scene, so this is a request to it rather than a local change;
        // the tree, the inspector, and Run all follow the addon's own `scene.changed` event.
        dispatch({type: 'explorer-tab', tab: 'scene'})
    }

    return {
        /*
         * Run is one action rather than two because running without an editor session is not
         * something Gofer can do at all — the adapter belongs to the editor. Launching under the
         * debugger is what makes the breakpoints in Monaco's gutter mean something, so the bottom
         * panel follows the game to the debugger tab. The Game tab's controls remain the editor's
         * own play buttons, which capture frames but stop at no breakpoint.
         */
        async run() {
            if (!(await ensureReady())) return
            dispatch({type: 'debug-started'})
            await debug.launch()
        },

        /*
         * The toolbar offers Stop for any game the editor is playing, including one the Game tab's
         * own Run started — and that one has no debug session behind it, so terminating would fail
         * naming an adapter the user never asked for.
         */
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
