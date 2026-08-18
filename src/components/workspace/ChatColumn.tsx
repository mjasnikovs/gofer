import {ChatLayoutScrollButton} from '@astryxdesign/core/Chat'
import {StackItem, VStack} from '@astryxdesign/core/Stack'
import {useChatColumn} from '../../hooks/useChatColumn'
import {ErrorBoundary} from '../application/ErrorBoundary'
import {ChatConversation} from './ChatConversation'
import {WorkspaceComposer, WorkspaceWelcome} from './WorkspaceComposer'

/** The chat column stays readable inside the frame's flexible center region. */
const CHAT_CONTENT_WIDTH = 960
/**
 * Centring the welcome overflows both ways in a short centre region, and a scroll container cannot
 * reach what overflows above it. `safe` falls back to start alignment exactly then.
 */
const SAFE_CENTRE = {justifyContent: 'safe center'} as const
/**
 * The jump button floats over the last row instead of sitting above the composer in flow.
 *
 * In flow it keeps its height while hidden, which is a permanent empty band across the column. It
 * is anchored to the composer's own box so it stays put while the conversation scrolls under it.
 */
const JUMP_BUTTON_STYLE = {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    pointerEvents: 'none'
} as const
const COMPOSER_ANCHOR_STYLE = {position: 'relative'} as const

/**
 * The conversation and the composer under it, in the frame's centre region.
 *
 * A component rather than an element built by `Workspace`: the frame is handed `<ChatColumn />`
 * once and never again, so a streamed token reaches this column through context and stops here
 * instead of redrawing every panel it passed on the way down.
 */
export function ChatColumn() {
    const {
        attachmentPreviews,
        isScrolledUp,
        isStreaming,
        messages,
        scrollRef,
        scrollToBottom,
        retry
    } = useChatColumn()
    const composer = <WorkspaceComposer />

    if (messages.length === 0) {
        // The welcome scrolls: the centre region shares its height with the bottom panel, and a
        // short window would otherwise clip the greeting rather than let the user reach it.
        return (
            <StackItem
                size='fill'
                isScrollable
            >
                <VStack
                    height='100%'
                    padding={6}
                    hAlign='center'
                    vAlign='center'
                    style={SAFE_CENTRE}
                >
                    <WorkspaceWelcome composer={composer} />
                </VStack>
            </StackItem>
        )
    }

    return (
        <StackItem size='fill'>
            <VStack
                gap={0}
                height='100%'
                maxWidth={CHAT_CONTENT_WIDTH}
                hAlign='center'
            >
                <ErrorBoundary
                    title='This conversation could not be drawn'
                    description='The messages are still stored, and reopening the task reads them again.'
                >
                    <ChatConversation
                        attachmentPreviews={attachmentPreviews}
                        isStreaming={isStreaming}
                        messages={messages}
                        scrollRef={scrollRef}
                        onRetry={retry}
                    />
                </ErrorBoundary>
                <VStack
                    width='100%'
                    paddingInline={3}
                    paddingBlock={3}
                    style={COMPOSER_ANCHOR_STYLE}
                >
                    <ChatLayoutScrollButton
                        isVisible={isScrolledUp}
                        style={JUMP_BUTTON_STYLE}
                        onClick={scrollToBottom}
                    />
                    {composer}
                </VStack>
            </VStack>
        </StackItem>
    )
}
