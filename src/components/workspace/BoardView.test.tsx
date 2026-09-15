import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {ReactElement} from 'react'
import {act, cleanup, render, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {StackItem} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {BoardView} from './BoardView'
import {noInterval, setIntervalScheduler} from '../../services/clock'
import {useFileMentionTrigger} from '../../hooks/useFileMentionTrigger'
import {MINUTE_MS} from '../../utils/relative-time'
import {
    autopilotState,
    clearAutopilot,
    setAutopilot,
    stopAutopilot
} from '../../services/board-autopilot'
import {OpenCenterTabContext} from '../../hooks/useCenterTab'
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
        number: 1,
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
    number: 2,
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

const lane = (name: string) => screen.getByRole('region', {name})

vi.mock('../../hooks/useFileMentionTrigger', async importOriginal => {
    const actual = await importOriginal<{useFileMentionTrigger: typeof useFileMentionTrigger}>()
    return {...actual, useFileMentionTrigger: vi.fn(actual.useFileMentionTrigger)}
})

/** A card field's renders, counted through the one hook every render of it calls. */
const cardFieldRenders = () => vi.mocked(useFileMentionTrigger).mock.calls.length

function classesOf(element: ReactElement): readonly string[] {
    const {container, unmount} = render(element)
    const classes = [...(container.firstElementChild?.classList ?? [])]
    unmount()
    return classes
}

// StyleX class names are hashes, so a prop's classes are found by what it adds to a bare render.
function classesAddedBy(withProp: ReactElement, without: ReactElement): readonly string[] {
    const plain = classesOf(without)
    return classesOf(withProp).filter(one => !plain.includes(one))
}

async function open(openTask = vi.fn(), openTab = vi.fn()) {
    render(
        <OpenTaskContext value={openTask}>
            <OpenCenterTabContext value={openTab}>
                <BoardView />
            </OpenCenterTabContext>
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
            expect(lane(column)).toBeInTheDocument()
        expect(within(lane('Ready')).getByText('Make the hero jump higher')).toBeInTheDocument()
        const doing = within(lane('Doing'))
        expect(doing.getByText('Fix the ladder')).toBeInTheDocument()
        expect(doing.getByText('#2')).toBeInTheDocument()
        expect(doing.getByText(/^claude · /u)).toBeInTheDocument()
        expect(doing.getByLabelText('1 comment')).toBeInTheDocument()
        const hiddenCounts = doing
            .getAllByText('1')
            .filter(one => one.getAttribute('aria-hidden') === 'true')
        expect(hiddenCounts).toHaveLength(1)
        expect(doing.queryByText('Posted')).not.toBeInTheDocument()
    })

    it('keeps every column when there is nothing on it', async () => {
        backend([])
        await open()

        expect(within(lane('Done')).getByText('Nothing finished yet')).toBeInTheDocument()
        expect(screen.queryAllByRole('button', {name: /jump/u})).toHaveLength(0)
    })

    it('says how long ago a card last changed', async () => {
        vi.useFakeTimers({toFake: ['Date']})
        vi.setSystemTime(DOING.updatedAt + 5 * 60_000)
        try {
            backend([DOING])
            await open()

            expect(within(lane('Doing')).getByText('claude · 5 minutes ago')).toBeInTheDocument()
        } finally {
            vi.useRealTimers()
        }
    })

    it('shows the card finished last at the top of Done, even when an older one changed since', async () => {
        backend([
            card({id: 'card-3', number: 3, title: 'Finished first', status: 'done', updatedAt: 9}),
            card({id: 'card-4', number: 4, title: 'Finished last', status: 'done', updatedAt: 2})
        ])
        await open()

        const names = within(lane('Done'))
            .getAllByRole('button')
            .map(button => button.getAttribute('aria-label'))
        expect(names).toEqual(['Finished last', 'Finished first'])
    })

    it('marks a card waiting to be started that already has a task', async () => {
        backend([card({taskId: 'task-1'}), DOING])
        await open()

        expect(within(lane('Ready')).getByText('Posted')).toBeInTheDocument()
        expect(within(lane('Doing')).queryByText('Posted')).not.toBeInTheDocument()
    })

    it('moves the time on a card each minute without redrawing an open dialog', async () => {
        const ticks: (() => void)[] = []
        setIntervalScheduler((work, everyMs) => {
            if (everyMs === MINUTE_MS) ticks.push(work)
            return () => undefined
        })
        vi.useFakeTimers({toFake: ['Date']})
        vi.setSystemTime(DOING.updatedAt + 5 * MINUTE_MS)
        try {
            backend([DOING])
            await open()
            await userEvent.click(screen.getByRole('button', {name: 'New card'}))
            await flush()
            const rendersBefore = cardFieldRenders()

            vi.setSystemTime(DOING.updatedAt + 6 * MINUTE_MS)
            act(() => {
                for (const tick of ticks) tick()
            })

            expect(screen.getByText('claude · 6 minutes ago')).toBeInTheDocument()
            expect(cardFieldRenders()).toBe(rendersBefore)
        } finally {
            vi.useRealTimers()
            setIntervalScheduler(noInterval)
        }
    })

    it('scrolls a failure too long for the tab', async () => {
        backend([], {
            board_list: () => {
                throw new CommandFailure('database', 'The board file is locked. '.repeat(40))
            }
        })
        render(<BoardView />)
        await flushUntil(() => screen.queryByText('The board could not be read') !== null)

        const scrollable = classesAddedBy(
            <StackItem isScrollable>content</StackItem>,
            <StackItem>content</StackItem>
        )
        expect(scrollable.length).toBeGreaterThan(0)
        const banner = screen.getByText('The board could not be read')
        const scroller = banner.closest(scrollable.map(one => `.${one}`).join(''))
        expect(scroller).not.toBeNull()
    })

    it('opens a card from the keyboard', async () => {
        backend()
        await open()

        screen.getByRole('button', {name: 'Fix the ladder'}).focus()
        await userEvent.keyboard('{Enter}')
        await flushUntil(() => screen.queryByText('Halfway there.') !== null)
    })

    it('stacks the columns when the board is too narrow for them side by side', async () => {
        vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(1100)
        vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(620)
        backend()
        await open()

        expect(document.querySelector('.gofer-board-lane')).toBeNull()
        for (const column of ['Backlog', 'Ready', 'Doing', 'Review', 'Done'])
            expect(lane(column)).toBeInTheDocument()
        expect(within(lane('Doing')).getByText('Fix the ladder')).toBeInTheDocument()
    })

    it('redraws when the backend says the board changed', async () => {
        const {state} = backend([card()])
        await open()

        state.cards = [...state.cards, card({id: 'card-3', number: 3, title: 'Add a double jump'})]
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
        expect(
            within(screen.getByRole('dialog')).getByText('#2 · Doing · claude')
        ).toBeInTheDocument()

        await userEvent.click(screen.getByRole('combobox', {name: 'Column'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Review'}))
        await flushUntil(() => calls().includes('card_move'))

        const dialog = screen.getByRole('dialog')
        expect(await within(dialog).findByText('#2 · Review · claude')).toBeInTheDocument()
    })

    it('posts a ready card to Gofer and opens the task it made on the chat tab', async () => {
        const openTask = vi.fn()
        const openTab = vi.fn()
        backend([card()])
        await open(openTask, openTab)

        await userEvent.click(screen.getByText('Make the hero jump higher'))
        await userEvent.click(await screen.findByRole('button', {name: 'Post to Gofer'}))
        await flushUntil(() => openTask.mock.calls.length > 0)

        expect(calls()).toContain('card_post_to_gofer')
        expect(openTask).toHaveBeenCalledWith(expect.any(String))
        expect(openTab).toHaveBeenCalledWith('chat')
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

    it('deletes a card after the user confirms', async () => {
        backend()
        await open()

        await userEvent.click(screen.getByText('Make the hero jump higher'))
        await userEvent.click(await screen.findByRole('button', {name: 'Delete'}))
        expect(calls()).not.toContain('card_delete')
        await userEvent.click(await screen.findByRole('button', {name: 'Delete card'}))
        await flushUntil(() => screen.queryByText('Make the hero jump higher') === null)

        expect(calls()).toContain('card_delete')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByText('Fix the ladder')).toBeInTheDocument()
    })

    it('shows the pictures on a card and saves the set the user leaves', async () => {
        backend([card()], {
            card_read: ({id}) => ({
                card: card({id}),
                comments: [],
                attachments: [
                    {id: 'picture-1', name: 'scene.png', mimeType: 'image/png', size: 2},
                    {id: 'picture-2', name: 'ladder.png', mimeType: 'image/png', size: 2}
                ]
            })
        })
        await open()

        await userEvent.click(screen.getByText('Make the hero jump higher'))
        const first = await screen.findByAltText('Attached image: scene.png')
        expect(first).toHaveAttribute('src', 'data:image/png;base64,aGk=')
        expect(screen.getByRole('button', {name: 'Save changes'})).toBeDisabled()

        await userEvent.click(
            screen.getByRole('button', {name: /Remove.*scene\.png|scene\.png.*Remove/iu})
        )
        await userEvent.click(screen.getByRole('button', {name: 'Save changes'}))
        await flushUntil(() => calls().includes('card_edit'))

        const edit = tauri.invoke.mock.calls.find(call => call[0] === 'card_edit')?.[1]
        expect(edit).toMatchObject({
            edit: {attachments: [{id: 'picture-2', name: 'ladder.png'}]}
        })
        expect(calls()).not.toContain('save_chat_attachment')
    })

    it('writes a new line on Enter instead of sending', async () => {
        backend([])
        await open()

        await userEvent.click(screen.getByRole('button', {name: 'New card'}))
        await flush()
        await userEvent.type(screen.getByLabelText(/Title/u), 'Add a double jump')
        const body = screen.getByLabelText(/What to do/u)
        await userEvent.type(body, 'Second press{Enter}in the air')
        await userEvent.click(screen.getByRole('button', {name: 'Add card'}))
        await flushUntil(() => calls().includes('card_create'))

        const created = tauri.invoke.mock.calls.find(call => call[0] === 'card_create')?.[1]
        expect(created).toMatchObject({body: 'Second press\nin the air', attachments: []})
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

describe('auto mode on the board', () => {
    afterEach(clearAutopilot)

    it('is off until the switch is turned on, and then picks', async () => {
        backend()
        const user = userEvent.setup()
        await open()

        expect(autopilotState().phase).toBe('off')
        expect(screen.queryByText(/^Auto[: ]/u)).not.toBeInTheDocument()
        await user.click(screen.getByRole('switch', {name: 'Auto'}))

        expect(autopilotState().phase).toBe('picking')
        expect(screen.getByText('Auto: picking the next Ready card')).toBeInTheDocument()
    })

    it('shows which card it is on, and why it stopped, with the detail under it', async () => {
        backend()
        setAutopilot({phase: 'running', card: {id: 'card-1', number: 1, taskId: 'task-1'}})
        await open()
        expect(screen.getByText('Auto: running card #1')).toBeInTheDocument()
        expect(within(lane('Ready')).getByLabelText('Auto is on this card')).toBeInTheDocument()
        expect(within(lane('Ready')).getByText('Running')).toBeInTheDocument()

        act(() => {
            stopAutopilot('merge-failed', 'The editor did not answer.')
        })
        expect(screen.getByText('Auto stopped: the merge failed')).toBeInTheDocument()
        const detail = screen.getByText('The editor did not answer.')
        const clamp = classesAddedBy(
            <Text
                type='supporting'
                maxLines={2}
            >
                detail
            </Text>,
            <Text type='supporting'>detail</Text>
        )
        expect(clamp.length).toBeGreaterThan(0)
        for (const one of clamp) expect(detail).not.toHaveClass(one)
        expect(screen.getByRole('switch', {name: 'Auto'})).not.toBeChecked()
        expect(screen.queryByLabelText('Auto is on this card')).not.toBeInTheDocument()
    })

    it('turns off from the switch and leaves no reason behind', async () => {
        backend()
        const user = userEvent.setup()
        setAutopilot({phase: 'running', card: {id: 'card-1', number: 1, taskId: 'task-1'}})
        await open()

        await user.click(screen.getByRole('switch', {name: 'Auto'}))

        expect(autopilotState()).toEqual({phase: 'off'})
        expect(screen.queryByText(/^Auto[: ]/u)).not.toBeInTheDocument()
    })
})
