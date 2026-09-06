import {useCallback, useState} from 'react'
import {attachmentData, pngFile} from '../services/chat-storage'
import {invoke, isTauri} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import type {AnnotationShape} from '../models/annotation'
import type {DraftAttachment} from '../models/chat'

export const CHAT_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_CHAT_ATTACHMENTS = 5
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024

export type AttachmentPool = Readonly<{
    attachments: readonly DraftAttachment[]
    clear: () => void
    select: (files: FileList | readonly File[] | null) => Promise<void>
    attachClipboardImage: () => Promise<void>
    edit: (attachmentId: string, file: File, shapes: readonly AnnotationShape[]) => Promise<void>
    remove: (attachmentId: string) => void
}>

/**
 * One pool of images waiting to be sent. Every field that can carry pictures holds its own, because
 * a picture attached to a question is not the chat's to spend.
 */
export function useAttachmentPool(report: (message?: string) => void): AttachmentPool {
    const [attachments, setAttachments] = useState<readonly DraftAttachment[]>([])

    const clear = useCallback(() => {
        setAttachments([])
    }, [])

    const remove = useCallback((attachmentId: string) => {
        setAttachments(previous => previous.filter(item => item.id !== attachmentId))
    }, [])

    const select = async (files: FileList | readonly File[] | null) => {
        if (!files) return
        const available = MAX_CHAT_ATTACHMENTS - attachments.length
        const selected = Array.from(files).slice(0, available)
        const invalid = selected.find(
            file =>
                !CHAT_ATTACHMENT_TYPES.has(file.type)
                || file.size === 0
                || file.size > MAX_CHAT_ATTACHMENT_BYTES
        )
        if (files.length > available) {
            report(`You can attach up to ${String(MAX_CHAT_ATTACHMENTS)} images.`)
            return
        }
        if (invalid) {
            report(
                invalid.size === 0 ? `${invalid.name} is empty.`
                : CHAT_ATTACHMENT_TYPES.has(invalid.type) ? `${invalid.name} is larger than 10 MiB.`
                : `${invalid.name} is not a supported image.`
            )
            return
        }
        try {
            const added = await Promise.all(
                selected.map(async file => ({
                    id: crypto.randomUUID(),
                    name: file.name,
                    mimeType: file.type,
                    size: file.size,
                    ...(await attachmentData(file))
                }))
            )
            setAttachments(previous => [...previous, ...added])
            report(undefined)
        } catch (error) {
            report(`The images could not be read: ${commandErrorMessage(error)}`)
        }
    }

    const attachClipboardImage = async () => {
        if (!isTauri()) return
        try {
            const image = await invoke('read_clipboard_image')
            if (!image) return
            await select([pngFile(image.pngBase64, 'pasted-image.png')])
        } catch (error) {
            report(`The pasted image could not be read: ${commandErrorMessage(error)}`)
        }
    }

    const edit = async (attachmentId: string, file: File, shapes: readonly AnnotationShape[]) => {
        if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
            report(`${file.name} is larger than 10 MiB once drawn on.`)
            return
        }
        try {
            const stored = await attachmentData(file)
            setAttachments(previous =>
                previous.map(attachment =>
                    attachment.id === attachmentId ?
                        {
                            ...attachment,
                            name: file.name,
                            mimeType: file.type,
                            size: file.size,
                            ...stored,
                            annotation: {
                                src: attachment.annotation?.src ?? attachment.previewUrl,
                                shapes
                            }
                        }
                    :   attachment
                )
            )
            report(undefined)
        } catch (error) {
            report(`The drawing could not be saved: ${commandErrorMessage(error)}`)
        }
    }

    return {attachments, clear, select, attachClipboardImage, edit, remove}
}
