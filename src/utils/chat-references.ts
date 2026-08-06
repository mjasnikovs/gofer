/**
 * References a panel can hand to the chat draft.
 *
 * Every panel that shows something the agent can act on — a scene node, a file in the worktree, an
 * imported asset — needs the same gesture: put *this* into the message I am writing. The wording
 * lives here so a node and a script read the same way in a prompt, and so the agent sees one shape
 * of reference whichever panel produced it.
 */

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

/** How a reference reads inside a message: `node \`/Main/Player\` (CharacterBody2D)`. */
export function referenceText(reference: ChatReference): string {
    const detail = reference.detail === undefined ? '' : ` (${reference.detail})`
    return `${KIND_WORD[reference.kind]} \`${reference.id}\`${detail}`
}

/**
 * Adds a reference to a draft, once. Clicking the same node twice is a repeated gesture, not a
 * request to name it twice, and the trailing space leaves the cursor where typing continues.
 */
export function appendReference(draft: string, reference: ChatReference): string {
    const text = referenceText(reference)
    if (draft.includes(text)) return draft
    if (draft.trim() === '') return `${text} `
    return `${draft.replace(/\s+$/, '')} ${text} `
}
