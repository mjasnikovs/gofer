import type {GodotCallOptions} from './godot'
import type {GodotCommandName, GodotCommandParams, GodotCommandResult} from './godot-commands'

export type GodotCall = <Name extends GodotCommandName>(
    command: Name,
    params?: GodotCommandParams<Name>,
    options?: GodotCallOptions
) => Promise<GodotCommandResult<Name>>

export type GodotSelection = Readonly<{
    origin: 'edited' | 'runtime'
    path: string
    name: string
    type: string
}>
