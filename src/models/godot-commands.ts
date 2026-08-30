import type {
    GodotClassIcons,
    GodotFrame,
    GodotNodeDetails,
    GodotProjectSettings,
    GodotSceneTree,
    GodotSessionStatus,
    GodotSettingsPage
} from './godot'

export type GodotParams = Readonly<Record<string, unknown>>
export type GodotResult = Readonly<Record<string, unknown>>
export type NoGodotParams = Readonly<Record<string, never>>

export type GodotTreeBounds = Readonly<{
    root?: string | undefined
    depth?: number | undefined
    limit?: number | undefined
}>

export type GodotCommandSpec<Params extends GodotParams, Result extends GodotResult> = Readonly<{
    params: Params
    result: Result
}>

// GENERATED-BEGIN command-names sha256:dcb02e6c474a7e5f
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
    | 'node.change_type'
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
    | 'resource.create_texture'
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
    | 'runtime.wait'
    | 'runtime.pause'
    | 'runtime.resume'
// GENERATED-END command-names

export type GodotRuntimeState = Readonly<{
    running: boolean
    runtimeReady?: boolean | undefined
    broke?: boolean | undefined
}>

export type GodotCapture = Readonly<{running?: boolean | undefined; frame?: GodotFrame | undefined}>

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
    'scene.get_tree': GodotCommandSpec<GodotTreeBounds, GodotSceneTree>
    'node.inspect': GodotCommandSpec<Readonly<{scene: string; node: string}>, GodotNodeDetails>
    'resource.rescan': GodotCommandSpec<
        Readonly<{path?: string}>,
        Readonly<{scanned: boolean; path: string}>
    >
    'runtime.run': GodotCommandSpec<NoGodotParams, GodotCapture>
    'runtime.restart': GodotCommandSpec<NoGodotParams, GodotCapture>
    'runtime.stop': GodotCommandSpec<NoGodotParams, GodotRuntimeState>
    'runtime.get_state': GodotCommandSpec<NoGodotParams, GodotRuntimeState>
    'runtime.get_tree': GodotCommandSpec<GodotTreeBounds, GodotSceneTree>
    'runtime.inspect_node': GodotCommandSpec<Readonly<{path: string}>, GodotNodeDetails>
    'runtime.capture': GodotCommandSpec<
        Readonly<{source?: 'game' | 'editor'}>,
        Readonly<{frame?: GodotFrame | undefined}>
    >
}

export type GodotCommandMap = {
    readonly [Name in GodotCommandName]: Name extends keyof KnownGodotCommands ?
        KnownGodotCommands[Name]
    :   GodotCommandSpec<GodotParams, GodotResult>
}

export type GodotCommandParams<Name extends GodotCommandName> = GodotCommandMap[Name]['params']
export type GodotCommandResult<Name extends GodotCommandName> = GodotCommandMap[Name]['result']
