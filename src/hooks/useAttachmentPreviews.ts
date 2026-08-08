import {useCallback, useEffect, useRef, useState} from 'react'
import {readChatAttachment} from '../services/chat-session'
import {isTauri} from '../services/desktop'
import type {Message} from '../models/chat'

type AttachmentPreviewOptions = Readonly<{
    messages: readonly Message[]
    isChatLoaded: boolean
    isMounted: React.RefObject<boolean>
}>

/**
 * Fetches a data URL for every attachment the stored conversation references.
 *
 * An attachment enters the conversation in exactly two ways: it arrives with the chat the backend
 * hands over, or the user has just attached it — and the second case already holds the data URL it
 * was read from, which the composer passes straight to `addPreviews`. So this reads the stored
 * conversation once, when it loads, rather than following `messages`: that array is replaced on
 * every streamed token, and walking every message for its attachments per token is work with no
 * possible answer, since the message being streamed is the assistant's and carries none.
 *
 * Each attachment id is requested at most once for the lifetime of the workspace.
 */
export function useAttachmentPreviews({
    messages,
    isChatLoaded,
    isMounted
}: AttachmentPreviewOptions) {
    const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
        {}
    )
    const requested = useRef(new Set<string>())
    const stored = useRef(messages)

    // Declared first so the conversation is current by the time the effect below reads it: effects
    // on one commit run in the order they are written.
    useEffect(() => {
        stored.current = messages
    }, [messages])

    useEffect(() => {
        if (!isTauri() || !isChatLoaded) return
        const attachments = stored.current.flatMap(message =>
            (message.attachments ?? []).filter(attachment => !requested.current.has(attachment.id))
        )
        if (attachments.length === 0) return
        for (const attachment of attachments) requested.current.add(attachment.id)
        const load = async () => {
            const previews = await Promise.all(
                attachments.map(async attachment => {
                    try {
                        const preview = await readChatAttachment(attachment)
                        return [attachment.id, preview] as const
                    } catch {
                        return undefined
                    }
                })
            )
            if (!isMounted.current) return
            setAttachmentPreviews(previous => {
                const next = {...previous}
                for (const entry of previews) {
                    if (entry) next[entry[0]] = entry[1]
                }
                return next
            })
        }
        void load()
    }, [isChatLoaded, isMounted])

    const addPreviews = useCallback((entries: Readonly<Record<string, string>>) => {
        setAttachmentPreviews(previous => ({...previous, ...entries}))
    }, [])

    return {attachmentPreviews, addPreviews}
}
