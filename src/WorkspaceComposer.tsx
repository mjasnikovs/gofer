import type {RefObject} from 'react'
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
import {contextProgressVariant, formatContextUsage} from './chat-format'
import type {DraftAttachment} from './chat-models'
import type {AiModelOption, GoferSettings, ThinkingLevel} from './settings-models'

type TokenCounts = Readonly<{
    context: number
    total: number
}>

type WorkspaceComposerProps = Readonly<{
    attachmentInputRef: RefObject<HTMLInputElement | null>
    canAttachImages: boolean
    contextWindow: number
    draft: string
    draftAttachments: readonly DraftAttachment[]
    isSavingAttachments: boolean
    isStreaming: boolean
    models: readonly AiModelOption[]
    selectedModel: string
    settings?: GoferSettings
    streamError?: string
    supportsImages: boolean
    thinkingLevel: ThinkingLevel
    thinkingLevels: readonly ThinkingLevel[]
    usage: TokenCounts
    onApplyModel: (model: AiModelOption, previous?: GoferSettings) => Promise<void>
    onApplyThinkingLevel: (level: ThinkingLevel, previous?: GoferSettings) => Promise<void>
    onChangeDraft: (value: string) => void
    onRemoveAttachment: (attachmentId: string) => void
    onSelectAttachments: (files: FileList | null) => Promise<void>
    onStop: () => void
    onSubmit: (value: string) => Promise<void>
}>

const CHAT_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const SPACIOUS_COMPOSER_INPUT_STYLE = {
    minHeight: 'calc(var(--spacing-12) + var(--spacing-10))'
} as const

export function WorkspaceComposer({
    attachmentInputRef,
    canAttachImages,
    contextWindow,
    draft,
    draftAttachments,
    isSavingAttachments,
    isStreaming,
    models,
    selectedModel,
    settings,
    streamError,
    supportsImages,
    thinkingLevel,
    thinkingLevels,
    usage,
    onApplyModel,
    onApplyThinkingLevel,
    onChangeDraft,
    onRemoveAttachment,
    onSelectAttachments,
    onStop,
    onSubmit
}: WorkspaceComposerProps) {
    return (
        <VStack gap={1}>
            <input
                ref={attachmentInputRef}
                type='file'
                accept={CHAT_ATTACHMENT_ACCEPT}
                multiple
                hidden
                onChange={event => {
                    void onSelectAttachments(event.currentTarget.files)
                }}
            />
            <ChatComposer
                value={draft}
                onChange={onChangeDraft}
                onSubmit={value => {
                    void onSubmit(value)
                }}
                onStop={onStop}
                isStopShown={isStreaming}
                density='spacious'
                placeholder={
                    isSavingAttachments ? 'Attaching images…'
                    : isStreaming ?
                        'Gofer is working…'
                    :   'Ask anything'
                }
                drawer={
                    draftAttachments.length > 0 ?
                        <ChatComposerDrawer>
                            <HStack
                                gap={2}
                                wrap='wrap'
                            >
                                {draftAttachments.map(attachment => (
                                    <Thumbnail
                                        key={attachment.id}
                                        src={attachment.previewUrl}
                                        alt={`Attached image: ${attachment.name}`}
                                        label={attachment.name}
                                        isDisabled={isStreaming || isSavingAttachments}
                                        showRemoveOn='always'
                                        onRemove={() => {
                                            onRemoveAttachment(attachment.id)
                                        }}
                                    />
                                ))}
                            </HStack>
                        </ChatComposerDrawer>
                    :   undefined
                }
                headerActions={
                    <Button
                        label='Attach images'
                        variant='ghost'
                        size='sm'
                        isIconOnly
                        icon={<Icon icon={PhotoIcon} />}
                        isDisabled={!canAttachImages}
                        tooltip={
                            supportsImages ? 'Attach up to 5 images' : (
                                'The selected model does not support image input'
                            )
                        }
                        onClick={() => {
                            attachmentInputRef.current?.click()
                        }}
                    />
                }
                input={
                    <ChatComposerInput
                        maxRows={8}
                        style={SPACIOUS_COMPOSER_INPUT_STYLE}
                        onKeyDown={event => {
                            if (
                                event.key !== 'Enter'
                                || event.shiftKey
                                || draft.trim()
                                || draftAttachments.length === 0
                                || event.nativeEvent.isComposing
                            )
                                return
                            event.preventDefault()
                            void onSubmit('')
                        }}
                    />
                }
                sendButton={
                    <ChatSendButton
                        isStopShown={isStreaming}
                        isDisabled={
                            isSavingAttachments || (!draft.trim() && draftAttachments.length === 0)
                        }
                        onSend={() => {
                            void onSubmit(draft)
                        }}
                        onStop={onStop}
                    />
                }
                {...(streamError && {status: {type: 'error' as const, message: streamError}})}
            />
            <HStack
                gap={1}
                paddingInline={2}
                vAlign='center'
            >
                <DropdownMenu
                    button={{
                        label: `Model: ${selectedModel}`,
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
                                Model: {selectedModel}
                            </Text>
                        )
                    }}
                    menuWidth={320}
                    items={models.map(model => ({
                        label: model.name,
                        onClick: () => {
                            void onApplyModel(model, settings)
                        }
                    }))}
                />
                <DropdownMenu
                    button={{
                        label: `Reasoning: ${thinkingLevel}`,
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
                                Reasoning: {thinkingLevel}
                            </Text>
                        )
                    }}
                    items={thinkingLevels.map(level => ({
                        label: level,
                        onClick: () => {
                            void onApplyThinkingLevel(level, settings)
                        }
                    }))}
                />
                <HStack
                    gap={2}
                    width={200}
                    vAlign='center'
                >
                    <StackItem size='fill'>
                        <ProgressBar
                            label='Context usage'
                            value={usage.context}
                            max={contextWindow}
                            variant={contextProgressVariant(usage.context, contextWindow)}
                            isLabelHidden
                        />
                    </StackItem>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {formatContextUsage(usage.context, contextWindow)}
                    </Text>
                </HStack>
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
                    {usage.total.toLocaleString()} tokens
                </Text>
            </HStack>
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
