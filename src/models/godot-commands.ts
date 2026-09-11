export type GodotParams = Readonly<Record<string, unknown>>
export type GodotResult = Readonly<Record<string, unknown>>
export type NoGodotParams = Readonly<Record<string, never>>

export type GodotCommandSpec<Params extends GodotParams, Result extends GodotResult> = Readonly<{
    params: Params
    result: Result
}>

// GENERATED-BEGIN command-names sha256:cbfebab3c4281cf4
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

/** A Godot value as the protocol tags it: the Variant type by name, and its payload. */
export type GodotValue = Readonly<{type: string; value: unknown}>

/** One node of a scene tree, and the nodes under it. */
export type GodotNode = Readonly<{
    name: string
    type: string
    icon: string
    path: string
    children: readonly GodotNode[]
}>

/** A captured image, PNG bytes in base64. */
export type GodotFrame = Readonly<{encoding: string; width: number; height: number; data: string}>

/** The question the editor is waiting on, and the buttons it offers. */
export type GodotEditorDialog = Readonly<{title: string; text: string; buttons: readonly string[]}>

/** One setting a search answered with. `restartRequired` is a project setting fact; an editor setting carries none. */
export type GodotSetting = Readonly<{
    name: string
    value: GodotValue
    restartRequired?: boolean | undefined
    means?: string | undefined
    choices?: readonly string[] | undefined
}>

/** One property of a node in the edited scene, as the inspector would show it. */
export type GodotProperty = Readonly<{
    name: string
    value: GodotValue
    type: string
    className: string
    stored: boolean
    writable: boolean
}>

/** One property a batch write stored, read back off the node. */
export type GodotPropertyWrite = Readonly<{node: string; property: string; value: GodotValue}>

/** One event bound to an input action. `kind` says which of the other keys it carries. */
export type GodotInputEvent = Readonly<{
    kind: string
    key?: string | undefined
    button?: string | undefined
    joypadButton?: string | undefined
    axis?: string | undefined
    axisValue?: number | undefined
    description?: string | undefined
}>

/** One action of the Input Map. */
export type GodotInputAction = Readonly<{
    name: string
    deadzone: number
    events: readonly GodotInputEvent[]
    builtIn: boolean
}>

/** One autoload the project registers. */
export type GodotAutoload = Readonly<{
    name: string
    path: string
    enabled: boolean
    goferManaged: boolean
}>

/** One editor plugin the project holds. */
export type GodotPlugin = Readonly<{name: string; enabled: boolean; goferManaged: boolean}>

/** One painted cell of a TileMapLayer. */
export type GodotCell = Readonly<{
    x: number
    y: number
    source: number
    atlas: readonly number[]
    alternative: number
}>

/** How many cells one atlas tile draws. */
export type GodotTileTally = Readonly<{atlas: readonly number[]; count: number}>

/** One tile an atlas source defines, and whether it carries collision. */
export type GodotTilesetTile = Readonly<{atlas: readonly number[]; solid: boolean}>

/** One source of a TileSet. Only an atlas source carries a texture, a region size and a count. */
export type GodotTilesetSource = Readonly<{
    id: number
    type: string
    tiles: readonly GodotTilesetTile[]
    truncated: boolean
    texture?: string | undefined
    regionSize?: readonly number[] | undefined
    count?: number | undefined
}>

/** One file a rescan named, and whether the editor took it in. */
export type GodotRescannedFile = Readonly<{path: string; scanned: boolean}>

/** One persistent signal connection of the edited scene, in the shape node.connect_signal takes back. */
export type GodotNodeConnection = Readonly<{
    node: string
    signal: string
    target: string
    method: string
    binds: readonly GodotValue[]
    deferred: boolean
    oneShot: boolean
    persistent: boolean
}>

/** The editor session the supervisor is holding, as the desktop reports it. */
export type GodotSession = Readonly<{
    sessionId: string
    state: string
    rpcAddress: string
    lspPort: number
    dapPort: number
    godotVersion?: string | undefined
    worktree: string
}>

/** One captured line of the session output. */
export type GodotLogEntry = Readonly<{
    sequence: number
    source: string
    severity: string
    message: string
    timestamp: number
}>

/** One passage the documentation search ranked. */
export type GodotDocsPassage = Readonly<{
    text: string
    chapter: string
    order: number
    score: number
    pinned?: boolean | undefined
}>

/** One chapter an answer drew on, and how well it scored. */
export type GodotDocsChapter = Readonly<{chapter: string; score: number}>

/** One breakpoint as the adapter reports it back. */
export type GodotVerifiedBreakpoint = Readonly<{
    path: string
    line?: number | undefined
    verified: boolean
    message?: string | undefined
}>

/** Why the debuggee stopped, out of the adapter’s own stopped event. */
export type GodotStoppedDetails = Readonly<{
    reason: string
    threadId?: number | undefined
    description?: string | undefined
    text?: string | undefined
    allThreadsStopped: boolean
}>

/** One frame of a stack trace. */
export type GodotDebugFrame = Readonly<{
    id: number
    name: string
    line: number
    column: number
    path?: string | undefined
}>

/** Every command the addon answers, with the parameters it takes and the answer it gives. */
export interface GodotCommandMap {
    readonly 'session.get_state': GodotCommandSpec<
        NoGodotParams,
        Readonly<{
            state: string
            scene: string
            revision: number
            dirty: boolean
            canUndo: boolean
            canRedo: boolean
            dialog?: GodotEditorDialog | undefined
        }>
    >
    readonly 'session.cancel': GodotCommandSpec<
        Readonly<{requestId?: unknown}>,
        Readonly<{requestId: string; cancelled: boolean}>
    >
    readonly 'session.quit': GodotCommandSpec<NoGodotParams, Readonly<{quitting: boolean}>>
    readonly 'session.undo': GodotCommandSpec<
        NoGodotParams,
        Readonly<{undoDepth: number; redoDepth: number}>
    >
    readonly 'session.redo': GodotCommandSpec<
        NoGodotParams,
        Readonly<{undoDepth: number; redoDepth: number}>
    >
    readonly 'session.answer_dialog': GodotCommandSpec<
        Readonly<{button: string}>,
        Readonly<{answered: string; dialog: GodotEditorDialog}>
    >
    readonly 'session.get_unsaved_scenes': GodotCommandSpec<
        NoGodotParams,
        Readonly<{scenes: readonly string[]}>
    >
    readonly 'session.save_all_scenes': GodotCommandSpec<
        NoGodotParams,
        Readonly<{saved: readonly string[]}>
    >
    readonly 'project.get_settings': GodotCommandSpec<
        NoGodotParams,
        Readonly<{projectName: string; mainScene: string; renderingMethod: string}>
    >
    readonly 'project.search_settings': GodotCommandSpec<
        Readonly<{query: string}>,
        Readonly<{settings: readonly GodotSetting[]; totalMatches: number; truncated: boolean}>
    >
    readonly 'project.get_setting': GodotCommandSpec<
        Readonly<{name: string}>,
        Readonly<{
            name: string
            value: GodotValue
            restartRequired: boolean
            means?: string | undefined
            choices?: readonly string[] | undefined
        }>
    >
    readonly 'project.set_setting': GodotCommandSpec<
        Readonly<{name: string; value: GodotValue}>,
        Readonly<{name: string; saved: boolean; created: boolean; restartRequired: boolean}>
    >
    readonly 'project.reset_setting': GodotCommandSpec<
        Readonly<{name: string}>,
        Readonly<{
            name: string
            value: GodotValue
            previous: GodotValue
            changed: boolean
            restartRequired: boolean
        }>
    >
    readonly 'project.list_autoloads': GodotCommandSpec<
        NoGodotParams,
        Readonly<{autoloads: readonly GodotAutoload[]}>
    >
    readonly 'project.set_autoload': GodotCommandSpec<
        Readonly<{name: string; path: string; enabled?: boolean | undefined}>,
        Readonly<{name: string; path: string; enabled: boolean}>
    >
    readonly 'project.remove_autoload': GodotCommandSpec<
        Readonly<{name: string}>,
        Readonly<{name: string; removed: boolean}>
    >
    readonly 'project.list_input_actions': GodotCommandSpec<
        Readonly<{names?: readonly string[] | undefined}>,
        Readonly<{actions: readonly GodotInputAction[]; atEngineDefault: readonly string[]}>
    >
    readonly 'project.set_input_action': GodotCommandSpec<
        Readonly<{
            name: string
            events: readonly Readonly<{
                kind: 'key' | 'mouse_button' | 'joypad_button'
                key?: string | undefined
                button?: string | undefined
                joypadButton?: string | undefined
            }>[]
            deadzone?: number | undefined
        }>,
        Readonly<{name: string; deadzone: number; events: readonly GodotInputEvent[]}>
    >
    readonly 'project.remove_input_action': GodotCommandSpec<
        Readonly<{name: string}>,
        Readonly<{name: string; removed: boolean}>
    >
    readonly 'project.reset_input_action': GodotCommandSpec<
        Readonly<{name: string}>,
        Readonly<{name: string; reset: boolean; restartRequired: boolean}>
    >
    readonly 'project.list_plugins': GodotCommandSpec<
        NoGodotParams,
        Readonly<{plugins: readonly GodotPlugin[]}>
    >
    readonly 'project.set_plugin_enabled': GodotCommandSpec<
        Readonly<{plugin: string; enabled: boolean}>,
        Readonly<{plugin: string; enabled: boolean; changed: boolean}>
    >
    readonly 'editor.search_settings': GodotCommandSpec<
        Readonly<{query: string}>,
        Readonly<{settings: readonly GodotSetting[]; totalMatches: number; truncated: boolean}>
    >
    readonly 'editor.get_setting': GodotCommandSpec<
        Readonly<{name: string}>,
        Readonly<{name: string; value: GodotValue}>
    >
    readonly 'editor.set_setting': GodotCommandSpec<
        Readonly<{name: string; value: GodotValue}>,
        Readonly<{name: string; machineWide: boolean; value: GodotValue}>
    >
    readonly 'editor.get_class_icons': GodotCommandSpec<
        Readonly<{classes?: unknown}>,
        Readonly<{encoding: string; icons: Readonly<Record<string, string>>}>
    >
    readonly 'scene.list': GodotCommandSpec<NoGodotParams, Readonly<{scenes: readonly string[]}>>
    readonly 'scene.open': GodotCommandSpec<
        Readonly<{path: string}>,
        Readonly<{scene: string; revision: number; dirty: boolean}>
    >
    readonly 'scene.create': GodotCommandSpec<
        Readonly<{path: string; rootType: string; rootName?: string | undefined}>,
        Readonly<{scene: string; revision: number; dirty: boolean}>
    >
    readonly 'scene.save': GodotCommandSpec<
        NoGodotParams,
        Readonly<{scene: string; revision: number; dirty: boolean; wrote: boolean}>
    >
    readonly 'scene.save_as': GodotCommandSpec<
        Readonly<{path: string}>,
        Readonly<{scene: string; revision: number; dirty: boolean}>
    >
    readonly 'scene.reload': GodotCommandSpec<
        NoGodotParams,
        Readonly<{scene: string; revision: number; dirty: boolean}>
    >
    readonly 'scene.get_tree': GodotCommandSpec<
        Readonly<{
            root?: string | undefined
            depth?: number | undefined
            limit?: number | undefined
        }>,
        Readonly<{
            truncated: boolean
            root?: GodotNode | undefined
            revision: number
            scene: string
        }>
    >
    readonly 'node.create': GodotCommandSpec<
        Readonly<{parent: unknown; type: unknown; name: unknown; index?: unknown; scene?: unknown}>,
        Readonly<{node: string}>
    >
    readonly 'node.create_nodes': GodotCommandSpec<
        Readonly<{
            nodes: readonly Readonly<{
                parent: string
                type: string
                name: string
                index?: number | undefined
            }>[]
            scene?: string | undefined
        }>,
        Readonly<{nodes: readonly string[]; created: number}>
    >
    readonly 'node.instantiate': GodotCommandSpec<
        Readonly<{
            parent: string
            path: string
            name?: string | undefined
            index?: number | undefined
            scene?: string | undefined
        }>,
        Readonly<{node: string; path: string}>
    >
    readonly 'node.duplicate': GodotCommandSpec<
        Readonly<{node: string; name?: string | undefined; scene?: string | undefined}>,
        Readonly<{node: string}>
    >
    readonly 'node.rename': GodotCommandSpec<
        Readonly<{node: string; name: string; scene?: string | undefined}>,
        Readonly<{node: string}>
    >
    readonly 'node.reparent': GodotCommandSpec<
        Readonly<{
            node: string
            newParent: string
            index?: number | undefined
            scene?: string | undefined
        }>,
        Readonly<{node: string}>
    >
    readonly 'node.change_type': GodotCommandSpec<
        Readonly<{node: string; type: string; scene?: string | undefined}>,
        Readonly<{node: string; type: string}>
    >
    readonly 'node.delete': GodotCommandSpec<
        Readonly<{node: string; scene?: string | undefined}>,
        Readonly<{deleted: boolean}>
    >
    readonly 'node.set_property': GodotCommandSpec<
        Readonly<{node: unknown; property: unknown; value: unknown; scene?: unknown}>,
        Readonly<{node: string; property: string; value: GodotValue}>
    >
    readonly 'node.set_properties': GodotCommandSpec<
        Readonly<{
            properties: readonly Readonly<{node: string; property: string; value: GodotValue}>[]
            scene?: string | undefined
        }>,
        Readonly<{properties: readonly GodotPropertyWrite[]}>
    >
    readonly 'node.add_to_group': GodotCommandSpec<
        Readonly<{node: string; group: string}>,
        Readonly<{node: string; groups: readonly string[]}>
    >
    readonly 'node.remove_from_group': GodotCommandSpec<
        Readonly<{node: string; group: string}>,
        Readonly<{node: string; groups: readonly string[]}>
    >
    readonly 'node.connect_signal': GodotCommandSpec<
        Readonly<{
            node: string
            signal: string
            method: string
            target?: string | undefined
            binds?: readonly unknown[] | undefined
            deferred?: boolean | undefined
            oneShot?: boolean | undefined
        }>,
        GodotNodeConnection
    >
    readonly 'node.disconnect_signal': GodotCommandSpec<
        Readonly<{
            node: string
            signal: string
            method: string
            target?: string | undefined
            binds?: readonly unknown[] | undefined
        }>,
        Readonly<{node: string; signal: string; connected: boolean}>
    >
    readonly 'node.set_cells': GodotCommandSpec<
        Readonly<{
            node: string
            cells: readonly Readonly<{
                x: number
                y: number
                width?: number | undefined
                height?: number | undefined
                atlas?: readonly unknown[] | undefined
                source?: number | undefined
            }>[]
        }>,
        Readonly<{
            node: string
            cells: number
            usedRect: readonly number[]
            tileSet: string
            painted: number
            erased: number
        }>
    >
    readonly 'node.get_cells': GodotCommandSpec<
        Readonly<{node: string; limit?: number | undefined}>,
        Readonly<{
            node: string
            cells: number
            usedRect: readonly number[]
            tileSet: string
            cellsListed: readonly GodotCell[]
            tiles: readonly GodotTileTally[]
            truncated: boolean
        }>
    >
    readonly 'node.inspect': GodotCommandSpec<
        Readonly<{
            node: string
            properties?: readonly string[] | undefined
            scene?: string | undefined
        }>,
        Readonly<{
            name: string
            type: string
            path: string
            properties: readonly GodotProperty[]
            atClassDefault: readonly string[]
            groups: readonly string[]
            signals: readonly string[]
            connections: readonly GodotNodeConnection[]
        }>
    >
    readonly 'resource.rescan': GodotCommandSpec<
        Readonly<{paths?: readonly string[] | undefined}>,
        Readonly<{scanned: boolean; files: readonly GodotRescannedFile[]}>
    >
    readonly 'resource.create_tileset': GodotCommandSpec<
        Readonly<{
            path: string
            texture: string
            tileWidth?: number | undefined
            tileHeight?: number | undefined
            tiles?: readonly unknown[] | undefined
            solid?: readonly unknown[] | undefined
            allSolid?: boolean | undefined
        }>,
        Readonly<{
            path: string
            texture: string
            tileSize: readonly number[]
            grid: readonly number[]
            source: number
            tiles: readonly (readonly number[])[]
            solid: readonly (readonly number[])[]
            physicsLayers: number
            replaced: boolean
            scanned?: boolean | undefined
        }>
    >
    readonly 'resource.create_texture': GodotCommandSpec<
        Readonly<{
            path: string
            width: number
            height: number
            background?: string | undefined
            rects?:
                | readonly Readonly<{
                      x: number
                      y: number
                      width: number
                      height: number
                      color: string
                  }>[]
                | undefined
        }>,
        Readonly<{scanned: boolean; path: string; width: number; height: number; replaced: boolean}>
    >
    readonly 'resource.create_shape': GodotCommandSpec<
        Readonly<{
            path: string
            shapeType:
                | 'RectangleShape2D'
                | 'CircleShape2D'
                | 'CapsuleShape2D'
                | 'SegmentShape2D'
                | 'WorldBoundaryShape2D'
            size?: readonly unknown[] | undefined
            radius?: number | undefined
            height?: number | undefined
            points?: readonly unknown[] | undefined
        }>,
        Readonly<{
            path: string
            shapeType: string
            replaced: boolean
            scanned?: boolean | undefined
        }>
    >
    readonly 'resource.describe_tileset': GodotCommandSpec<
        Readonly<{path: string}>,
        Readonly<{
            path: string
            tileSize: readonly number[]
            physicsLayers: number
            sources: readonly GodotTilesetSource[]
        }>
    >
    readonly 'session.heartbeat': GodotCommandSpec<NoGodotParams, Readonly<Record<string, never>>>
    readonly 'runtime.run': GodotCommandSpec<
        Readonly<{scene?: string | undefined; playArgs?: readonly string[] | undefined}>,
        Readonly<{running: boolean; frame?: GodotFrame | undefined}>
    >
    readonly 'runtime.stop': GodotCommandSpec<NoGodotParams, Readonly<{running: boolean}>>
    readonly 'runtime.restart': GodotCommandSpec<
        NoGodotParams,
        Readonly<{running: boolean; frame?: GodotFrame | undefined}>
    >
    readonly 'runtime.get_state': GodotCommandSpec<
        NoGodotParams,
        Readonly<{running: boolean; runtimeReady: boolean; broke: boolean}>
    >
    readonly 'runtime.get_tree': GodotCommandSpec<
        Readonly<{
            root?: string | undefined
            depth?: number | undefined
            limit?: number | undefined
        }>,
        Readonly<{truncated: boolean; root: GodotNode; paused: boolean}>
    >
    readonly 'runtime.inspect_node': GodotCommandSpec<
        Readonly<{path: string; properties?: readonly unknown[] | undefined}>,
        Readonly<{
            path: string
            name: string
            type: string
            properties: Readonly<Record<string, GodotValue>>
            groups: readonly string[]
        }>
    >
    readonly 'runtime.input': GodotCommandSpec<
        Readonly<{
            events: readonly Readonly<{
                kind: 'key' | 'mouse_button' | 'mouse_motion' | 'joypad_button' | 'joypad_motion'
                key?: string | undefined
                pressed?: boolean | undefined
                button?: string | undefined
                joypadButton?: string | undefined
                position?: readonly unknown[] | undefined
                relative?: readonly unknown[] | undefined
                axis?: string | undefined
                value?: number | undefined
                device?: number | undefined
            }>[]
        }>,
        Readonly<{applied: number; frame?: GodotFrame | undefined}>
    >
    readonly 'runtime.capture': GodotCommandSpec<
        Readonly<{source?: 'game' | 'editor' | undefined}>,
        Readonly<{frame: GodotFrame}>
    >
    readonly 'runtime.get_monitors': GodotCommandSpec<
        Readonly<{monitors?: readonly string[] | undefined}>,
        Readonly<{monitors: Readonly<Record<string, number>>}>
    >
    readonly 'runtime.wait': GodotCommandSpec<
        Readonly<{frames?: number | undefined; ms?: number | undefined}>,
        Readonly<{
            frames?: number | undefined
            ms?: number | undefined
            exited: boolean
            uptimeMs?: number | undefined
        }>
    >
    readonly 'runtime.pause': GodotCommandSpec<NoGodotParams, Readonly<{paused: boolean}>>
    readonly 'runtime.resume': GodotCommandSpec<NoGodotParams, Readonly<{paused: boolean}>>
}
// GENERATED-END command-names

export type GodotCommandParams<Name extends GodotCommandName> = GodotCommandMap[Name]['params']
export type GodotCommandResult<Name extends GodotCommandName> = GodotCommandMap[Name]['result']
