import type {
    GodotClassIcons,
    GodotFrame,
    GodotNodeDetails,
    GodotProjectSettings,
    GodotSceneTree,
    GodotSessionStatus,
    GodotSettingsPage
} from './godot'

/**
 * What the addon can be asked, and what it answers.
 *
 * The desktop seam has had `DesktopCommandMap` since it was written: a command name is a key, not a
 * string, and its reply is a type rather than something the call site asserts. The editor seam had
 * neither. `callGodot` took a `string` and answered `Record<string, unknown>`, so a mistyped command
 * compiled and every reader cast the result back to what it hoped it was — five surfaces reconciled
 * by a script, and the one the user actually clicks through was not among them.
 */

/** The parameters of a command nobody has had to name yet, which is what every call site sent. */
export type GodotParams = Readonly<Record<string, unknown>>
/** The result of a command nobody has had to read yet, which is what every call site received. */
export type GodotResult = Readonly<Record<string, unknown>>
/** A command that takes nothing. Callers may still omit the argument entirely. */
export type NoGodotParams = Readonly<Record<string, never>>

export type GodotCommandSpec<Params extends GodotParams, Result extends GodotResult> = Readonly<{
    params: Params
    result: Result
}>

// GENERATED-BEGIN command-names sha256:83ec7404f57dd9d3
export type GodotCommandName =
    | 'session.get_state'
    | 'session.cancel'
    | 'session.quit'
    | 'session.undo'
    | 'session.redo'
    | 'session.answer_dialog'
    | 'session.get_unsaved_scenes'
    | 'session.save_all_scenes'
    | 'project.get_settings'
    | 'project.search_settings'
    | 'project.get_setting'
    | 'project.set_setting'
    | 'project.reset_setting'
    | 'project.list_autoloads'
    | 'project.set_autoload'
    | 'project.remove_autoload'
    | 'project.list_input_actions'
    | 'project.set_input_action'
    | 'project.remove_input_action'
    | 'project.reset_input_action'
    | 'project.list_plugins'
    | 'project.set_plugin_enabled'
    | 'editor.search_settings'
    | 'editor.get_setting'
    | 'editor.set_setting'
    | 'editor.get_class_icons'
    | 'scene.list'
    | 'scene.open'
    | 'scene.create'
    | 'scene.save'
    | 'scene.save_as'
    | 'scene.reload'
    | 'scene.get_tree'
    | 'node.create'
    | 'node.create_nodes'
    | 'node.instantiate'
    | 'node.duplicate'
    | 'node.rename'
    | 'node.reparent'
    | 'node.delete'
    | 'node.set_property'
    | 'node.set_properties'
    | 'node.add_to_group'
    | 'node.remove_from_group'
    | 'node.connect_signal'
    | 'node.disconnect_signal'
    | 'node.set_cells'
    | 'node.get_cells'
    | 'node.inspect'
    | 'resource.rescan'
    | 'resource.create_tileset'
    | 'resource.create_shape'
    | 'resource.describe_tileset'
    | 'session.heartbeat'
    | 'runtime.run'
    | 'runtime.stop'
    | 'runtime.restart'
    | 'runtime.get_state'
    | 'runtime.get_tree'
    | 'runtime.inspect_node'
    | 'runtime.input'
    | 'runtime.capture'
    | 'runtime.get_monitors'
// GENERATED-END command-names

/**
 * Whether the game is playing, whether its helper autoload has announced itself, and whether the
 * debugger has it paused. A paused game is `running` and answers nothing, so `broke` is the only
 * field here that tells those two apart.
 */
export type GodotRuntimeState = Readonly<{
    running: boolean
    runtimeReady?: boolean | undefined
    broke?: boolean | undefined
}>

/** A launch or a capture, which answer with the frame that already shows what they did. */
export type GodotCapture = Readonly<{running?: boolean | undefined; frame?: GodotFrame | undefined}>

/**
 * The commands whose shape somebody has had to know.
 *
 * Every name here is checked against the catalogue by `scripts/check-command-surface.mjs`, the same
 * way the mutating list is — a typo would otherwise sit in this type meaning nothing, because a key
 * the map never looks up cannot be wrong. What is *not* here is not untyped by accident: it is a
 * command the renderer has never called, and it keeps the generic shape until it has.
 */
interface KnownGodotCommands {
    'session.get_state': GodotCommandSpec<NoGodotParams, GodotSessionStatus>
    'project.get_settings': GodotCommandSpec<NoGodotParams, GodotProjectSettings>
    'project.search_settings': GodotCommandSpec<Readonly<{query: string}>, GodotSettingsPage>
    'editor.search_settings': GodotCommandSpec<Readonly<{query: string}>, GodotSettingsPage>
    'editor.get_class_icons': GodotCommandSpec<
        Readonly<{classes: readonly string[]}>,
        GodotClassIcons
    >
    'scene.open': GodotCommandSpec<Readonly<{path: string}>, GodotResult>
    'scene.get_tree': GodotCommandSpec<NoGodotParams, GodotSceneTree>
    'node.inspect': GodotCommandSpec<Readonly<{scene: string; node: string}>, GodotNodeDetails>
    'resource.rescan': GodotCommandSpec<
        Readonly<{path?: string}>,
        Readonly<{scanned: boolean; path: string}>
    >
    'runtime.run': GodotCommandSpec<NoGodotParams, GodotCapture>
    'runtime.restart': GodotCommandSpec<NoGodotParams, GodotCapture>
    'runtime.stop': GodotCommandSpec<NoGodotParams, GodotRuntimeState>
    'runtime.get_state': GodotCommandSpec<NoGodotParams, GodotRuntimeState>
    'runtime.get_tree': GodotCommandSpec<NoGodotParams, GodotSceneTree>
    'runtime.inspect_node': GodotCommandSpec<Readonly<{path: string}>, GodotNodeDetails>
    'runtime.capture': GodotCommandSpec<
        Readonly<{source?: 'game' | 'editor'}>,
        Readonly<{frame?: GodotFrame | undefined}>
    >
}

/**
 * The map itself, one entry per catalogued command.
 *
 * It is written as a mapped type over the generated union rather than as a list, so its keys are
 * the catalogue's keys by construction. A command added to `commands.json` needs nothing here to
 * become callable, and a command removed from it stops compiling wherever the renderer names it.
 */
export type GodotCommandMap = {
    readonly [Name in GodotCommandName]: Name extends keyof KnownGodotCommands ?
        KnownGodotCommands[Name]
    :   GodotCommandSpec<GodotParams, GodotResult>
}

export type GodotCommandParams<Name extends GodotCommandName> = GodotCommandMap[Name]['params']
export type GodotCommandResult<Name extends GodotCommandName> = GodotCommandMap[Name]['result']
