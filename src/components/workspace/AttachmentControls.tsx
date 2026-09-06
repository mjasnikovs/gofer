import {use, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {Icon} from '@astryxdesign/core/Icon'
import {HStack} from '@astryxdesign/core/Stack'
import {Thumbnail} from '@astryxdesign/core/Thumbnail'
import CameraIcon from '@heroicons/react/24/outline/CameraIcon'
import PhotoIcon from '@heroicons/react/24/outline/PhotoIcon'
import {ImageScratchpad} from './ImageScratchpad'
import {EditorSessionContext} from '../../hooks/useEditorSession'
import {pngFile} from '../../services/chat-storage'
import {toGodotError} from '../../services/godot-session'
import {isSessionOffline, isSessionPlaying} from '../../models/godot'
import type {AnnotationShape} from '../../models/annotation'
import type {DraftAttachment} from '../../models/chat'

const CHAT_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

export type AttachmentPickerProps = Readonly<{
    canAttach: boolean
    supportsImages: boolean
    onSelect: (files: FileList | readonly File[] | null) => void
}>

export function AttachmentPicker({canAttach, supportsImages, onSelect}: AttachmentPickerProps) {
    const input = useRef<HTMLInputElement>(null)
    return (
        <>
            <input
                ref={input}
                type='file'
                accept={CHAT_ATTACHMENT_ACCEPT}
                multiple
                hidden
                onChange={event => {
                    const element = event.currentTarget
                    onSelect(element.files)
                    element.value = ''
                }}
            />
            <Button
                label='Attach images'
                variant='ghost'
                size='sm'
                isIconOnly
                icon={<Icon icon={PhotoIcon} />}
                isDisabled={!canAttach}
                tooltip={
                    supportsImages ? 'Attach up to 5 images' : (
                        'The selected model does not support image input'
                    )
                }
                onClick={() => {
                    input.current?.click()
                }}
            />
        </>
    )
}

function captureTooltip(supportsImages: boolean, isOffline: boolean): string {
    if (!supportsImages) return 'The selected model does not support image input'
    if (isOffline) return 'The editor is not running. Start a session, then take a screenshot.'
    return 'Attach a screenshot of the game or the editor'
}

export type GameCapturePickerProps = AttachmentPickerProps
    & Readonly<{
        onError: (message: string) => void
    }>

export function GameCapturePicker({
    canAttach,
    supportsImages,
    onSelect,
    onError
}: GameCapturePickerProps) {
    const session = use(EditorSessionContext)
    if (!session) return null
    const isPlaying = isSessionPlaying(session.state)
    const isOffline = isSessionOffline(session.state)

    // The editor half is the only way to photograph a 2D or 3D canvas: it captures whichever main
    // screen the editor is showing, and a game does not have to be running for it.
    const attach = async (source: 'game' | 'editor') => {
        const subject = source === 'game' ? 'game' : 'editor'
        try {
            const {frame} = await session.call(
                'runtime.capture',
                source === 'editor' ? {source} : {}
            )
            if (!frame) {
                onError(`The ${subject} answered the screenshot request with no picture.`)
                return
            }
            onSelect([pngFile(frame.data, `${source}-screenshot.png`)])
        } catch (failure) {
            onError(`The ${subject} could not be captured: ${toGodotError(failure).message}`)
        }
    }

    return (
        <DropdownMenu
            hasChevron={false}
            button={{
                label: 'Attach a game screenshot',
                variant: 'ghost',
                size: 'sm',
                isIconOnly: true,
                icon: <Icon icon={CameraIcon} />,
                isDisabled: !canAttach || isOffline,
                tooltip: captureTooltip(supportsImages, isOffline)
            }}
            menuWidth={260}
            items={[
                {
                    label: 'Screenshot the game',
                    isDisabled: !isPlaying,
                    ...(!isPlaying && {description: 'The game is not running. Run it first.'}),
                    onClick: () => {
                        void attach('game')
                    }
                },
                {
                    label: 'Screenshot the editor',
                    description: 'Whichever screen the editor is showing — 2D, 3D or Script',
                    onClick: () => {
                        void attach('editor')
                    }
                }
            ]}
        />
    )
}

export type AttachmentThumbnailsProps = Readonly<{
    attachments: readonly DraftAttachment[]
    isDisabled: boolean
    onEdit: (attachmentId: string, file: File, shapes: readonly AnnotationShape[]) => Promise<void>
    onRemove: (attachmentId: string) => void
}>

export function AttachmentThumbnails({
    attachments,
    isDisabled,
    onEdit,
    onRemove
}: AttachmentThumbnailsProps) {
    const [editingId, setEditingId] = useState<string>()
    const editing = attachments.find(attachment => attachment.id === editingId)
    return (
        <>
            <HStack
                gap={2}
                wrap='wrap'
            >
                {attachments.map(attachment => (
                    <Thumbnail
                        key={attachment.id}
                        src={attachment.previewUrl}
                        alt={`Attached image: ${attachment.name}`}
                        label={attachment.name}
                        isDisabled={isDisabled}
                        showRemoveOn='always'
                        onClick={() => {
                            setEditingId(attachment.id)
                        }}
                        onRemove={() => {
                            onRemove(attachment.id)
                        }}
                    />
                ))}
            </HStack>
            {editing && (
                <ImageScratchpad
                    attachment={editing}
                    onSave={async (file, shapes) => {
                        await onEdit(editing.id, file, shapes)
                        setEditingId(undefined)
                    }}
                    onClose={() => {
                        setEditingId(undefined)
                    }}
                />
            )}
        </>
    )
}
