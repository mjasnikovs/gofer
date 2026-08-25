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

/*
 * A sent message is shown back the way it was typed — body text, not monospace. It was `code`,
 * which put the one thing the user wrote in a different family from everything around it and made
 * every ordinary sentence read as a snippet. The composer is a contenteditable at
 * `white-space: pre-wrap`, but `Text` sets no `white-space` at all below `maxLines`, so the
 * default `normal` collapsed every newline and blank line the moment the message left the
 * box — a paragraphed brief came back as one blob. `ChatMessageBubble` already carries
 * `overflow-wrap: break-word`, which is inherited, so a long path still breaks.
 */
const SENT_TEXT_STYLE = {whiteSpace: 'pre-wrap'} as const
// The conversation sits in a centre-aligned column: without an explicit width it
// would shrink to the widest message and grow as the reply streams in.
const CHAT_SCROLL_VIEWPORT_STYLE = {display: 'flex', width: '100%'} as const
/**
 * A message off the top of the viewport is not laid out until it is scrolled to.
 *
 * The composer is a `contenteditable` and this list is its sibling inside one full-height column,
 * so a typed character dirties the column and the browser lays every message in it out again.
 * Measured on a four-hundred-message conversation, one keystroke cost 2.2ms of layout against
 * 0.4ms on a short one, and it grew with the conversation — which is a chat window that types
 * slower the longer you have been working in it.
 *
 * `auto` on the intrinsic size means the remembered height of a row that has been drawn once,
 * falling back to this estimate for one that has not. The estimate only has to be close: it is what
 * the scrollbar is sized from until the row is reached, and a row corrects it the moment it is.
 *
 * `flexShrink` is not a tweak. A skipped row has no content, so its automatic minimum size is zero
 * and the list — a flex column taller than its viewport — shrinks every one of them away: measured,
 * a twenty-message conversation collapsed from 6194px of scroll to 1875px and the rows off screen
 * had no height at all. A message never gives ground anyway; saying so is what keeps the estimate.
 */
const MESSAGE_SKIP_STYLE = {
    contentVisibility: 'auto',
    containIntrinsicSize: 'auto 240px',
    flexShrink: 0
} as const
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
/*
 * The last row ends on the viewport's own edge, which is what made a following column look broken:
 * anything the scroll had not caught up with yet was cut by a hard line rather than trailing off
 * below a gap. Measured mid-stream, the bottom row sat 57px past the edge; the padding is the
 * breathing room, and the spring in `Workspace` is what closes the rest.
 */
const CHAT_MESSAGE_LIST_STYLE = {minWidth: 0, paddingBlockEnd: 'var(--spacing-3)'} as const
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
/**
 * The row's target, carrying the call's age while it is still running.
 *
 * A finished call reports how long it took; a running one drew a spinner and nothing else, and
 * Gofer's editor calls wait twenty to thirty seconds before they admit a timeout. One recorded task
 * spent three hundred and ninety-seven seconds inside thirty-nine calls that ended that way, and
 * half a minute of a still spinner is indistinguishable from a window that has stopped responding —
 * which is what it was reported as.
 *
 * The seconds ride on the target because `ChatToolCalls` draws `duration` only when the call is
 * `complete` (`ChatToolCalls.tsx`), so the prop meant for this cannot carry it. The target is the
 * other string on the row and it is already about this call.
 *
 * The live step rides it for the same reason, and sits between the two: what a delegation was ASKED
 * does not change and is how two of them in one turn are told apart, so it keeps the front. Its
 * progress goes next to it rather than over it. The row ellipsises when all three do not fit, which
 * is the cost of the one slot this component offers.
 */
function runningCallTarget(tool: ToolActivity, now: number | undefined) {
    const named = [tool.target, tool.step].filter(Boolean).join(' · ')
    if (now === undefined) return named || undefined
    const seconds = Math.max(0, Math.round((now - tool.startedAt) / 1000))
    const age = `${String(seconds)}s`
    return named ? `${named} · ${age}` : age
}

/**
 * The trailing edge of a finished row: how long it took, and what the ask that issued it cost.
 *
 * Both ride on `duration` because it is the only slot `ChatToolCalls` draws on that edge, and a
 * turn is read by scanning that column for the expensive step.
 */
function callDuration(tool: ToolActivity) {
    if (tool.endedAt === undefined) return undefined
    const elapsed = `${String(tool.endedAt - tool.startedAt)}ms`
    if (tool.tokens === undefined) return elapsed
    return `${elapsed} · ${tool.tokens.toLocaleString()} tok`
}

/**
 * Tool output as something a code block can actually draw.
 *
 * Almost every tool answers with a JSON object serialised onto a single line, and the block was
 * told it was `text`, so it drew one unwrapped line that ran off the right edge. Indenting it is
 * the whole fix. `bash` keeps its own highlighting, and anything that is not an object or an array
 * — prose, a stack trace, a half-streamed result — is left exactly as it arrived.
 */
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

/** One entry of a domain call's answer, as the router writes it. */
type AnsweredOperation = Readonly<{
    op?: string
    result?: unknown
    error?: unknown
    skipped?: string
}>

/**
 * The operations one finished domain call answered, or nothing when it did not answer a list.
 *
 * A domain tool takes an `ops` list, so a row that says `inspect ×3` has three answers behind it.
 * Reading them out is what lets the row expand into three rather than into one JSON blob with three
 * things buried in it.
 */
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

/** What one entry did: it answered, it failed, or an earlier entry failed and it never ran. */
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
    // A list of several is handed over as several calls, because that is the layout `ChatToolCalls`
    // draws for an array: one summary row that opens into the entries. The label keeps what the
    // single row said — the operations, how long the call took, and what the ask cost — since the
    // generated one is a bare count and the cost belongs to the call rather than to any entry.
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

/**
 * The task's verification points, drawn where the turn's other work is drawn.
 *
 * They are not tool calls, and they belong on this row anyway: a point is something the turn did,
 * it has the same four states `ChatToolCalls` draws, and Astryx's own guidance is that these rows
 * live inside an assistant message rather than as standalone UI.
 *
 * The failure this closes was measured on a live run. A point failed twice and the turn ended "The
 * verification passes. The code is already correct." The answer now carries the verdict in its
 * text, but a verdict that only arrives at the end is a verdict nobody watches: a point that boots
 * a headless Godot is seconds of silence with nothing on screen saying what is being waited for.
 */
const VerifyPointsRow = memo(({points}: {points: readonly VerifyPoint[]}) => {
    const failed = points.filter(point => point.status === 'error').length
    const settled = points.filter(point => point.status !== 'running').length
    // Named rather than counted, because the generated label is a bare count and the one thing a
    // reader needs from a collapsed row is whether anything is red.
    const label =
        settled < points.length ? `Verifying ${String(settled + 1)} of ${String(points.length)}`
        : failed > 0 ? `Verification failed — ${String(failed)} of ${String(points.length)}`
        : `Verified — ${String(points.length)} of ${String(points.length)}`
    // The verdict is its own line rather than the group's label. `ChatToolCalls` writes its own
    // header once the group is open — "2 tool calls" — and the one thing a reader needs from this
    // row is whether anything is red, which is not something to hand to a component's default.
    return (
        <VStack gap={1}>
            {/* A failure is the stronger role, so it takes the stronger type. */}
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

/**
 * The caption on a stretch of thinking, and the row that opens it.
 *
 * `ChatMessageBubble` draws `name` in a bare `div` that inherits whatever type surrounds it, so the
 * bare string came out at body size in body colour — larger and louder than the thinking
 * underneath it, which is drawn compact, and louder than the tool rows either side of it. It is a
 * caption on a quiet part of the turn, so it takes the same role the tool rows' own names take:
 * supporting size, secondary colour.
 *
 * "Thinking", not "Reasoning": the composer's effort control is a button the visual suite finds by
 * `/^Reasoning:/`, and a second button starting with that word is one dropped colon away from
 * matching two elements and failing the whole file.
 */
const THINKING_LABEL = (
    <Text
        type='supporting'
        color='secondary'
    >
        Thinking
    </Text>
)

/**
 * One stretch of what the agent wrote, rendered as Markdown.
 *
 * The model answers in Markdown — headings, lists, fenced code — and a plain `Text` node printed all
 * of it as one unbroken paragraph. `isStreaming` is set only on the stretch still growing, which is
 * what switches `Markdown` to incremental parsing.
 *
 * Thinking is folded away once the turn moves past it. The transcript is what the agent said, not
 * what it muttered getting there, and now that a block has no fill and no inset of its own there is
 * nothing left to tell the muttering apart from the answer at a glance. It stays open while it is
 * still arriving: a turn can think for minutes, and a closed row over a spinner is a window that
 * looks hung. `isStreaming` is set on the last part only, so the fold happens by itself when the
 * next part starts. A click wins after that and keeps winning — the reader's choice outlives the
 * stream.
 */
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
                    {/*
                     * Only the turn at the end can be retried. Re-running an earlier one is a
                     * branch, and this conversation has no branches: the reply on screen and the
                     * transcript the model was given would stop being the same conversation.
                     */}
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

/**
 * The turn as it happened: write, call a tool, write again, each step its own row.
 *
 * Parts are keyed by index because the list only ever appends, or grows its own last entry — no
 * part is ever inserted, removed, or moved, so an index names the same step for the whole turn.
 */
/** Ticks once a second while a call runs, so its row can count up instead of only spinning. */
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
                    // A part naming a call the message no longer carries would render an empty row;
                    // there is nothing to show, so it shows nothing.
                    if (!tool) return null
                    /*
                     * A question is the one tool call the user has to do something with, so it is
                     * the one that is not a row. Everything else on this timeline reports what the
                     * agent did; this one is waiting on them, and a collapsed row saying "ask_user"
                     * is a thing to open rather than a thing to answer.
                     */
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
            {/*
             * After the words, because the points answer for what the words claim: the run that
             * prompted this ended with "The verification passes" over two red points.
             */}
            {message.verifyPoints && message.verifyPoints.length > 0 ?
                <VerifyPointsRow points={message.verifyPoints} />
            :   null}
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

type MessageAttachmentsProps = Readonly<{
    attachments: readonly ChatAttachment[]
    previews: Readonly<Record<string, string>>
}>

/**
 * The pictures on a sent message, and the viewer that opens from them.
 *
 * A sent attachment can no longer be drawn on, but it is still what the turn is about, and a
 * thumbnail is too small to check one against what the model then did. Clicking opens it full size.
 */
function MessageAttachments({attachments, previews}: MessageAttachmentsProps) {
    const [viewing, setViewing] = useState<number>()
    // Only the ones whose bytes have arrived can be opened, so the gallery is indexed over those.
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
            {/* Mounted only while open: a closed one still renders its image, which doubles every
                attached picture in the tree. */}
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
    ({attachmentPreviews, isLast, message, onRetry}: ConversationMessageProps) => {
        if (message.sender === 'assistant') {
            return (
                <ChatMessage
                    sender='assistant'
                    style={MESSAGE_SKIP_STYLE}
                    /*
                     * The footer is the turn's closing line, so a turn still running does not get
                     * one. `usage` arrives once per step, not once per turn, so a running turn drew
                     * a token count that was still climbing — under a paragraph, over nothing —
                     * which is the whole shape of a message that has finished.
                     */
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
            <ChatMessage
                sender='user'
                style={MESSAGE_SKIP_STYLE}
            >
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
