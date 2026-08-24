import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {AskBlock, UnownedAsk} from './AskBlock'
import {AskedQuestionsContext} from '../../hooks/useUserQuestions'
import {OpenCenterTabContext} from '../../hooks/useCenterTab'
import type {CenterTab} from '../../models/ui-state'
import {AGREED_SKETCH_MARK} from '../../models/sketch'
import type {UserQuestionPrompt, UserQuestionResponse} from '../../models/brief'
import type {ToolActivity} from '../../models/chat'

afterEach(cleanup)

/** jsdom measures everything as zero, and a sketch in a zero-wide column has no scale. */
const COLUMN = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 640,
    bottom: 360,
    width: 640,
    height: 360
} as DOMRect

beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(COLUMN)
})

afterEach(() => {
    vi.restoreAllMocks()
})

const CALL = 'call-1'

const call = (over: Partial<ToolActivity> = {}): ToolActivity => ({
    id: CALL,
    name: 'ask_user',
    target: 'Where does the pause menu live?',
    status: 'running',
    startedAt: 0,
    ...over
})

const question = (over: Partial<UserQuestionPrompt> = {}): UserQuestionPrompt => ({
    questionId: 'q-1',
    question: 'Where does the pause menu live?',
    options: ['its own scene', 'inside the HUD'],
    sketches: [],
    why: 'it changes the scene tree',
    revision: 1,
    ownerCallId: CALL,
    isDelegated: false,
    ...over
})

const TWO = [
    {label: 'Bar across the top', html: '<p>a</p>'},
    {label: 'Side rail', html: '<p>b</p>'}
]

/**
 * The block, with whatever questions are live.
 *
 * Questions are handed in rather than fetched, which is the seam: the hook is mounted once above the
 * whole conversation and the block takes its own by `ownerCallId`.
 */
const show = (
    tool: ToolActivity,
    questions: readonly UserQuestionPrompt[] = [],
    answer = vi.fn<(response: UserQuestionResponse) => void>()
) => {
    const openTab = vi.fn<(tab: CenterTab) => void>()
    const view = render(
        <OpenCenterTabContext value={openTab}>
            <AskedQuestionsContext value={{questions, answer}}>
                <AskBlock tool={tool} />
            </AskedQuestionsContext>
        </OpenCenterTabContext>
    )
    return {answer, openTab, view}
}

const answerBox = () => screen.getByRole('textbox', {name: /Your answer/u})

describe('one question, in the feed', () => {
    /** Story 1: the model asks, the user picks an option, and it sends. */
    it('sends an option the moment it is pressed', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.click(screen.getByRole('button', {name: 'inside the HUD'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', answer: 'inside the HUD'})
        )
    })

    /**
     * The asker puts the one it recommends first, and the mark is on the answer rather than beside
     * it: a tinted pill in a row of buttons is read as a third button.
     *
     * The word rides the accessible name because a green border is a colour-only distinction, and
     * this theme is deliberately close to colourless — so the reader who cannot see the border is
     * the one who most needs the word. The visible text stays the answer.
     */
    it('marks the recommended answer on the answer itself', async () => {
        const {answer} = show(call(), [question()])

        const recommended = screen.getByRole('button', {name: 'its own scene (recommended)'})
        expect(recommended).toHaveTextContent('its own scene')
        // The badge is inside the button, not beside it.
        expect(recommended).toContainElement(screen.getByText('Recommended'))

        await userEvent.click(recommended)
        expect(answer).toHaveBeenCalledWith(expect.objectContaining({answer: 'its own scene'}))
    })

    /** One option is not a recommendation over anything — it is the only answer offered. */
    it('marks nothing when there is only one option', () => {
        show(call(), [question({options: ['its own scene']})])

        expect(screen.getByRole('button', {name: 'its own scene'})).toBeInTheDocument()
    })

    /**
     * Story 2: the user writes a suggestion and the model asks again about the same thing.
     *
     * The block does not close and does not reopen — the second round IS the same block, because it
     * carries the same owning call. What has to be cleared is the box: an answer composed for round
     * one must never be sitting in round two's field.
     */
    it('is one block across a revision, and keeps no answer from the round before', async () => {
        const {answer, view} = show(call(), [question()])
        await userEvent.type(answerBox(), 'make it its own scene')
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))
        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({answer: 'make it its own scene'})
        )

        view.rerender(
            <AskedQuestionsContext value={{questions: [question({revision: 2})], answer}}>
                <AskBlock tool={call()} />
            </AskedQuestionsContext>
        )

        expect(screen.getByText('Round 2')).toBeInTheDocument()
        expect(answerBox()).toHaveValue('')
    })

    /**
     * The caret is not taken from somebody who is in the middle of a sentence.
     *
     * Autofocus was right for the modal this used to be and wrong for a block in the feed: the
     * composer stays enabled while a turn streams, so a question arriving mid-sentence yanked the
     * caret out and the rest of what the user was typing landed in the answer box.
     */
    it('leaves the caret where the user is typing, and takes it when nobody is', () => {
        const composer = document.createElement('textarea')
        document.body.append(composer)
        composer.focus()

        show(call(), [question()])

        expect(document.activeElement).toBe(composer)
        composer.remove()
        cleanup()

        show(call(), [question()])
        expect(document.activeElement).toBe(answerBox())
    })

    /**
     * Two questions can share one block, and what is typed into it belongs to one of them.
     *
     * A delegated child's questions all carry the parent's call id, and `useAskedQuestion` takes the
     * first in the queue. Answering settles it synchronously and the next takes its place in the
     * same mounted block with no render in between — so a guard on the revision alone let the draft
     * through: `next_revision` counts per question id, and two different questions are both round
     * one.
     */
    it('keeps no answer across two questions that share a block', async () => {
        const answer = vi.fn<(response: UserQuestionResponse) => void>()
        const first = question()
        const second = question({questionId: 'q-2', question: 'And where does the HUD sit?'})
        const view = render(
            <AskedQuestionsContext value={{questions: [first, second], answer}}>
                <AskBlock tool={call()} />
            </AskedQuestionsContext>
        )
        await userEvent.type(answerBox(), 'its own scene, please')

        view.rerender(
            <AskedQuestionsContext value={{questions: [second], answer}}>
                <AskBlock tool={call()} />
            </AskedQuestionsContext>
        )

        expect(screen.getByText('And where does the HUD sit?')).toBeInTheDocument()
        expect(answerBox()).toHaveValue('')
    })

    /**
     * Any question can be sent back for another round, not only a layout.
     *
     * A delegated question has had this since the first build, as "Send changes". An ordinary one
     * had nothing: the model read the answer and decided for itself whether to come back. That was
     * the old two-tool split surviving as a control.
     */
    it('offers another round on an ordinary question', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.type(answerBox(), 'narrower than that')
        await userEvent.click(screen.getByRole('button', {name: 'Ask me again'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({answer: 'narrower than that', again: true})
        )
    })

    /** And Send is the other half of the pair: this is the answer, carry on. */
    it('sends without asking for another round', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.type(answerBox(), 'its own scene')
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))

        expect(answer).toHaveBeenCalledWith(expect.not.objectContaining({again: true}))
    })

    /** Inside a delegation the same control is the loop going round, and it is named for that. */
    it('names the round-again control for the loop it is inside', () => {
        show(call(), [question({sketches: TWO, isDelegated: true})])

        expect(screen.getByRole('button', {name: 'Send changes'})).toBeInTheDocument()
        expect(screen.queryByRole('button', {name: 'Ask me again'})).not.toBeInTheDocument()
        // A delegation's ending is the button that agrees it, so there is no plain Send beside it.
        expect(screen.queryByRole('button', {name: 'Send'})).not.toBeInTheDocument()
    })

    /** Story 3: several sketches, one picked, and it sends. */
    it('sends the sketch that was chosen', async () => {
        const {answer} = show(call(), [question({sketches: TWO, isDelegated: true})])

        await userEvent.click(screen.getByRole('button', {name: 'Choose Side rail'}))
        await userEvent.click(screen.getByRole('button', {name: 'Send changes'}))

        expect(answer).toHaveBeenCalledWith(expect.objectContaining({picked: 1, again: true}))
    })

    /**
     * Story 4: the user iterates until it is right, then ends it.
     *
     * The ending is the button and nothing else. Held shut until a sketch is chosen, because
     * approving without one hands the agent three layouts and the news that the user liked a layout.
     */
    it('ends a delegation on the button, and only once something is chosen', async () => {
        const {answer} = show(call(), [question({sketches: TWO, isDelegated: true, revision: 3})])

        expect(screen.getByRole('button', {name: 'Done, build it'})).toBeDisabled()
        await userEvent.click(screen.getByRole('button', {name: 'Choose Bar across the top'}))
        await userEvent.click(screen.getByRole('button', {name: 'Done, build it'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({picked: 0, approved: true, questionId: 'q-1'})
        )
    })

    /** A question with nothing drawn on it has nothing to pick, so ending it is a decision alone. */
    it('lets a delegated question in words be ended without a pick', () => {
        show(call(), [question({isDelegated: true})])

        expect(screen.getByRole('button', {name: 'Done, build it'})).toBeEnabled()
    })

    /** And an ordinary question has no delegation to end, so it is not offered one. */
    it('offers no ending button outside a delegation', () => {
        show(call(), [question()])

        expect(screen.queryByRole('button', {name: 'Done, build it'})).not.toBeInTheDocument()
    })

    /** Story 5: skipping is a decision, and the agent is told so rather than told nothing. */
    it('reports a skip as a skip', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.click(screen.getByRole('button', {name: 'Let the agent decide'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', skipped: true})
        )
    })

    /** Story 6: an answer that is none of the options, which is the common case. */
    it('sends what the user wrote when it is none of the options', async () => {
        const {answer} = show(call(), [question()])

        await userEvent.type(answerBox(), 'a separate scene, autoloaded')
        await userEvent.click(screen.getByRole('button', {name: 'Send'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({answer: 'a separate scene, autoloaded'})
        )
    })

    /**
     * Story 7: the turn is stopped mid-question.
     *
     * Rust settles the question when the run ends, so it leaves the queue and the call ends. Nothing
     * here has to know about a stop: with no question waiting and a call that is over, the block
     * draws its finished self.
     */
    it('settles rather than hanging when the turn is stopped mid-question', () => {
        show(call({status: 'error', endedAt: 1, output: 'The question was cancelled.'}), [])

        expect(screen.queryByRole('textbox', {name: /Your answer/u})).not.toBeInTheDocument()
        expect(screen.getByText('not asked')).toBeInTheDocument()
    })

    /**
     * Before there is anything to answer, the block says the agent is working.
     *
     * A delegation spends a minute reading the project before it draws anything, and without this
     * that minute is a blank stretch of feed. The live line is the child's own step, which the
     * timeline already carries.
     */
    it('reports what the child is doing while there is nothing to answer', () => {
        show(call({step: 'read res://ui/pause_menu.tscn'}), [])

        expect(screen.getByText(/read res:\/\/ui\/pause_menu\.tscn/u)).toBeInTheDocument()
    })

    /** A question belonging to another call is another block's, and this one leaves it alone. */
    it('takes only the question that names its own call', () => {
        show(call(), [question({ownerCallId: 'call-2'})])

        expect(screen.queryByRole('textbox', {name: /Your answer/u})).not.toBeInTheDocument()
    })

    /**
     * Once answered it is one line, which is what a reloaded conversation has too.
     *
     * The sketches are not in the transcript — they are in project storage — so an agreed design
     * points at the tab that holds them rather than trying to draw one it never had.
     */
    it('collapses to a line once it is answered', async () => {
        const {openTab} = show(
            call({
                status: 'complete',
                endedAt: 1,
                output: `They agreed it.\n\n${AGREED_SKETCH_MARK} ("Side rail").`
            }),
            []
        )

        expect(screen.getByText('design agreed')).toBeInTheDocument()
        const line = screen.getByRole('button', {name: /Where does the pause menu live/u})
        expect(line).toHaveAttribute('aria-expanded', 'false')
        await userEvent.click(line)
        expect(line).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText(/They agreed it/u)).toBeVisible()
        await userEvent.click(screen.getByRole('button', {name: 'Open the Design tab'}))
        expect(openTab).toHaveBeenCalledWith('sketches')
    })

    /** An ordinary answered question has no layout anywhere, so it points at nothing. */
    it('says nothing about a design when there was none', () => {
        show(call({status: 'complete', endedAt: 1, output: 'They said: "its own scene".'}), [])

        expect(screen.getByText('answered')).toBeInTheDocument()
        expect(screen.queryByText('design agreed')).not.toBeInTheDocument()
    })
})

/**
 * A question that belongs to no tool call, which is the only kind a task brief asks.
 *
 * A brief runs before the first turn exists, so there is no assistant message and no `ask_user`
 * block for one to live in. The modal this replaced drew any question at all; with that gone, a
 * question naming no call reached nobody and the plan sat on its full thirty-minute timeout.
 */
describe('a question with no call to belong to', () => {
    const showUnowned = (questions: readonly UserQuestionPrompt[]) => {
        const answer = vi.fn<(response: UserQuestionResponse) => void>()
        render(
            <OpenCenterTabContext value={vi.fn<(tab: CenterTab) => void>()}>
                <AskedQuestionsContext value={{questions, answer}}>
                    <UnownedAsk />
                </AskedQuestionsContext>
            </OpenCenterTabContext>
        )
        return {answer}
    }

    it('is drawn where the conversation is not, and answers', async () => {
        const {ownerCallId: _named, ...unowned} = question()
        const {answer} = showUnowned([unowned])

        await userEvent.click(screen.getByRole('button', {name: 'inside the HUD'}))

        expect(answer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', answer: 'inside the HUD'})
        )
    })

    /** Every other question has a block of its own, and drawing it here draws it twice. */
    it('leaves a question that names a call to that call', () => {
        showUnowned([question()])

        expect(screen.queryByRole('button', {name: 'inside the HUD'})).not.toBeInTheDocument()
    })

    /**
     * The one control a brief cannot honour is not offered.
     *
     * `again` reaches the model as a sentence, on the tool path. A brief calls the host directly and
     * reads the answer's words and nothing else, so the button sent a flag nothing read: the user
     * marked their answer as half-formed and the plan was written from it as final.
     */
    it('does not offer another round nothing would come back for', () => {
        const {ownerCallId: _named, ...unowned} = question()
        showUnowned([unowned])

        expect(screen.queryByRole('button', {name: 'Ask me again'})).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Send'})).toBeInTheDocument()
    })
})
