import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {createRef} from 'react'
import {ChatConversation} from './ChatConversation'
import type {Message, ToolActivity, VerifyPoint} from '../../models/chat'

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

        await vi.advanceTimersByTimeAsync(21_000)
        expect(await screen.findByText('scenes/player.tscn · 24s')).toBeTruthy()
    })

    it('colours a GDScript fence, and leaves an unknown language alone', () => {
        const fenceText = (fence: string) =>
            ['```' + fence, 'func _ready() -> void:', '\tpass', '```'].join('\n')
        const prose = (fence: string): Message => ({
            id: 3,
            sender: 'assistant',
            text: fenceText(fence),
            timestamp: STARTED_AT,
            tools: [],
            parts: [{kind: 'text', text: fenceText(fence)}],
            status: 'complete'
        })
        const chat = (message: Message) => (
            <ChatConversation
                attachmentPreviews={{}}
                isStreaming={false}
                messages={[message]}
                scrollRef={createRef<HTMLElement>()}
                onRetry={() => undefined}
            />
        )

        const {container} = render(chat(prose('gd')))
        expect(container.querySelector('.astryx-token-keyword')?.textContent).toBe('func')
        expect(container.querySelector('.astryx-token-function')?.textContent).toBe('_ready')

        cleanup()
        expect(
            render(chat(prose('brainfuck'))).container.querySelector('[class*=astryx-token-]')
        ).toBeNull()
    })

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

        const sent = screen.getByText(/BLOCKER/)
        expect(sent.textContent).toBe(message.text)
        expect(sent.style.whiteSpace).toBe('pre-wrap')
    })

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

describe('verification points', () => {
    afterEach(cleanup)

    function withPoints(points: readonly VerifyPoint[]) {
        const message: Message = {
            id: 2,
            sender: 'assistant',
            text: 'All done.',
            timestamp: STARTED_AT,
            status: 'complete',
            verifyPoints: points
        }
        return (
            <ChatConversation
                attachmentPreviews={{}}
                isStreaming={false}
                messages={[message]}
                scrollRef={createRef<HTMLElement>()}
                onRetry={() => undefined}
            />
        )
    }

    it('says how many failed, and opens itself when one did', () => {
        render(
            withPoints([
                {
                    name: 'the boss moves',
                    command: 'godot --headless',
                    status: 'error',
                    output: 'actual=0'
                },
                {name: 'it still starts', command: 'test -f project.godot', status: 'complete'}
            ])
        )

        expect(screen.getByText('Verification failed — 1 of 2')).toBeTruthy()
        expect(screen.getByText('the boss moves')).toBeTruthy()
    })

    it('counts up while the points are still running', () => {
        render(
            withPoints([
                {name: 'the boss moves', command: 'a', status: 'complete'},
                {name: 'it still starts', command: 'b', status: 'running'}
            ])
        )

        expect(screen.getByText('Verifying 2 of 2')).toBeTruthy()
    })

    it('says so plainly when everything passed', () => {
        render(withPoints([{name: 'the boss moves', command: 'a', status: 'complete'}]))

        expect(screen.getByText('Verified — 1 of 1')).toBeTruthy()
    })
})
