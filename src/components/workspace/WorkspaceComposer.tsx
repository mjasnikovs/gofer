import {useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {
    ChatComposer,
    ChatComposerDrawer,
    ChatComposerInput,
    ChatSendButton
} from '@astryxdesign/core/Chat'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {Icon} from '@astryxdesign/core/Icon'
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
import {useEditorSession} from '../../hooks/useEditorSession'
import {useFileMentionTrigger} from '../../hooks/useFileMentionTrigger'
import {useWorkspaceFailure} from '../../hooks/useWorkspaceFailure'
import {pngFile} from '../../services/chat-storage'
import {toGodotError} from '../../services/godot-session'
import {isSessionPlaying} from '../../models/godot'

const CHAT_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const SPACIOUS_COMPOSER_INPUT_STYLE = {
    minHeight: 'calc(var(--spacing-12) + var(--spacing-10))'
} as const

/**
 * The images among dropped or pasted files, each one sure to have a name.
 *
 * A copied screenshot arrives with an empty name, and the drawer labels a thumbnail by its name, so
 * one would sit there blank. The type's own extension is the closest thing to a name it has.
 */
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

/**
 * The images on a clipboard that carried no files.
 *
 * The input reads `clipboardData.files` itself and hands those to `onFiles`, so this is only
 * reached when that list was empty — which is what a capture tool that offers its image as an item
 * and nothing else leaves behind.
 */
function clipboardItemImages(clipboard: DataTransfer): readonly File[] {
    return imageFiles(
        Array.from(clipboard.items)
            .filter(item => item.kind === 'file')
            .map(item => item.getAsFile())
            .filter((file): file is File => file !== null)
    )
}

/**
 * The file picker, which Astryx has no equivalent for: `<input type='file'>` is the only element
 * that opens the browser's own dialog, and it has to be a raw one.
 */
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
                    // The same file picked twice in a row fires no change event unless the value is
                    // cleared, and it cannot be cleared until the read has finished with it.
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

/**
 * Why the screenshot control is not offered, or what it does when it is.
 *
 * A disabled control that does not say why is a control the user presses twice and then gives up
 * on, and there are three separate reasons this one goes grey. The model comes first: a model that
 * cannot read images makes the running game beside the point.
 */
function captureTooltip(supportsImages: boolean, isPlaying: boolean): string {
    if (!supportsImages) return 'The selected model does not support image input'
    if (!isPlaying) return 'The game is not running. Run it, then take a screenshot of it.'
    return 'Attach a screenshot of the running game'
}

/**
 * Attaches a picture of the running game, taken by the game itself.
 *
 * The same frame the Game tab draws, put into the draft instead of onto the screen — a screenshot
 * ends up in a message because the user wants to ask about what is on it, and taking it by hand
 * meant leaving the window and coming back with a file.
 *
 * Only a running game can be photographed. `runtime.capture` is forwarded to the helper autoload
 * inside the game process, which is not there to answer when no game is running, so the control is
 * disabled on the editor's own play state rather than offering a press that can only fail.
 */
function GameCapturePicker() {
    const {actions, meta} = useComposer()
    const {call, state} = useEditorSession()
    const report = useWorkspaceFailure()
    const isPlaying = isSessionPlaying(state)
    return (
        <Button
            label='Attach a game screenshot'
            variant='ghost'
            size='sm'
            isIconOnly
            icon={<Icon icon={CameraIcon} />}
            isDisabled={!meta.canAttachImages || !isPlaying}
            tooltip={captureTooltip(meta.supportsImages, isPlaying)}
            clickAction={async () => {
                try {
                    const {frame} = await call('runtime.capture')
                    if (!frame) {
                        report('The game answered the screenshot request with no picture.')
                        return
                    }
                    await actions.selectAttachments([pngFile(frame.data, 'game-screenshot.png')])
                } catch (failure) {
                    report(`The game could not be captured: ${toGodotError(failure).message}`)
                }
            }}
        />
    )
}

/**
 * The attached images, each one a door into the scratchpad.
 *
 * Pressing a thumbnail opens it to be drawn on. Capture stays one press for the user who only wants
 * to send the frame, and every image gets the same door whether it was captured, pasted or picked.
 */
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

/**
 * The row under the input.
 *
 * It wraps: the chat column is narrower than the welcome block the same composer renders in, and
 * held on one line the reasoning menu's chevron was cut in half by the column's right edge.
 */
function ComposerFooter() {
    const {state} = useComposer()
    return (
        <HStack
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

/**
 * Plans the first message instead of sending it.
 *
 * Offered beside Send and only there, because that is the one moment the choice exists: planning
 * reads the project and writes a specification for the agent to work from, and it can only do that
 * before there is a conversation to work from instead. Pressing Send is the other answer to the same
 * question, so either press takes the control away — a task gets one opening move, not two.
 *
 * `secondary`, because Send is the primary action here and stays it. The plan is the longer road and
 * the user has to mean it; nothing about the screen should make it the press they fall into.
 */
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
            // `clickAction`, not `onClick`: planning takes minutes, so a button that gave no pending
            // state stayed clickable while the plan was already running. `clickAction` is the prop
            // that awaits the promise and disables for its duration.
            clickAction={() => actions.plan(state.draft)}
        />
    )
}

/**
 * One attribute corrected on Astryx's own editable element, because a trigger changes its role.
 *
 * `ChatComposerInput` writes `aria-multiline="true"` on the editable and then, when it is given
 * triggers, spreads `role="combobox"` over the top of it (`ChatComposerInput.tsx`). ARIA does not
 * allow `aria-multiline` on a combobox, so axe reports it as a critical violation on every screen
 * that draws the composer, and `stableScreenshot` fails the visual suite on it. There is no prop
 * for it — the attribute is a literal in the component — so it comes off here. The composer is
 * still multi-line; the attribute was only ever restating what `contenteditable` already provides.
 */
function correctTheEditableRole(root: HTMLDivElement | null) {
    root?.querySelector('[role="combobox"]')?.removeAttribute('aria-multiline')
}

export function WorkspaceComposer() {
    const {state, actions, meta} = useComposer()
    const fileMentions = useFileMentionTrigger()
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
                        maxRows={8}
                        style={SPACIOUS_COMPOSER_INPUT_STYLE}
                        triggers={[fileMentions]}
                        onFiles={files => {
                            const images = imageFiles(files)
                            if (!meta.canAttachImages || images.length === 0) return
                            void actions.selectAttachments(images)
                        }}
                        onPaste={(event, text) => {
                            // A paste holding no image is left to the input: returning nothing is
                            // what inserts the text.
                            if (!meta.canAttachImages) return undefined
                            const images = clipboardItemImages(event.clipboardData)
                            if (images.length > 0) {
                                void actions.selectAttachments(images)
                                return true
                            }
                            /*
                             * An empty paste is the shape an image takes here: WebKitGTK hands the
                             * event no files, no items and no text when the clipboard holds one, so
                             * the image has to be asked for. Text still arrives as text, which is
                             * what separates the two.
                             */
                            if (text !== '') return undefined
                            void actions.attachClipboardImage()
                            return true
                        }}
                        onKeyDown={event => {
                            if (
                                event.key !== 'Enter'
                                || event.shiftKey
                                || state.draft.trim()
                                || state.draftAttachments.length === 0
                                || event.nativeEvent.isComposing
                            )
                                return
                            event.preventDefault()
                            void actions.submit('')
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
                {...(state.streamError && {
                    status: {type: 'error' as const, message: state.streamError}
                })}
            />
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
