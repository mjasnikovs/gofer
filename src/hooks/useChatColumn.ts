import {createContext, use} from 'react'
import type {Ref} from 'react'
import type {BriefState} from '../models/brief'
import type {Message} from '../models/chat'

export type ChatColumn = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    isStreaming: boolean
    messages: readonly Message[]
    scrollRef: Ref<HTMLElement>
    isScrolledUp: boolean
    scrollToBottom: () => void
    retry: (assistantId: number) => void
    brief: BriefState
    cancelBrief: () => void
    startWithoutPlan: () => void
}>

export const ChatColumnContext = createContext<ChatColumn | undefined>(undefined)

export function useChatColumn(): ChatColumn {
    const column = use(ChatColumnContext)
    if (!column) throw new Error('The chat column was rendered outside ChatColumnContext')
    return column
}
