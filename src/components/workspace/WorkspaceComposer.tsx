import {useRef} from 'react'
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
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import PhotoIcon from '@heroicons/react/24/outline/PhotoIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import {contextProgressVariant, formatContextUsage} from '../../utils/chat-format'
import {useComposer} from '../../hooks/useComposer'

const CHAT_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const SPACIOUS_COMPOSER_INPUT_STYLE = {
    minHeight: 'calc(var(--spacing-12) + var(--spacing-10))'
} as const

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

function AttachmentDrawer() {
    const {state, actions, meta} = useComposer()
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
                        onRemove={() => {
                            actions.removeAttachment(attachment.id)
                        }}
                    />
                ))}
            </HStack>
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

export function WorkspaceComposer() {
    const {state, actions, meta} = useComposer()
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
                headerActions={<AttachmentPicker />}
                input={
                    <ChatComposerInput
                        maxRows={8}
                        style={SPACIOUS_COMPOSER_INPUT_STYLE}
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
