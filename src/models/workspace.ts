import type {GodotCallOptions} from './godot'

/**
 * What the inspector workspace passes between its regions. Every panel calls the editor through one
 * function so that a UI action and an AI tool call reach the same Rust handler.
 */
export type GodotCall = (
    command: string,
    params?: Readonly<Record<string, unknown>>,
    options?: GodotCallOptions
) => Promise<Readonly<Record<string, unknown>>>

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
