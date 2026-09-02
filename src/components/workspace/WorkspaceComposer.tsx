import {useCallback, useEffect, useRef, useState} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {
    ChatComposer,
    ChatComposerDrawer,
    ChatComposerInput,
    ChatSendButton
} from '@astryxdesign/core/Chat'
import type {ChatComposerInputHandle} from '@astryxdesign/core/Chat'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {Icon} from '@astryxdesign/core/Icon'
import {isImeKeyEvent} from '@astryxdesign/core/utils'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import {Thumbnail} from '@astryxdesign/core/Thumbnail'
import CameraIcon from '@heroicons/react/24/outline/CameraIcon'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import MapIcon from '@heroicons/react/24/outline/MapIcon'
import PhotoIcon from '@heroicons/react/24/outline/PhotoIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import {ImageScratchpad} from './ImageScratchpad'
import {contextProgressVariant, formatContextUsage} from '../../utils/chat-format'
import {useComposer} from '../../hooks/useComposer'
import {useComposerAppendRef} from '../../hooks/useComposerAppend'
import {useEditorSession} from '../../hooks/useEditorSession'
import {useFileMentionTrigger} from '../../hooks/useFileMentionTrigger'
import {useWorkspaceFailure} from '../../hooks/useWorkspaceFailure'
import {pngFile} from '../../services/chat-storage'
import {toGodotError} from '../../services/godot-session'
import {isSessionOffline, isSessionPlaying} from '../../models/godot'

const CHAT_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const SPACIOUS_COMPOSER_INPUT_STYLE = {
    minHeight: 'calc(var(--spacing-12) + var(--spacing-10))'
} as const

function imageFiles(files: readonly File[]): readonly File[] {
    return files
        .filter(file => file.type.startsWith('image/'))
        .map(file =>
            file.name === '' ?
                new File([file], `pasted-image.${file.type.slice('image/'.length)}`, {
                    type: file.type
                })
            :   file
        )
}

function clipboardItemImages(clipboard: DataTransfer): readonly File[] {
    return imageFiles(
        Array.from(clipboard.items)
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter((file): file is File => file !== null)
    )
}

function AttachmentPicker() {
    const {actions, meta} = useComposer()
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
                    void actions.selectAttachments(element.files).finally(() => {
                        element.value = ''
                    })
                }}
            />
            <Button
                label='Attach images'
                variant='ghost'
                size='sm'
                isIconOnly
                icon={<Icon icon={PhotoIcon} />}
                isDisabled={!meta.canAttachImages}
                tooltip={
                    meta.supportsImages ? 'Attach up to 5 images' : (
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

function GameCapturePicker() {
    const {actions, meta} = useComposer()
    const {call, state} = useEditorSession()
    const report = useWorkspaceFailure()
    const isPlaying = isSessionPlaying(state)
    const isOffline = isSessionOffline(state)

    // The editor half is the only way to photograph a 2D or 3D canvas: it captures whichever main
    // screen the editor is showing, and a game does not have to be running for it.
    const attach = async (source: 'game' | 'editor') => {
        const subject = source === 'game' ? 'game' : 'editor'
        try {
            const {frame} = await call('runtime.capture', source === 'editor' ? {source} : {})
            if (!frame) {
                report(`The ${subject} answered the screenshot request with no picture.`)
                return
            }
            await actions.selectAttachments([pngFile(frame.data, `${source}-screenshot.png`)])
        } catch (failure) {
            report(`The ${subject} could not be captured: ${toGodotError(failure).message}`)
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
                isDisabled: !meta.canAttachImages || isOffline,
                tooltip: captureTooltip(meta.supportsImages, isOffline)
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

function AttachmentDrawer() {
    const {state, actions, meta} = useComposer()
    const [editingId, setEditingId] = useState<string>()
    const editing = state.draftAttachments.find(attachment => attachment.id === editingId)
    return (
        <ChatComposerDrawer>
            <HStack
                gap={2}
                wrap='wrap'
            >
                {state.draftAttachments.map(attachment => (
                    <Thumbnail
                        key={attachment.id}
                        src={attachment.previewUrl}
                        alt={`Attached image: ${attachment.name}`}
                        label={attachment.name}
                        isDisabled={meta.isStreaming || meta.isSavingAttachments}
                        showRemoveOn='always'
                        onClick={() => {
                            setEditingId(attachment.id)
                        }}
                        onRemove={() => {
                            actions.removeAttachment(attachment.id)
                        }}
                    />
                ))}
            </HStack>
            {editing && (
                <ImageScratchpad
                    attachment={editing}
                    onSave={async (file, shapes) => {
                        await actions.editAttachment(editing.id, file, shapes)
                        setEditingId(undefined)
                    }}
                    onClose={() => {
                        setEditingId(undefined)
                    }}
                />
            )}
        </ChatComposerDrawer>
    )
}

function ModelMenu() {
    const {state, actions, meta} = useComposer()
    return (
        <DropdownMenu
            button={{
                label: `Model: ${state.selectedModel}`,
                variant: 'ghost',
                size: 'sm',
                icon: (
                    <Icon
                        icon={SparklesIcon}
                        size='sm'
                        color='secondary'
                    />
                ),
                endContent: (
                    <Icon
                        icon='chevronDown'
                        size='sm'
                        color='secondary'
                    />
                ),
                children: (
                    <Text
                        type='supporting'
                        color='secondary'
                        maxLines={1}
                    >
                        Model: {state.selectedModel}
                    </Text>
                )
            }}
            menuWidth={320}
            items={meta.models.map(model => ({
                label: model.name,
                onClick: () => {
                    void actions.applyModel(model, meta.settings)
                }
            }))}
        />
    )
}

function ReasoningMenu() {
    const {state, actions, meta} = useComposer()
    return (
        <DropdownMenu
            button={{
                label: `Reasoning: ${state.thinkingLevel}`,
                variant: 'ghost',
                size: 'sm',
                icon: (
                    <Icon
                        icon={Cog6ToothIcon}
                        size='sm'
                        color='secondary'
                    />
                ),
                endContent: (
                    <Icon
                        icon='chevronDown'
                        size='sm'
                        color='secondary'
                    />
                ),
                children: (
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        Reasoning: {state.thinkingLevel}
                    </Text>
                )
            }}
            items={meta.thinkingLevels.map(level => ({
                label: level,
                onClick: () => {
                    void actions.applyThinkingLevel(level, meta.settings)
                }
            }))}
        />
    )
}

function ContextUsage() {
    const {state, meta} = useComposer()
    return (
        <HStack
            gap={2}
            width={200}
            vAlign='center'
        >
            <StackItem size='fill'>
                <ProgressBar
                    label='Context usage'
                    value={state.usage.context}
                    max={meta.contextWindow}
                    variant={contextProgressVariant(state.usage.context, meta.contextWindow)}
                    isLabelHidden
                />
            </StackItem>
            <Text
                type='supporting'
                color='secondary'
            >
                {formatContextUsage(state.usage.context, meta.contextWindow)}
            </Text>
        </HStack>
    )
}

function ComposerFooter() {
    const {state} = useComposer()
    return (
        <HStack
            className='composer-footer'
            gap={1}
            paddingInline={2}
            vAlign='center'
            wrap='wrap'
        >
            <ModelMenu />
            <ReasoningMenu />
            <ContextUsage />
            <Text
                type='supporting'
                color='secondary'
            >
                ·
            </Text>
            <Text
                type='supporting'
                color='secondary'
            >
                {state.usage.total.toLocaleString()} tokens
            </Text>
        </HStack>
    )
}

function PlanButton() {
    const {state, actions, meta} = useComposer()
    return (
        <Button
            label='Execute as plan'
            variant='secondary'
            size='md'
            icon={<Icon icon={MapIcon} />}
            isDisabled={meta.isStreaming || meta.isSavingAttachments || !state.draft.trim()}
            tooltip='Read the project and write a specification first. Takes several minutes.'
            clickAction={() => actions.plan(state.draft)}
        />
    )
}

export function WorkspaceComposer() {
    const {state, actions, meta} = useComposer()
    const fileMentions = useFileMentionTrigger()
    const input = useRef<ChatComposerInputHandle>(null)
    const root = useRef<HTMLDivElement | null>(null)
    const appendRef = useComposerAppendRef()

    const correctTheEditableRole = useCallback((node: HTMLDivElement | null) => {
        root.current = node
        node?.querySelector('[role="combobox"]')?.removeAttribute('aria-multiline')
    }, [])

    useEffect(() => {
        if (!appendRef) return
        appendRef.current = (addition, takesCaret) => {
            const handle = input.current
            const editable = root.current?.querySelector<HTMLElement>('[contenteditable="true"]')
            // React nulls a ref before it runs this effect's cleanup, so the caller has to be told
            // the document is gone rather than have its text quietly dropped.
            if (!handle || !editable) return false
            const added = addition(handle.getValue())
            if (added !== undefined) {
                const resume = takesCaret ? undefined : caretNow(editable)
                handle.focus()
                caretToEnd(editable)
                handle.insertText(added)
                editable.dispatchEvent(new Event('input', {bubbles: true}))
                resume?.()
            }
            return true
        }
        return () => {
            appendRef.current = null
        }
    }, [appendRef])

    return (
        <VStack gap={1}>
            <ChatComposer
                value={state.draft}
                onChange={actions.changeDraft}
                onSubmit={value => {
                    void actions.submit(value)
                }}
                onStop={actions.stop}
                isStopShown={meta.isStreaming}
                density='spacious'
                placeholder={
                    meta.isSavingAttachments ? 'Attaching images…'
                    : meta.canQueue ?
                        'Gofer is working — press Enter to queue a message'
                    : meta.isStreaming ?
                        'Gofer is working…'
                    :   'Ask anything'
                }
                drawer={state.draftAttachments.length > 0 ? <AttachmentDrawer /> : undefined}
                headerActions={
                    <>
                        <AttachmentPicker />
                        <GameCapturePicker />
                    </>
                }
                input={
                    <ChatComposerInput
                        ref={correctTheEditableRole}
                        handleRef={input}
                        maxRows={8}
                        style={SPACIOUS_COMPOSER_INPUT_STYLE}
                        triggers={[fileMentions.trigger]}
                        onFiles={files => {
                            const images = imageFiles(files)
                            if (!meta.canAttachImages || images.length === 0) return
                            void actions.selectAttachments(images)
                        }}
                        onPaste={(event, text) => {
                            if (!meta.canAttachImages) return undefined
                            const images = clipboardItemImages(event.clipboardData)
                            if (images.length > 0) {
                                void actions.selectAttachments(images)
                                return true
                            }
                            if (text !== '') return undefined
                            void actions.attachClipboardImage()
                            return true
                        }}
                        hasHistory={false}
                        onKeyDown={event => {
                            fileMentions.onKeyDown(event)
                            if (event.defaultPrevented) return
                            if (event.key !== 'Enter' || event.shiftKey) return
                            // Taking the whole Enter takes the input's own IME guard with it, and
                            // isComposing alone misses the IMEs that only report keyCode 229.
                            if (isImeKeyEvent(event.nativeEvent)) return
                            if (!state.draft.trim() && state.draftAttachments.length === 0) return
                            // The input clears itself the moment it hands the text over, and only
                            // Gofer knows whether that text is being sent or queued. So Gofer owns
                            // the whole Enter, clearing included.
                            event.preventDefault()
                            void actions.submit(state.draft)
                        }}
                    />
                }
                {...(meta.isPlanOffered && {sendActions: <PlanButton />})}
                sendButton={
                    <ChatSendButton
                        isStopShown={meta.isStreaming}
                        isDisabled={
                            meta.isSavingAttachments
                            || (!state.draft.trim() && state.draftAttachments.length === 0)
                        }
                        onSend={() => {
                            void actions.submit(state.draft)
                        }}
                        onStop={actions.stop}
                    />
                }
            />
            {state.streamError === undefined ? null : (
                <Banner
                    status='error'
                    title='Gofer could not do that'
                    description={state.streamError}
                    isDismissable
                    onDismiss={actions.clearError}
                />
            )}
            <ComposerFooter />
        </VStack>
    )
}

export function WorkspaceWelcome({composer}: {composer: React.ReactNode}) {
    return (
        <VStack
            gap={6}
            width='100%'
            maxWidth={720}
        >
            <VStack
                gap={1}
                hAlign='start'
            >
                <HStack
                    gap={2}
                    vAlign='center'
                >
                    <Icon
                        icon={SparklesIcon}
                        size='sm'
                        color='accent'
                    />
                    <Text type='large'>Gofer is ready</Text>
                </HStack>
                <Heading
                    level={1}
                    type='display-2'
                >
                    Where should we start?
                </Heading>
            </VStack>
            {composer}
        </VStack>
    )
}

/**
 * Remembers where the caret and the focus are, for text arriving on its own rather than because
 * the user asked for it. The addition lands past everything already written, so an offset taken
 * before it survives it.
 */
function caretNow(editable: HTMLElement): (() => void) | undefined {
    const focused = document.activeElement
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return undefined
    const range = selection.getRangeAt(0).cloneRange()
    if (!editable.contains(range.startContainer)) return undefined
    return () => {
        selection.removeAllRanges()
        selection.addRange(range)
        if (focused instanceof HTMLElement && focused !== editable) focused.focus()
    }
}

// insertText writes at the live caret and deletes whatever is selected. The addition is measured
// against the end of the document, so the caret has to be there before it lands.
function caretToEnd(editable: HTMLElement) {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(editable)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
}
