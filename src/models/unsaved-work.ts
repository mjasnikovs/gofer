import type {CommandError} from './errors'

export type UnsavedWork = 'ask' | 'save' | 'discard'

export const UNSAVED_WORK_CODE = 'godot_unsaved_scenes'

export function unsavedScenes(failure: CommandError): readonly string[] {
    if (failure.code !== UNSAVED_WORK_CODE) return []
    const named = failure.details?.['scenes']
    if (!Array.isArray(named)) return []
    return named.filter((scene): scene is string => typeof scene === 'string')
}
