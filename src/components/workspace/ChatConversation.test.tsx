import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {createRef} from 'react'
import {ChatConversation} from './ChatConversation'
import type {Message, ToolActivity} from '../../models/chat'

/**
 * The row a slow call draws while it is still running.
 *
 * Gofer's editor calls wait twenty to thirty seconds before they admit a timeout, and one recorded
 * task spent three hundred and ninety-seven seconds inside calls that ended that way. For all of it
 * the row showed a spinner and nothing else, which is indistinguishable from a window that has
 * stopped responding — and is what it was reported as. The age on the row is the difference.
 */
const STARTED_AT = 1_000_000

function conversation(tool: ToolActivity) {
    const message: Message = {
        id: 2,
        sender: 'assistant',
        text: '',
        timestamp: STARTED_AT,
        tools: [tool],
        parts: [{kind: 'tool', toolId: tool.id}],
        status: 'streaming'
    }
    return (
        <ChatConversation
            attachmentPreviews={{}}
            isStreaming
            messages={[message]}
            scrollRef={createRef<HTMLElement>()}
            onRetry={() => undefined}
        />
    )
}

describe('ChatConversation', () => {
    afterEach(() => {
        vi.useRealTimers()
        cleanup()
    })

    it('counts up on a call that has not answered yet', async () => {
        vi.useFakeTimers({shouldAdvanceTime: true})
        vi.setSystemTime(STARTED_AT + 3_000)
        render(
            conversation({
                id: 'call-1',
                name: 'godot_scene',
                status: 'running',
                startedAt: STARTED_AT,
                target: 'scenes/player.tscn'
            })
        )

        expect(await screen.findByText('scenes/player.tscn · 3s')).toBeTruthy()

        // The whole point is that it keeps moving: a number frozen at three seconds says no more
        // than a frozen spinner does.
        await vi.advanceTimersByTimeAsync(21_000)
        expect(await screen.findByText('scenes/player.tscn · 24s')).toBeTruthy()
    })

    /*
     * A brief is typed as paragraphs and pasted as a block, and it has to read back that way. The
     * bubble used to hand the string to a `Text` with no `white-space`, so the browser's `normal`
     * collapsed every newline and every blank line into one wall of prose.
     */
    it('keeps the line breaks in a message the way it was typed', () => {
        const message: Message = {
            id: 1,
            sender: 'user',
            text: '=== 1. BLOCKER ===\n\nscripts/main.gd:850\n    _spawn_centipede()',
            timestamp: STARTED_AT
        }
        render(
            <ChatConversation
                attachmentPreviews={{}}
                isStreaming={false}
                messages={[message]}
                scrollRef={createRef<HTMLElement>()}
                onRetry={() => undefined}
            />
        )

        // jsdom does not lay text out, so the evidence is the preserved string plus the rule that
        // decides whether a browser would honour it.
        const sent = screen.getByText(/BLOCKER/)
        expect(sent.textContent).toBe(message.text)
        expect(sent.style.whiteSpace).toBe('pre-wrap')
    })

    /* A sent picture is still the thing the turn is about, so it has to open bigger than a thumbnail. */
    it('opens a sent attachment full size', async () => {
        const user = userEvent.setup()
        const message: Message = {
            id: 1,
            sender: 'user',
            text: 'look at this',
            timestamp: STARTED_AT,
            attachments: [{id: 'a-1', name: 'ravine.png', mimeType: 'image/png', size: 10}]
        }
        render(
            <ChatConversation
                attachmentPreviews={{'a-1': 'blob:ravine'}}
                isStreaming={false}
                messages={[message]}
                scrollRef={createRef<HTMLElement>()}
                onRetry={() => undefined}
            />
        )

        await user.click(screen.getByRole('button', {name: /Open ravine\.png/}))

        const opened = await screen.findAllByAltText('Attached image: ravine.png')
        expect(opened.some(image => image.closest('dialog') !== null)).toBe(true)
    })

    it('reports what a finished call took, not how old it is', async () => {
        vi.useFakeTimers({shouldAdvanceTime: true})
        vi.setSystemTime(STARTED_AT + 90_000)
        render(
            conversation({
                id: 'call-1',
                name: 'godot_scene',
                status: 'complete',
                startedAt: STARTED_AT,
                endedAt: STARTED_AT + 250,
                target: 'scenes/player.tscn'
            })
        )

        expect(await screen.findByText('250ms')).toBeTruthy()
        expect(await screen.findByText('scenes/player.tscn')).toBeTruthy()
        expect(screen.queryByText('scenes/player.tscn · 90s')).toBeNull()
    })
})
