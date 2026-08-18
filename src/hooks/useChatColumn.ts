import {createContext, use} from 'react'
import type {RefObject} from 'react'
import type {Message} from '../models/chat'

/** The conversation on screen, as the column that draws it needs it. */
export type ChatColumn = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    isStreaming: boolean
    messages: readonly Message[]
    /** The scroll viewport, owned above so the follow-the-stream spring can drive it. */
    scrollRef: RefObject<HTMLElement | null>
    /** True once the reader has scrolled far enough up that the newest message is off screen. */
    isScrolledUp: boolean
    /** Jumps to the newest message and re-locks the follow. */
    scrollToBottom: () => void
    retry: (assistantId: number) => void
}>

/**
 * The conversation, published rather than passed.
 *
 * The chat column is drawn inside the IDE frame, several components below the one that owns the
 * conversation, and a streamed reply replaces that conversation once per token. Handing the column
 * down as a `chat` element made every one of those tokens a new prop for the frame — so the scene
 * tree, the runtime tree, the file listing and the bottom panel were all redrawn per token, none of
 * which has anything to do with the reply being written. The frame is handed one element that never
 * changes; what changes travels here, and reaches only what reads it.
 */
export const ChatColumnContext = createContext<ChatColumn | undefined>(undefined)

export function useChatColumn(): ChatColumn {
    const column = use(ChatColumnContext)
    if (!column) throw new Error('The chat column was rendered outside ChatColumnContext')
    return column
}
