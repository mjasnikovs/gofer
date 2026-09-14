import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {BoardView} from './BoardView'
import {OpenTaskContext} from '../../hooks/useOpenTask'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../../test/desktop-driver'
import {flush, flushUntil} from '../../test/flush'
import {CommandFailure, installBackend} from '../../test/backend'
import type {BackendAnswers} from '../../test/backend'
import type {Card, CardComment} from '../../models/board'

const tauri = createDesktopFake()

function card(overrides: Partial<Card> = {}): Card {
    return {
        id: 'card-1',
        title: 'Make the hero jump higher',
        body: 'Twice the height, same hang time.',
        owner: 'user',
        status: 'ready',
        taskId: null,
        commentCount: 0,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        ...overrides
    }
}

const DOING = card({
    id: 'card-2',
    title: 'Fix the ladder',
    owner: 'claude',
    status: 'doing',
    taskId: 'task-9',
    commentCount: 1
})

const COMMENT: CardComment = {
    id: 'comment-1',
    cardId: 'card-2',
    author: 'claude',
    body: 'Halfway there.',
    createdAt: 1_700_000_000_000
}

function backend(rows: readonly Card[] = [card(), DOING], answers: BackendAnswers = {}) {
    return installBackend(tauri, {cards: rows, comments: [COMMENT], answers})
}

const calls = () => tauri.invoke.mock.calls.map(call => call[0])

async function open(openTask = vi.fn()) {
    render(
        <OpenTaskContext value={openTask}>
            <BoardView />
        </OpenTaskContext>
    )
    await flushUntil(() => screen.queryByText('Backlog') !== null)
    await flush()
}

beforeEach(() => {
    installDesktopFake(tauri)
})

afterEach(() => {
    cleanup()
    removeDesktopFake()
    tauri.invoke.mockReset()
    vi.restoreAllMocks()
})

describe('the board', () => {
    it('lays every card out under its column', async () => {
        backend()
        await open()

        for (const column of ['Backlog', 'Ready', 'Doing', 'Review', 'Done'])
            expect(screen.getByText(column)).toBeInTheDocument()
        expect(screen.getByText('Make the hero jump higher')).toBeInTheDocument()
        expect(screen.getByText('claude · 1 comment')).toBeInTheDocument()
        expect(screen.getByText('task')).toBeInTheDocument()
    })

    it('keeps every column when there is nothing on it', async () => {
        backend([])
        await open()

        expect(screen.getByText('Done')).toBeInTheDocument()
        expect(screen.queryAllByRole('button', {name: /jump/u})).toHaveLength(0)
    })

    it('redraws when the backend says the board changed', async () => {
        const {state} = backend([card()])
        await open()

        state.cards = [...state.cards, card({id: 'card-3', title: 'Add a double jump'})]
        const announce = tauri.listen.mock.calls.findLast(call => call[0] === 'board-changed')?.[1]
        expect(announce).toBeDefined()
        announce?.({payload: undefined as never})
        await flushUntil(() => screen.queryByText('Add a double jump') !== null)
    })

    it('adds a card from the dialog', async () => {
        backend([])
        await open()

        await userEvent.click(screen.getByRole('button', {name: 'New card'}))
        await flush()
        await userEvent.type(screen.getByLabelText(/Title/u), 'Add a double jump')
        await userEvent.type(screen.getByLabelText(/What to do/u), 'Second press in the air')
        await userEvent.click(screen.getByRole('button', {name: 'Add card'}))
        await flushUntil(() => screen.queryByText('Add a double jump') !== null)

        expect(calls()).toContain('card_create')
    })

    it('opens a card with its comments and moves it', async () => {
        backend()
        await open()

        await userEvent.click(screen.getByText('Fix the ladder'))
        await flushUntil(() => screen.queryByText('Halfway there.') !== null)
        expect(screen.getByText('claude · 1 comment')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('combobox', {name: 'Column'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Review'}))
        await flushUntil(() => calls().includes('card_move'))

        const dialog = screen.getByRole('dialog')
        expect(await within(dialog).findByText('Review · claude')).toBeInTheDocument()
    })

    it('posts a ready card to Gofer and opens the task it made', async () => {
        const openTask = vi.fn()
        backend([card()])
        await open(openTask)

        await userEvent.click(screen.getByText('Make the hero jump higher'))
        await userEvent.click(await screen.findByRole('button', {name: 'Post to Gofer'}))
        await flushUntil(() => openTask.mock.calls.length > 0)

        expect(calls()).toContain('card_post_to_gofer')
        expect(openTask).toHaveBeenCalledWith(expect.any(String))
    })

    it('does not offer to post a card that already has a task', async () => {
        backend([DOING])
        await open()

        await userEvent.click(screen.getByText('Fix the ladder'))
        await flushUntil(() => screen.queryByRole('button', {name: 'Open task'}) !== null)

        expect(screen.queryByRole('button', {name: 'Post to Gofer'})).not.toBeInTheDocument()
    })

    it('shows the refusal when the backend will not move a card', async () => {
        backend([card({status: 'done'})], {
            card_move: () => {
                throw new CommandFailure(
                    'card_locked',
                    'A finished card is only the user’s to change'
                )
            }
        })
        await open()

        await userEvent.click(screen.getByText('Make the hero jump higher'))
        await userEvent.click(await screen.findByRole('combobox', {name: 'Column'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Review'}))

        expect(
            await screen.findByText('A finished card is only the user’s to change')
        ).toBeInTheDocument()
    })

    it('keeps an edit the user is typing while a comment goes out', async () => {
        backend([card()])
        await open()

        await userEvent.click(screen.getByText('Make the hero jump higher'))
        const title = await screen.findByLabelText(/^Title/u)
        await userEvent.clear(title)
        await userEvent.type(title, 'Make the hero jump twice')
        await userEvent.type(screen.getByLabelText(/Add a comment/u), 'Noted')
        await userEvent.click(screen.getByRole('button', {name: 'Comment'}))
        await flushUntil(() => calls().includes('card_comment'))
        await flush()

        expect(screen.getByLabelText(/^Title/u)).toHaveValue('Make the hero jump twice')
        expect(screen.getByRole('button', {name: 'Save changes'})).toBeInTheDocument()
    })

    it('shows a comment another agent leaves while the card is open', async () => {
        const {state} = backend([DOING])
        await open()

        await userEvent.click(screen.getByText('Fix the ladder'))
        await flushUntil(() => screen.queryByText('Halfway there.') !== null)

        state.comments = [
            ...state.comments,
            {...COMMENT, id: 'comment-2', body: 'Done, the ladder holds.'}
        ]
        const announce = tauri.listen.mock.calls.findLast(call => call[0] === 'board-changed')?.[1]
        announce?.({payload: undefined as never})
        await flushUntil(() => screen.queryByText('Done, the ladder holds.') !== null)
    })
})
