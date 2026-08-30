import {useCallback, useEffect, useRef, useState} from 'react'
import {invoke, isTauri} from '../services/desktop'
import type {Message} from '../models/chat'

type AttachmentPreviewOptions = Readonly<{
    messages: readonly Message[]
    isChatLoaded: boolean
}>

export function useAttachmentPreviews({messages, isChatLoaded}: AttachmentPreviewOptions) {
    const [attachmentPreviews, setAttachmentPreviews] = useState<Readonly<Record<string, string>>>(
        {}
    )
    const requested = useRef(new Set<string>())
    const stored = useRef(messages)

    useEffect(() => {
        stored.current = messages
    }, [messages])

    useEffect(() => {
        if (!isTauri() || !isChatLoaded) return
        let isCancelled = false
        const attachments = stored.current.flatMap(message =>
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
            if (isCancelled) return
            setAttachmentPreviews(previous => {
                const next = {...previous}
                for (const entry of previews) {
                    if (entry) next[entry[0]] = entry[1]
                }
                return next
            })
        }
        void load()
        return () => {
            isCancelled = true
        }
    }, [isChatLoaded])

    const addPreviews = useCallback((entries: Readonly<Record<string, string>>) => {
        setAttachmentPreviews(previous => ({...previous, ...entries}))
    }, [])

    return {attachmentPreviews, addPreviews}
}
