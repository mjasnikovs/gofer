import {useCallback, useEffect, useRef, useState} from 'react'
import {invoke, isTauri} from '../services/desktop'
import type {Message} from '../models/chat'

type AttachmentPreviewOptions = Readonly<{
    messages: readonly Message[]
    isMounted: React.RefObject<boolean>
}>

/**
 * Fetches a data URL for every attachment referenced by the conversation.
 *
 * Each attachment id is requested at most once for the lifetime of the workspace, so re-rendering
 * a long conversation does not re-read blobs that are already in memory.
 */
export function useAttachmentPreviews({messages, isMounted}: AttachmentPreviewOptions) {
    const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
        {}
    )
    const requested = useRef(new Set<string>())

    useEffect(() => {
        if (!isTauri()) return
        const attachments = messages.flatMap(message =>
            (message.attachments ?? []).filter(attachment => !requested.current.has(attachment.id))
        )
        if (attachments.length === 0) return
        for (const attachment of attachments) requested.current.add(attachment.id)
        const load = async () => {
            const previews = await Promise.all(
                attachments.map(async attachment => {
                    try {
                        const preview = await invoke('read_chat_attachment', {attachment})
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
    }, [isMounted, messages])

    const addPreviews = useCallback((entries: Readonly<Record<string, string>>) => {
        setAttachmentPreviews(previous => ({...previous, ...entries}))
    }, [])

    return {attachmentPreviews, addPreviews}
}
