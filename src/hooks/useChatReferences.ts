import {createContext, useContext} from 'react'
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
}>

export const ChatReferenceContext = createContext<ChatReferenceSink | undefined>(undefined)

export function useChatReferences(): ChatReferenceSink | undefined {
    return useContext(ChatReferenceContext)
}
