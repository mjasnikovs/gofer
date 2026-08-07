import {Suspense, lazy, memo, useMemo} from 'react'
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
import {Markdown} from '@astryxdesign/core/Markdown'
import {Spinner} from '@astryxdesign/core/Spinner'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {Thumbnail} from '@astryxdesign/core/Thumbnail'
import ArrowPathIcon from '@heroicons/react/24/outline/ArrowPathIcon'
import type {Message, MessagePart, ToolActivity} from '../../models/chat'
import {messageParts} from '../../models/chat-timeline'

type ChatConversationProps = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    isStreaming: boolean
    messages: readonly Message[]
    scrollRef: RefObject<HTMLElement | null>
    onRetry: (assistantId: number) => void
}>

/*
 * Gofer's conversation is one left-aligned column, and `ChatMessage sender='user'` lays its bubble
 * out on the right. Neither `ChatMessage` nor `ChatMessageBubble` takes an alignment prop
 * (`npm run astryx -- component ChatMessage`), so the override stays until one of them does.
 */
const LEFT_ALIGNED_USER_BUBBLE_STYLE = {alignSelf: 'flex-start'} as const
// The conversation sits in a centre-aligned column: without an explicit width it
// would shrink to the widest message and grow as the reply streams in.
const CHAT_SCROLL_VIEWPORT_STYLE = {display: 'flex', width: '100%'} as const
/*
 * A conversation is a column and never scrolls sideways, which takes both of these.
 *
 * A tool call's target is one long unbreakable line — a shell command, a resource path — and
 * `ChatToolCalls` is ready for that: its target has `text-overflow: ellipsis` already. That only
 * engages once the row has a width to be too wide for, and nothing above it had one. The list is
 * the scroll viewport's flex child, so `min-width` frees it from its own content, and the cap on
 * each block of calls is what finally hands the row a limit. Measured: without the pair, one 75
 * character target grew the whole list from 358px to 623px and put every message in the
 * conversation behind a horizontal scrollbar.
 */
const CHAT_MESSAGE_LIST_STYLE = {minWidth: 0} as const
const TOOL_ROW_STYLE = {maxWidth: '100%', overflow: 'hidden'} as const
/**
 * A reply's `#` is a heading inside a bubble inside a panel, not a heading for the window. Left at
 * the default it would outrank the task title above it and render at page scale in a column a third
 * of the window wide.
 */
const MESSAGE_HEADING_LEVEL = 3
const ToolOutputCodeBlock = lazy(() =>
    import('@astryxdesign/core/CodeBlock').then(module => ({default: module.CodeBlock}))
)

/**
 * One tool call, on its own row where the turn made it.
 *
 * `ChatToolCalls` given a single call draws exactly that row and given several collapses them into
 * one summary (`npm run astryx -- component ChatToolCalls`), so a turn's calls are passed one at a
 * time: eighty-eight of them are eighty-eight readable rows in order, not one badge saying 88.
 */
const ToolCallRow = memo(({tool}: {tool: ToolActivity}) => (
    <ChatToolCalls
        style={TOOL_ROW_STYLE}
        calls={[
            {
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
            }
        ]}
    />
))
ToolCallRow.displayName = 'ToolCallRow'

type ProseBubbleProps = Readonly<{
    isReasoning: boolean
    isStreaming: boolean
    text: string
}>

/**
 * One stretch of what the agent wrote, rendered as Markdown.
 *
 * The model answers in Markdown — headings, lists, fenced code — and a plain `Text` node printed all
 * of it as one unbroken paragraph. `isStreaming` is set only on the stretch still growing, which is
 * what switches `Markdown` to incremental parsing.
 */
const ProseBubble = memo(({isReasoning, isStreaming, text}: ProseBubbleProps) => (
    <ChatMessageBubble
        variant='ghost'
        {...(isReasoning && {name: 'Reasoning'})}
    >
        <Markdown
            density={isReasoning ? 'compact' : 'default'}
            headingLevelStart={MESSAGE_HEADING_LEVEL}
            isStreaming={isStreaming}
        >
            {text}
        </Markdown>
    </ChatMessageBubble>
))
ProseBubble.displayName = 'ProseBubble'

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

/**
 * The turn as it happened: write, call a tool, write again, each step its own row.
 *
 * Parts are keyed by index because the list only ever appends, or grows its own last entry — no
 * part is ever inserted, removed, or moved, so an index names the same step for the whole turn.
 */
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
    return (
        <>
            {parts.map((part: MessagePart, index) => {
                if (part.kind === 'tool') {
                    const tool = toolsById.get(part.toolId)
                    // A part naming a call the message no longer carries would render an empty row;
                    // there is nothing to show, so it shows nothing.
                    if (!tool) return null
                    return (
                        <ToolCallRow
                            key={`tool-${part.toolId}`}
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
            {/*
             * The turn's indicator, for the stretches where no call is carrying one.
             *
             * A turn goes quiet between its steps — it finishes a sentence, then spends a long time
             * deciding what to call next — and a finished paragraph over a finished tool call is a
             * picture of a turn that has ended. The composer's placeholder is the wrong place to
             * correct that from: it is at the opposite edge of the screen from where the eye is.
             *
             * A running call, though, already spins on its own row beside the name of what it is
             * doing. Adding this under it would say the same thing twice and put the vaguer of the
             * two nearest the eye, so while a call runs, the call is the indicator.
             */}
            {isStreaming && !isCallRunning ?
                <ChatMessageBubble variant='ghost'>
                    {/*
                     * A string `label` on `Spinner` renders bold body text *under* the dot
                     * (`Spinner.tsx`), which drew a heading-sized "Working" in the middle of the
                     * column — more emphasis than the tool rows it sits between. The row is
                     * assembled by hand instead: dot and word side by side, in the supporting
                     * role, so it reads as a caption on the turn rather than as content.
                     *
                     * The spinner keeps `role='status'` and carries the accessible name; the
                     * visible word is hidden from assistive tech so the same string is not
                     * announced twice (WCAG 4.1.2).
                     */}
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

type ConversationMessageProps = Readonly<{
    attachmentPreviews: Readonly<Record<string, string>>
    message: Message
    onRetry: (assistantId: number) => void
}>

/**
 * Memoized because every streamed token replaces the `messages` array.
 *
 * The message objects themselves keep their identity through that replacement — only the one being
 * streamed is rebuilt — so a hundred-message conversation re-rendered a hundred messages, and their
 * lazily loaded tool output, per token. The memo only holds while `attachmentPreviews` and
 * `onRetry` keep their identity too, which is what `Workspace` guarantees for both.
 *
 * Inside the streaming message the same argument applies again per step, which is why the rows and
 * bubbles are memoized on their own part: a token rebuilds the last bubble, not all eighty-eight
 * tool rows above it.
 */
const ConversationMessage = memo(
    ({attachmentPreviews, message, onRetry}: ConversationMessageProps) => {
        if (message.sender === 'assistant') {
            return (
                <ChatMessage
                    sender='assistant'
                    /*
                     * The footer is the turn's closing line, so a turn still running does not get
                     * one. `usage` arrives once per step, not once per turn, so a running turn drew
                     * a token count that was still climbing — under a paragraph, over nothing —
                     * which is the whole shape of a message that has finished.
                     */
                    {...(message.status !== 'streaming' && {
                        metadata: (
                            <AssistantMetadata
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
                <ChatMessageBubble
                    variant='filled'
                    style={LEFT_ALIGNED_USER_BUBBLE_STYLE}
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
