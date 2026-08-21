import {createContext, use} from 'react'
import type {ChatReference} from '../utils/chat-references'

/**
 * The seam between a panel that shows something and the chat draft that talks about it.
 *
 * The draft lives with the conversation, several columns away from the trees and lists that name
 * things, so the gesture travels as context rather than as a prop threaded through every frame in
 * between. A panel rendered without a provider — a component test, a screen with no conversation —
 * reads `undefined` and offers no way to add, rather than an action that silently does nothing.
 */
export type ChatReferenceSink = Readonly<{
    add: (reference: ChatReference) => void
    /**
     * Puts a block of text into the draft as its own paragraph.
     *
     * Separate from `add` because it is a different gesture, not a longer one. A reference is a
     * pointer — a node path, a worktree path — that the agent resolves for itself, and it reads as a
     * few words inside a sentence somebody is writing. This is the case where there is nothing to
     * point at: a saved sketch lives in Gofer's own data, which the agent's tools cannot reach, so
     * the only way to hand one over is to paste it. The caller words the block, including whatever
     * caption says what it is.
     */
    paste: (text: string) => void
}>

export const ChatReferenceContext = createContext<ChatReferenceSink | undefined>(undefined)

export function useChatReferences(): ChatReferenceSink | undefined {
    return use(ChatReferenceContext)
}
