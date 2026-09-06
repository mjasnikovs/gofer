import {useRef} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {ChatComposer, ChatComposerDrawer, ChatSendButton} from '@astryxdesign/core/Chat'
import type {ChatComposerInputHandle} from '@astryxdesign/core/Chat'
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu'
import {Icon} from '@astryxdesign/core/Icon'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import MapIcon from '@heroicons/react/24/outline/MapIcon'
import ArrowsPointingInIcon from '@heroicons/react/24/outline/ArrowsPointingInIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import {AttachmentPicker, AttachmentThumbnails, GameCapturePicker} from './AttachmentControls'
import {clipboardItemImages, imageFiles} from '../../utils/chat-images'
import {TextField} from '../TextField'
import {contextProgressVariant, formatContextUsage} from '../../utils/chat-format'
import {useComposer} from '../../hooks/useComposer'
import {useAppendTarget} from '../../hooks/useAppendTarget'
import {useCompactCommandTrigger} from '../../hooks/useCompactCommandTrigger'
import {useFileMentionTrigger} from '../../hooks/useFileMentionTrigger'
import {useWorkspaceFailure} from '../../hooks/useWorkspaceFailure'

const SPACIOUS_COMPOSER_INPUT_STYLE = {
    minHeight: 'calc(var(--spacing-12) + var(--spacing-10))'
} as const

function AttachmentDrawer() {
    const {state, actions, meta} = useComposer()
    return (
        <ChatComposerDrawer>
            <AttachmentThumbnails
                attachments={state.draftAttachments}
                isDisabled={meta.isStreaming || meta.isSavingAttachments}
                onEdit={actions.editAttachment}
                onRemove={actions.removeAttachment}
            />
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

function CompactButton() {
    const {actions, meta} = useComposer()
    return (
        <Button
            label='Compact'
            variant='ghost'
            size='sm'
            isIconOnly
            icon={<Icon icon={ArrowsPointingInIcon} />}
            isDisabled={!meta.canCompact}
            tooltip={
                meta.isStreaming ?
                    'Gofer is working. Compact once the turn ends.'
                :   'Summarise the older messages to free context'
            }
            onClick={() => {
                void actions.compact()
            }}
        />
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
            <CompactButton />
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
    const report = useWorkspaceFailure()
    const fileMentions = useFileMentionTrigger()
    const compactCommand = useCompactCommandTrigger()
    const input = useRef<ChatComposerInputHandle>(null)
    const keepRoot = useAppendTarget(input)

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
                        <AttachmentPicker
                            canAttach={meta.canAttachImages}
                            supportsImages={meta.supportsImages}
                            onSelect={files => {
                                void actions.selectAttachments(files)
                            }}
                        />
                        <GameCapturePicker
                            canAttach={meta.canAttachImages}
                            supportsImages={meta.supportsImages}
                            onSelect={files => {
                                void actions.selectAttachments(files)
                            }}
                            onError={report}
                        />
                    </>
                }
                input={
                    <TextField
                        kind='rich'
                        label='Message input'
                        value={state.draft}
                        onChange={actions.changeDraft}
                        rootRef={keepRoot}
                        handleRef={input}
                        maxRows={8}
                        style={SPACIOUS_COMPOSER_INPUT_STYLE}
                        triggers={[fileMentions.trigger, compactCommand]}
                        canSubmit={state.draft.trim() !== '' || state.draftAttachments.length > 0}
                        onKeyDown={fileMentions.onKeyDown}
                        onSubmit={() => {
                            void actions.submit(state.draft)
                        }}
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
