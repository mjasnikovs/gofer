import {Suspense, lazy, memo, useEffect, useMemo, useState} from 'react'
import type {RefObject} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {
    ChatMessage,
    ChatMessageBubble,
    ChatMessageList,
    ChatMessageMetadata,
    ChatToolCalls
} from '@astryxdesign/core/Chat'
import {Collapsible} from '@astryxdesign/core/Collapsible'
import {Icon} from '@astryxdesign/core/Icon'
import {Lightbox} from '@astryxdesign/core/Lightbox'
import {Markdown} from '@astryxdesign/core/Markdown'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {Thumbnail} from '@astryxdesign/core/Thumbnail'
import ArrowPathIcon from '@heroicons/react/24/outline/ArrowPathIcon'
import type {
    ChatAttachment,
    Message,
    MessagePart,
    ToolActivity,
    VerifyPoint
} from '../../models/chat'
import {messageParts} from '../../models/chat-timeline'
import {AskBlock} from './AskBlock'

type ChatConversationProps = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    isStreaming: boolean
    messages: readonly Message[]
    scrollRef: RefObject<HTMLElement | null>
    onRetry: (assistantId: number) => void
}>

const SENT_TEXT_STYLE = {whiteSpace: 'pre-wrap'} as const
const CHAT_SCROLL_VIEWPORT_STYLE = {display: 'flex', width: '100%'} as const
const CHAT_MESSAGE_LIST_STYLE = {minWidth: 0, paddingBlockEnd: 'var(--spacing-3)'} as const
const TOOL_ROW_STYLE = {maxWidth: '100%', overflow: 'hidden'} as const
const MESSAGE_HEADING_LEVEL = 3
const ToolOutputCodeBlock = lazy(() =>
    import('@astryxdesign/core/CodeBlock').then(module => ({default: module.CodeBlock}))
)

function runningCallTarget(tool: ToolActivity, now: number | undefined) {
    const named = [tool.target, tool.step].filter(Boolean).join(' · ')
    if (now === undefined) return named || undefined
    const seconds = Math.max(0, Math.round((now - tool.startedAt) / 1000))
    const age = `${String(seconds)}s`
    return named ? `${named} · ${age}` : age
}

function callDuration(tool: ToolActivity) {
    if (tool.endedAt === undefined) return undefined
    const elapsed = `${String(tool.endedAt - tool.startedAt)}ms`
    if (tool.tokens === undefined) return elapsed
    return `${elapsed} · ${tool.tokens.toLocaleString()} tok`
}

function toolOutputCode(tool: ToolActivity, output: string) {
    if (tool.name === 'bash') return {code: output, language: 'bash'}
    try {
        const parsed: unknown = JSON.parse(output)
        if (parsed === null || typeof parsed !== 'object') return {code: output, language: 'text'}
        return {code: JSON.stringify(parsed, null, 2), language: 'json'}
    } catch {
        return {code: output, language: 'text'}
    }
}

type AnsweredOperation = Readonly<{
    op?: string
    result?: unknown
    error?: unknown
    skipped?: string
}>

function answeredOperations(tool: ToolActivity): AnsweredOperation[] | undefined {
    if (!tool.output || !tool.name.startsWith('godot_')) return undefined
    try {
        const parsed: unknown = JSON.parse(tool.output)
        if (parsed === null || typeof parsed !== 'object') return undefined
        const {ops} = parsed as {ops?: unknown}
        return Array.isArray(ops) && ops.length > 1 ? (ops as AnsweredOperation[]) : undefined
    } catch {
        return undefined
    }
}

function operationStatus(entry: AnsweredOperation) {
    if (entry.error !== undefined) return 'error' as const
    if (entry.skipped !== undefined) return 'pending' as const
    return 'complete' as const
}

const ToolCallRow = memo(({now, tool}: {now?: number | undefined; tool: ToolActivity}) => {
    const duration = callDuration(tool)
    const detailOf = (output: string) => (
        <Suspense fallback={<Text>{output}</Text>}>
            <ToolOutputCodeBlock {...toolOutputCode(tool, output)} />
        </Suspense>
    )
    const answered = answeredOperations(tool)
    if (answered) {
        const summary = [tool.name, tool.target, duration].filter(Boolean).join(' · ')
        return (
            <ChatToolCalls
                style={TOOL_ROW_STYLE}
                label={summary}
                calls={answered.map((entry, index) => ({
                    key: `${tool.id}-${String(index)}`,
                    name: entry.op ?? tool.name,
                    status: operationStatus(entry),
                    ...(entry.skipped !== undefined && {target: entry.skipped}),
                    resultDetail: detailOf(JSON.stringify(entry.result ?? entry.error ?? {}))
                }))}
            />
        )
    }
    const target = runningCallTarget(tool, now)
    return (
        <ChatToolCalls
            style={TOOL_ROW_STYLE}
            calls={[
                {
                    key: tool.id,
                    name: tool.name,
                    status: tool.status,
                    ...(target !== undefined && target !== '' && {target}),
                    ...(duration !== undefined && {duration}),
                    ...(tool.status === 'error' && tool.output && {errorMessage: tool.output}),
                    ...(tool.output && {resultDetail: detailOf(tool.output)})
                }
            ]}
        />
    )
})
ToolCallRow.displayName = 'ToolCallRow'

const VerifyPointsRow = memo(({points}: {points: readonly VerifyPoint[]}) => {
    const failed = points.filter(point => point.status === 'error').length
    const settled = points.filter(point => point.status !== 'running').length
    const label =
        settled < points.length ? `Verifying ${String(settled + 1)} of ${String(points.length)}`
        : failed > 0 ? `Verification failed — ${String(failed)} of ${String(points.length)}`
        : `Verified — ${String(points.length)} of ${String(points.length)}`
    return (
        <VStack gap={1}>
            <Text type={failed > 0 ? 'label' : 'supporting'}>{label}</Text>
            <ChatToolCalls
                style={TOOL_ROW_STYLE}
                defaultIsExpanded={failed > 0}
                calls={points.map(point => ({
                    key: point.name,
                    name: point.name,
                    status: point.status,
                    target: point.command,
                    ...(point.status === 'error' && point.output && {errorMessage: point.output})
                }))}
            />
        </VStack>
    )
})
VerifyPointsRow.displayName = 'VerifyPointsRow'

type ProseBubbleProps = Readonly<{
    isReasoning: boolean
    isStreaming: boolean
    text: string
}>

const THINKING_LABEL = (
    <Text
        type='supporting'
        color='secondary'
    >
        Thinking
    </Text>
)

const ProseBubble = memo(({isReasoning, isStreaming, text}: ProseBubbleProps) => {
    const [chosen, setChosen] = useState<boolean | null>(null)
    const prose = (
        <ChatMessageBubble variant='ghost'>
            <Markdown
                density={isReasoning ? 'compact' : 'default'}
                headingLevelStart={MESSAGE_HEADING_LEVEL}
                isStreaming={isStreaming}
            >
                {text}
            </Markdown>
        </ChatMessageBubble>
    )
    if (!isReasoning) return prose
    return (
        <Collapsible
            isOpen={chosen ?? isStreaming}
            trigger={THINKING_LABEL}
            onOpenChange={setChosen}
        >
            {prose}
        </Collapsible>
    )
})
ProseBubble.displayName = 'ProseBubble'

type MessageMetadataProps = Readonly<{
    isLast: boolean
    message: Message
    onRetry: (assistantId: number) => void
}>

function AssistantMetadata({isLast, message, onRetry}: MessageMetadataProps) {
    return (
        <ChatMessageMetadata
            {...(message.status === 'error' && {status: 'error'})}
            footer={
                <HStack
                    gap={2}
                    vAlign='center'
                >
                    {message.usage ?
                        <Text
                            type='supporting'
                            color='secondary'
                        >
                            {message.usage.input.toLocaleString()} in ·{' '}
                            {message.usage.output.toLocaleString()} out
                            {message.usage.reasoning !== undefined
                                && ` · ${message.usage.reasoning.toLocaleString()} reasoning`}
                        </Text>
                    :   null}
                    {isLast && (message.status === 'error' || message.status === 'aborted') ?
                        <Button
                            label='Retry'
                            variant='ghost'
                            size='sm'
                            icon={
                                <Icon
                                    icon={ArrowPathIcon}
                                    size='sm'
                                />
                            }
                            clickAction={() => {
                                onRetry(message.id)
                            }}
                        />
                    :   null}
                </HStack>
            }
        />
    )
}

function useRunningCallClock(isRunning: boolean) {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!isRunning) return
        const timer = setInterval(() => {
            setNow(Date.now())
        }, 1000)
        return () => {
            clearInterval(timer)
        }
    }, [isRunning])
    return isRunning ? now : undefined
}

function AssistantTimeline({message}: {message: Message}) {
    const parts = messageParts(message)
    const toolsById = useMemo(
        () => new Map((message.tools ?? []).map(tool => [tool.id, tool] as const)),
        [message.tools]
    )
    const isStreaming = message.status === 'streaming'
    const isCallRunning = (message.tools ?? []).some(
        tool => tool.status === 'running' || tool.status === 'pending'
    )
    const now = useRunningCallClock(isCallRunning)
    return (
        <>
            {parts.map((part: MessagePart, index) => {
                if (part.kind === 'tool') {
                    const tool = toolsById.get(part.toolId)
                    if (!tool) return null
                    if (tool.name === 'ask_user')
                        return (
                            <AskBlock
                                key={`tool-${part.toolId}`}
                                tool={tool}
                            />
                        )
                    return (
                        <ToolCallRow
                            key={`tool-${part.toolId}`}
                            now={tool.endedAt === undefined ? now : undefined}
                            tool={tool}
                        />
                    )
                }
                return (
                    <ProseBubble
                        key={`prose-${String(index)}`}
                        isReasoning={part.kind === 'thinking'}
                        isStreaming={isStreaming && index === parts.length - 1}
                        text={part.text}
                    />
                )
            })}
            {message.verifyPoints && message.verifyPoints.length > 0 ?
                <VerifyPointsRow points={message.verifyPoints} />
            :   null}
            {isStreaming && !isCallRunning ?
                <ChatMessageBubble variant='ghost'>
                    <HStack
                        gap={1.5}
                        vAlign='center'
                    >
                        <Spinner
                            size='sm'
                            shade='subtle'
                            aria-label={message.activity ?? 'Working'}
                        />
                        <Text
                            aria-hidden
                            type='supporting'
                        >
                            {message.activity ?? 'Working'}
                        </Text>
                    </HStack>
                </ChatMessageBubble>
            :   null}
        </>
    )
}

type MessageAttachmentsProps = Readonly<{
    attachments: readonly ChatAttachment[]
    previews: Readonly<Record<string, string>>
}>

function MessageAttachments({attachments, previews}: MessageAttachmentsProps) {
    const [viewing, setViewing] = useState<number>()
    const viewable = useMemo(
        () =>
            attachments.flatMap(attachment => {
                const src = previews[attachment.id]
                return src === undefined ? [] : [{attachment, src}]
            }),
        [attachments, previews]
    )

    return (
        <>
            <HStack
                gap={2}
                wrap='wrap'
            >
                {attachments.map(attachment => {
                    const index = viewable.findIndex(item => item.attachment.id === attachment.id)
                    const src = previews[attachment.id]
                    return (
                        <Thumbnail
                            key={attachment.id}
                            alt={`Attached image: ${attachment.name}`}
                            label={attachment.name}
                            {...(src !== undefined && {src})}
                            {...(index >= 0 && {
                                onClick: () => {
                                    setViewing(index)
                                }
                            })}
                        />
                    )
                })}
            </HStack>
            {viewing !== undefined && (
                <Lightbox
                    isOpen
                    index={viewing}
                    hasZoom
                    media={viewable.map(({attachment, src}) => ({
                        src,
                        alt: `Attached image: ${attachment.name}`,
                        caption: attachment.name
                    }))}
                    onIndexChange={setViewing}
                    onOpenChange={next => {
                        if (!next) setViewing(undefined)
                    }}
                />
            )}
        </>
    )
}

type ConversationMessageProps = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    isLast: boolean
    message: Message
    onRetry: (assistantId: number) => void
}>

const ConversationMessage = memo(
    ({attachmentPreviews, isLast, message, onRetry}: ConversationMessageProps) => {
        if (message.sender === 'assistant') {
            return (
                <ChatMessage
                    sender='assistant'
                    {...(message.status !== 'streaming' && {
                        metadata: (
                            <AssistantMetadata
                                isLast={isLast}
                                message={message}
                                onRetry={onRetry}
                            />
                        )
                    })}
                >
                    <AssistantTimeline message={message} />
                </ChatMessage>
            )
        }
        return (
            <ChatMessage sender='user'>
                <ChatMessageBubble variant='filled'>
                    <VStack
                        gap={2}
                        hAlign='start'
                    >
                        {message.attachments?.length ?
                            <MessageAttachments
                                attachments={message.attachments}
                                previews={attachmentPreviews}
                            />
                        :   null}
                        {message.text ?
                            <Text
                                type='body'
                                style={SENT_TEXT_STYLE}
                            >
                                {message.text}
                            </Text>
                        :   null}
                    </VStack>
                </ChatMessageBubble>
            </ChatMessage>
        )
    }
)
ConversationMessage.displayName = 'ConversationMessage'

export function ChatConversation({
    attachmentPreviews,
    isStreaming,
    messages,
    scrollRef,
    onRetry
}: ChatConversationProps) {
    return (
        <StackItem
            ref={scrollRef}
            size='fill'
            isScrollable
            style={CHAT_SCROLL_VIEWPORT_STYLE}
        >
            <ChatMessageList
                density='spacious'
                isStreaming={isStreaming}
                style={CHAT_MESSAGE_LIST_STYLE}
            >
                {messages.map((message, index) => (
                    <ConversationMessage
                        key={message.id}
                        attachmentPreviews={attachmentPreviews}
                        isLast={index === messages.length - 1}
                        message={message}
                        onRetry={onRetry}
                    />
                ))}
            </ChatMessageList>
        </StackItem>
    )
}
