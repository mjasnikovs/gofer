import {createContext, use} from 'react'
import type {ChatReference} from '../utils/chat-references'

export type ChatReferenceSink = Readonly<{
    add: (reference: ChatReference) => void
    paste: (text: string) => void
}>

export const ChatReferenceContext = createContext<ChatReferenceSink | undefined>(undefined)

export function useChatReferences(): ChatReferenceSink | undefined {
    return use(ChatReferenceContext)
}
