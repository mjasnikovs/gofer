import {Suspense, lazy} from 'react'
import type {RefObject} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {
    ChatMessage,
    ChatMessageBubble,
    ChatMessageList,
    ChatMessageMetadata,
    ChatToolCalls
} from '@astryxdesign/core/Chat'
import {Icon} from '@astryxdesign/core/Icon'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {Thumbnail} from '@astryxdesign/core/Thumbnail'
import ArrowPathIcon from '@heroicons/react/24/outline/ArrowPathIcon'
import type {Message} from '../../models/chat'

type ChatConversationProps = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    isStreaming: boolean
    messages: readonly Message[]
    scrollRef: RefObject<HTMLElement | null>
    onRetry: (assistantId: number) => void
}>

const LEFT_ALIGNED_USER_BUBBLE_STYLE = {alignSelf: 'flex-start'} as const
// The conversation sits in a centre-aligned column: without an explicit width it
// would shrink to the widest message and grow as the reply streams in.
const CHAT_SCROLL_VIEWPORT_STYLE = {display: 'flex', width: '100%'} as const
const ToolOutputCodeBlock = lazy(() =>
    import('@astryxdesign/core/CodeBlock').then(module => ({default: module.CodeBlock}))
)

function AssistantToolCalls({message}: {message: Message}) {
    if (!message.tools?.length) return null
    return (
        <ChatToolCalls
            calls={message.tools.map(tool => ({
                key: tool.id,
                name: tool.name,
                status: tool.status,
                ...(tool.target && {target: tool.target}),
                ...(tool.endedAt && {duration: `${String(tool.endedAt - tool.startedAt)}ms`}),
                ...(tool.status === 'error' && tool.output && {errorMessage: tool.output}),
                ...(tool.output && {
                    resultDetail: (
                        <Suspense fallback={<Text>{tool.output}</Text>}>
                            <ToolOutputCodeBlock
                                code={tool.output}
                                language={tool.name === 'bash' ? 'bash' : 'text'}
                            />
                        </Suspense>
                    )
                })
            }))}
        />
    )
}

type MessageMetadataProps = Readonly<{
    message: Message
    onRetry: (assistantId: number) => void
}>

function AssistantMetadata({message, onRetry}: MessageMetadataProps) {
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
                    {message.status === 'error' || message.status === 'aborted' ?
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

type ConversationMessageProps = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    message: Message
    onRetry: (assistantId: number) => void
}>

function ConversationMessage({attachmentPreviews, message, onRetry}: ConversationMessageProps) {
    const isAssistant = message.sender === 'assistant'
    return (
        <ChatMessage sender={message.sender}>
            {isAssistant ?
                <AssistantToolCalls message={message} />
            :   null}
            {isAssistant && message.thinking ?
                <ChatMessageBubble
                    variant='ghost'
                    name='Reasoning'
                >
                    <Text color='secondary'>{message.thinking}</Text>
                </ChatMessageBubble>
            :   null}
            <ChatMessageBubble
                variant={isAssistant ? 'ghost' : 'filled'}
                style={isAssistant ? undefined : LEFT_ALIGNED_USER_BUBBLE_STYLE}
                metadata={
                    isAssistant ?
                        <AssistantMetadata
                            message={message}
                            onRetry={onRetry}
                        />
                    :   undefined
                }
            >
                <VStack
                    gap={2}
                    hAlign='start'
                >
                    {message.attachments?.length ?
                        <HStack
                            gap={2}
                            wrap='wrap'
                        >
                            {message.attachments.map(attachment => (
                                <Thumbnail
                                    key={attachment.id}
                                    alt={`Attached image: ${attachment.name}`}
                                    label={attachment.name}
                                    {...(attachmentPreviews[attachment.id] && {
                                        src: attachmentPreviews[attachment.id]
                                    })}
                                />
                            ))}
                        </HStack>
                    :   null}
                    {message.text ?
                        <Text>{message.text}</Text>
                    : isAssistant ?
                        <Spinner
                            size='sm'
                            label='Generating response'
                        />
                    :   null}
                </VStack>
            </ChatMessageBubble>
        </ChatMessage>
    )
}

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
            >
                {messages.map(message => (
                    <ConversationMessage
                        key={message.id}
                        attachmentPreviews={attachmentPreviews}
                        message={message}
                        onRetry={onRetry}
                    />
                ))}
            </ChatMessageList>
        </StackItem>
    )
}
