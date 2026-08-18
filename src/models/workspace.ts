import type {GodotCallOptions} from './godot'
import type {GodotCommandName, GodotCommandParams, GodotCommandResult} from './godot-commands'

/**
 * What the inspector workspace passes between its regions. Every panel calls the editor through one
 * function so that a UI action and an AI tool call reach the same Rust handler.
 *
 * It is generic in the command, so a panel that asks for a scene tree is handed a scene tree. The
 * panels used to cast, which meant each one decided for itself what a reply was, and nothing
 * noticed when a command stopped answering that way.
 */
export type GodotCall = <Name extends GodotCommandName>(
    command: Name,
    params?: GodotCommandParams<Name>,
    options?: GodotCallOptions
) => Promise<GodotCommandResult<Name>>

/**
 * The node the inspector describes. `origin` is load-bearing: an edited node is what the editor
 * would save, a runtime node is what the running game holds in memory, and the two are never the
 * same object even when they share a path.
 */
export type GodotSelection = Readonly<{
    origin: 'edited' | 'runtime'
    path: string
    name: string
    type: string
}>
