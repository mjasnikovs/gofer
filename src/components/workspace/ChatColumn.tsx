import {ChatLayoutScrollButton} from '@astryxdesign/core/Chat'
import {StackItem, VStack} from '@astryxdesign/core/Stack'
import {useChatColumn} from '../../hooks/useChatColumn'
import {ErrorBoundary} from '../application/ErrorBoundary'
import {UnownedAsk} from './AskBlock'
import {BriefProgress} from './BriefProgress'
import {ChatConversation} from './ChatConversation'
import {WorkspaceComposer, WorkspaceWelcome} from './WorkspaceComposer'

const CHAT_CONTENT_WIDTH = 960
const SAFE_CENTRE = {justifyContent: 'safe center'} as const
const JUMP_BUTTON_STYLE = {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    right: 0,
    pointerEvents: 'none'
} as const
const COMPOSER_ANCHOR_STYLE = {position: 'relative'} as const

export function ChatColumn() {
    const {
        attachmentPreviews,
        isScrolledUp,
        isStreaming,
        messages,
        scrollRef,
        scrollToBottom,
        retry,
        brief,
        cancelBrief,
        startWithoutPlan
    } = useChatColumn()
    const slot =
        brief.isRunning || brief.ended ?
            <BriefProgress
                state={brief}
                onCancel={cancelBrief}
                onStartWithoutPlan={startWithoutPlan}
            />
        :   <WorkspaceComposer />
    const composer = (
        <VStack gap={3}>
            <UnownedAsk />
            {slot}
        </VStack>
    )

    if (messages.length === 0) {
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
