/**
 * References a panel can hand to the chat draft.
 *
 * Every panel that shows something the agent can act on — a scene node, a file in the worktree, an
 * imported asset — needs the same gesture: put *this* into the message I am writing. The wording
 * lives here so the agent sees one shape of reference whichever panel produced it.
 *
 * A file is the exception, and deliberately: the composer's own `@` menu already writes
 * `@scripts/player.gd`, and that is the shape the model has read a thousand times. A button that
 * wrote `` file `scripts/player.gd` `` for the same file would teach it two.
 */

import {mentionValue} from '../models/file-mentions'

export type ChatReferenceKind = 'node' | 'file' | 'asset'

export type ChatReference = Readonly<{
    kind: ChatReferenceKind
    /** What the agent can look the thing up by: a node path, a resource path, a worktree path. */
    id: string
    /** The aside a reader needs to know what it is — a node's class, a file's role. */
    detail?: string | undefined
}>

const KIND_WORD: Readonly<Record<ChatReferenceKind, string>> = {
    node: 'node',
    file: 'file',
    asset: 'asset'
}

/**
 * How a reference reads inside a message: `node \`/Main/Player\` (CharacterBody2D)`, and
 * `@scripts/player.gd` for a file.
 */
export function referenceText(reference: ChatReference): string {
    if (reference.kind === 'file') return mentionValue(reference.id)
    const detail = reference.detail === undefined ? '' : ` (${reference.detail})`
    return `${KIND_WORD[reference.kind]} \`${reference.id}\`${detail}`
}

/**
 * Whether a draft already names this, rather than merely containing its letters.
 *
 * A plain `includes` was enough while every reference ended in a backtick. A file's does not:
 * `@scripts/` sits inside `@scripts/player.gd`, so adding the folder after a file in it read as a
 * repeat and did nothing at all. The reference has to end where it ends — at whitespace, or at the
 * end of the draft.
 */
function names(draft: string, text: string): boolean {
    let at = draft.indexOf(text)
    while (at !== -1) {
        const after = draft[at + text.length]
        if (after === undefined || /\s/.test(after)) return true
        at = draft.indexOf(text, at + 1)
    }
    return false
}

/**
 * Adds a reference to a draft, once. Clicking the same node twice is a repeated gesture, not a
 * request to name it twice, and the trailing space leaves the cursor where typing continues.
 */
export function appendReference(draft: string, reference: ChatReference): string {
    const text = referenceText(reference)
    if (names(draft, text)) return draft
    if (draft.trim() === '') return `${text} `
    return `${draft.replace(/\s+$/, '')} ${text} `
}
