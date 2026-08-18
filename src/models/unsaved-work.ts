import type {CommandError} from './errors'

/**
 * What the window tells the backend to do about work the Godot editor has not written.
 *
 * `ask` is what a first press of Merge means: nobody has been asked yet, so the merge is refused
 * and the scenes come back with the refusal. The other two are the answer to that question.
 */
export type UnsavedWork = 'ask' | 'save' | 'discard'

/** The code a merge refused for unsaved editor work carries. */
export const UNSAVED_WORK_CODE = 'godot_unsaved_scenes'

/**
 * The scenes a refusal is about, or none.
 *
 * Merging stops the editor with the editor's own quit, which saves nothing and asks nothing, so
 * this is the only warning there is. Any other failure — and any reply that does not carry a list —
 * is nothing to ask about, because a dialog with no files in it says nothing a user can act on.
 */
export function unsavedScenes(failure: CommandError): readonly string[] {
    if (failure.code !== UNSAVED_WORK_CODE) return []
    const named = failure.details?.['scenes']
    if (!Array.isArray(named)) return []
    return named.filter((scene): scene is string => typeof scene === 'string')
}
