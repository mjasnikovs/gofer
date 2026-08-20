import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {UserQuestionDialog} from './UserQuestionDialog'
import type {UserQuestionPrompt, UserQuestionResponse} from '../../models/brief'

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

const question: UserQuestionPrompt = {
    questionId: 'q-1',
    question: 'Where does the pause menu live?',
    options: ['its own scene', 'inside the HUD'],
    sketches: [],
    why: 'it changes the scene tree',
    revision: 1
}

const ONE = [{label: 'Bar across the top', html: '<p>a</p>'}]
const TWO = [
    {label: 'Bar across the top', html: '<p>a</p>'},
    {label: 'Side rail', html: '<p>b</p>'}
]

// Not a default parameter: `show(undefined)` would take the default and quietly test the opposite
// of what it says.
const show = (...prompts: readonly (UserQuestionPrompt | undefined)[]) => {
    const prompt = prompts.length === 0 ? question : prompts[0]
    const onAnswer = vi.fn<(response: UserQuestionResponse) => void>()
    const view = render(
        <UserQuestionDialog
            prompt={prompt}
            onAnswer={onAnswer}
        />
    )
    return {onAnswer, view}
}

const answerBox = () => screen.getByRole('textbox', {name: /Your answer/u})

describe('asking the user something', () => {
    it('shows nothing when nothing is waiting', () => {
        show(undefined)
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('asks the question and says what turns on it', () => {
        show()
        expect(screen.getByText('Where does the pause menu live?')).toBeInTheDocument()
        expect(screen.getByText('it changes the scene tree')).toBeInTheDocument()
    })

    /*
     * The suggestions are shortcuts, not the only way in. Picking one fills the box so the user can
     * take it, edit it, or ignore it — which is the difference between offering an answer and
     * constraining one.
     */
    it('fills the box from a suggestion rather than answering for the user', async () => {
        const {onAnswer} = show()

        await userEvent.click(screen.getByText('its own scene'))

        expect(answerBox()).toHaveValue('its own scene')
        expect(onAnswer).not.toHaveBeenCalled()
    })

    it('sends what the user wrote', async () => {
        const {onAnswer} = show()

        await userEvent.type(answerBox(), 'a CanvasLayer on the level')
        await userEvent.click(screen.getByRole('button', {name: 'Answer'}))

        expect(onAnswer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', answer: 'a CanvasLayer on the level'})
        )
    })

    // Something has to be said either way: there is a tool call on the other side holding a thread
    // open. A skip says the user read it and left the decision to the agent.
    it('sends a skip rather than an empty answer', async () => {
        const {onAnswer} = show()

        await userEvent.click(screen.getByRole('button', {name: 'Let the agent decide'}))

        expect(onAnswer).toHaveBeenCalledWith(
            expect.objectContaining({questionId: 'q-1', skipped: true})
        )
    })

    it('does not offer to send an answer nobody wrote', async () => {
        show()
        expect(screen.getByRole('button', {name: 'Answer'})).toBeDisabled()

        await userEvent.type(answerBox(), '   ')
        expect(screen.getByRole('button', {name: 'Answer'})).toBeDisabled()
    })

    /*
     * An answer typed for one question must never reach the next.
     *
     * The agent can have more than one call in flight, so the card is re-pointed at a different
     * question while the box still holds text meant for the last one.
     */
    it('clears the box when the question changes', async () => {
        const onAnswer = vi.fn<(response: UserQuestionResponse) => void>()
        const view = render(
            <UserQuestionDialog
                prompt={question}
                onAnswer={onAnswer}
            />
        )
        await userEvent.type(answerBox(), 'meant for the first one')

        view.rerender(
            <UserQuestionDialog
                prompt={{...question, questionId: 'q-2', question: 'Which input action?'}}
                onAnswer={onAnswer}
            />
        )

        expect(answerBox()).toHaveValue('')
    })

    /*
     * The asker puts the one it recommends first, and that is information the card used to throw
     * away — two options sat side by side with nothing saying which the agent would have picked.
     *
     * Marked twice on purpose. This theme is deliberately close to colourless, so a tint alone is a
     * distinction some screens and some readers will not see.
     */
    it('marks the recommended answer, in words as well as colour', () => {
        show()
        expect(screen.getAllByText('Recommended')).toHaveLength(1)

        const cards = document.querySelectorAll('.astryx-selectable-card')
        expect(cards).toHaveLength(2)
        expect(cards[0]?.getAttribute('data-variant')).toBe('green')
        expect(cards[1]?.getAttribute('data-variant')).not.toBe('green')
        expect(cards[0]?.textContent).toContain('its own scene')
    })

    it('asks a question that came with no suggestions at all', () => {
        show({...question, question: 'What should it be called?', options: []})
        expect(screen.getByText('What should it be called?')).toBeInTheDocument()
        expect(answerBox()).toBeInTheDocument()
    })

    /*
     * A question about a layout is the same question, drawn.
     *
     * Everything below is a defect the first build shipped: written suggestions repeated beside the
     * pictures of the same options, a sketch cut off by the column edge instead of scaled, and a
     * webfont that silently never arrived.
     */
    describe('when the question carries sketches', () => {
        const visual = (sketches: UserQuestionPrompt['sketches']) => show({...question, sketches})

        /** The sketches are the suggestions, drawn. Showing both lists is two answers for one ask. */
        it('does not repeat the written suggestions beside the pictures', () => {
            visual(TWO)
            expect(screen.queryByText('Suggested answers')).toBeNull()
            expect(screen.queryByText('its own scene')).toBeNull()
        })

        it('shows every sketch at once so they can be compared', () => {
            visual(TWO)
            expect(document.querySelectorAll('iframe')).toHaveLength(2)
            expect(screen.getByRole('button', {name: 'Open Bar across the top'})).toBeTruthy()
        })

        /**
         * A zoom is a viewer, not a second copy of the question.
         *
         * Everything that answers the question stays on the screen underneath, so there is never a
         * second place to answer from and no way to answer about a sketch that is not on screen.
         */
        it('shows one sketch on its own with nothing to answer', async () => {
            visual(TWO)

            await userEvent.click(screen.getByRole('button', {name: 'Open Side rail'}))

            expect(document.querySelectorAll('iframe')).toHaveLength(1)
            expect(screen.getByRole('button', {name: 'Close'})).toBeTruthy()
            expect(screen.queryByRole('button', {name: 'Answer'})).toBeNull()
            expect(screen.queryByRole('button', {name: /^Choose /u})).toBeNull()
            expect(screen.queryByRole('textbox')).toBeNull()
        })

        it('puts the question back when the zoom is closed', async () => {
            visual(TWO)

            await userEvent.click(screen.getByRole('button', {name: 'Open Side rail'}))
            await userEvent.click(screen.getByRole('button', {name: 'Close'}))

            expect(document.querySelectorAll('iframe')).toHaveLength(2)
            expect(screen.getByRole('button', {name: 'Answer'})).toBeTruthy()
        })

        /** One sketch is still the question, with its own button — not a viewer with no way out. */
        it('shows a lone sketch beside the controls that answer it', () => {
            visual(ONE)
            expect(document.querySelectorAll('iframe')).toHaveLength(1)
            expect(screen.getByRole('button', {name: 'Choose Bar across the top'})).toBeTruthy()
            expect(screen.getByRole('button', {name: 'Answer'})).toBeTruthy()
        })

        /**
         * A single sketch still needs a way to say yes.
         *
         * "Does this look right" is a question, and without a button the only way to agree with it
         * was to write the word out — which is a sentence the model then has to interpret.
         */
        it('lets a lone sketch be chosen', async () => {
            const {onAnswer} = visual(ONE)

            await userEvent.click(screen.getByRole('button', {name: 'Choose Bar across the top'}))
            await userEvent.click(screen.getByRole('button', {name: 'Answer'}))

            expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({picked: 0}))
        })

        /**
         * The asker puts the one it recommends first, and that is information the card threw away.
         *
         * Said in words as well as position, because nothing about being on the left says "this is
         * the one I would build".
         */
        it('marks the sketch the agent recommends', () => {
            visual(TWO)
            expect(screen.getAllByText('Recommended')).toHaveLength(1)
        })

        /**
         * The chosen one is filled, not disabled.
         *
         * Disabled, the answer the user had just given read as the one thing they were not allowed
         * to pick, and there was no way back to it after trying the other.
         */
        it('leaves the chosen sketch pickable so the choice can be changed', async () => {
            const {onAnswer} = visual(TWO)

            await userEvent.click(screen.getByRole('button', {name: 'Choose Side rail'}))
            const chosen = screen.getByRole('button', {name: 'Choose Side rail'})
            expect(chosen).toBeEnabled()
            expect(chosen).toHaveTextContent('Chosen')

            await userEvent.click(screen.getByRole('button', {name: 'Choose Bar across the top'}))
            await userEvent.click(screen.getByRole('button', {name: 'Answer'}))

            expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({picked: 0}))
        })

        it('carries which sketch was chosen, by its number', async () => {
            const {onAnswer} = visual(TWO)

            await userEvent.click(screen.getByRole('button', {name: 'Choose Side rail'}))
            await userEvent.click(screen.getByRole('button', {name: 'Answer'}))

            expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({picked: 1}))
        })

        /** A pick is a whole answer, so the button must not wait for words as well. */
        it('offers to send a pick with nothing written', async () => {
            visual(TWO)
            expect(screen.getByRole('button', {name: 'Answer'})).toBeDisabled()

            await userEvent.click(screen.getByRole('button', {name: 'Choose Side rail'}))

            expect(screen.getByRole('button', {name: 'Answer'})).toBeEnabled()
        })

        /**
         * What could not load is told to both of the people who need it.
         *
         * The user, so they judge the layout rather than the missing typeface; and the agent, so it
         * knows the sketch it wrote is not the sketch that was looked at.
         */
        it('says what the policy refused, on screen and in the answer', async () => {
            const {onAnswer} = visual([
                {label: 'Bar across the top', html: '<img src="https://fonts.test/a.png">'}
            ])

            expect(screen.getByText(/could not load/u)).toBeInTheDocument()

            await userEvent.type(answerBox(), 'inline it')
            await userEvent.click(screen.getByRole('button', {name: 'Answer'}))
            expect(onAnswer).toHaveBeenCalledWith(
                expect.objectContaining({blocked: ['https://fonts.test/…/a.png']})
            )
        })

        /** A revision is the same question again, so the box it is answered in starts empty. */
        it('empties the box when the next revision arrives', async () => {
            const onAnswer = vi.fn<(response: UserQuestionResponse) => void>()
            const view = render(
                <UserQuestionDialog
                    prompt={{...question, sketches: ONE, revision: 1}}
                    onAnswer={onAnswer}
                />
            )
            await userEvent.type(answerBox(), 'tighter')

            view.rerender(
                <UserQuestionDialog
                    prompt={{...question, sketches: ONE, revision: 2}}
                    onAnswer={onAnswer}
                />
            )

            expect(answerBox()).toHaveValue('')
        })
    })

    /*
     * A design loop is several askings about one layout, and the card is the loop rather than one
     * asking of it.
     *
     * Every test here is a way the first build made a loop look like a queue: the card vanishing on
     * every answer, a revision arriving with nothing saying it was one, and no way out but to stop
     * replying.
     */
    describe('a question that belongs to a design loop', () => {
        const round = (over: Partial<UserQuestionPrompt> = {}) => ({
            ...question,
            sketches: TWO,
            designSession: 'design-1',
            ...over
        })

        const inLoop = (prompt: UserQuestionPrompt, isRedrawing = false) => {
            const onAnswer = vi.fn<(response: UserQuestionResponse) => void>()
            const view = render(
                <UserQuestionDialog
                    prompt={prompt}
                    isRedrawing={isRedrawing}
                    onAnswer={onAnswer}
                />
            )
            return {onAnswer, view}
        }

        /** The button that ends the loop as agreed, rather than by the user giving up on it. */
        it('ends the design on the layout the user chose', async () => {
            const {onAnswer} = inLoop(round())

            await userEvent.click(screen.getByRole('button', {name: 'Choose Side rail'}))
            await userEvent.click(screen.getByRole('button', {name: 'Complete and handoff'}))

            expect(onAnswer).toHaveBeenCalledWith(
                expect.objectContaining({questionId: 'q-1', picked: 1, approved: true})
            )
        })

        /*
         * Approving without a pick hands the agent three layouts and the news that the user liked
         * one, which is not an answer it can build from.
         */
        it('will not end the design until a layout is chosen', async () => {
            inLoop(round())
            expect(screen.getByRole('button', {name: 'Complete and handoff'})).toBeDisabled()

            await userEvent.click(screen.getByRole('button', {name: 'Choose Side rail'}))
            expect(screen.getByRole('button', {name: 'Complete and handoff'})).toBeEnabled()
        })

        /** Words about a sketch are a change to make, and a change is another round. */
        it('sends changes without ending the design', async () => {
            const {onAnswer} = inLoop(round())

            await userEvent.type(answerBox(), 'the title is too big')
            await userEvent.click(screen.getByRole('button', {name: 'Send changes'}))

            expect(onAnswer).toHaveBeenCalledWith(expect.not.objectContaining({approved: true}))
        })

        /*
         * The revision has been on the prompt since the first build and was never drawn, so a
         * layout the user had already commented on came back looking like a brand new question.
         */
        it('says which round the user is on', () => {
            inLoop(round({revision: 3}))
            expect(screen.getByText('Round 3')).toBeInTheDocument()
        })

        it('does not label the first round', () => {
            inLoop(round({revision: 1}))
            expect(screen.queryByText(/^Round /u)).not.toBeInTheDocument()
        })

        /*
         * Between rounds the card stays and the sketches go.
         *
         * A layout the user can still read but can no longer act on invites them to keep judging one
         * that is already being replaced.
         */
        it('holds the card open while the agent redraws', () => {
            inLoop(round({revision: 2}), true)

            expect(screen.getByText('Design in progress')).toBeInTheDocument()
            expect(screen.getByText(/Round 2 sent/u)).toBeInTheDocument()
            expect(screen.queryByRole('button', {name: 'Choose Side rail'})).not.toBeInTheDocument()
        })

        /** A stray Escape between rounds would end a design the user is halfway through. */
        it('cannot be dismissed by accident', async () => {
            const {onAnswer} = inLoop(round())

            await userEvent.keyboard('{Escape}')

            expect(onAnswer).not.toHaveBeenCalled()
            expect(screen.getByRole('button', {name: 'Send changes'})).toBeInTheDocument()
        })

        /*
         * The backend sends the field, not its absence, and `null` is not `undefined`.
         *
         * A live sweep found this: every ordinary question arrived carrying `designSession: null`,
         * so the card read it as a design round. It grew the button that ends a loop, renamed its
         * Answer control, and stopped closing on Escape. The payload no longer carries the null
         * either — this is the half that holds if it ever does again.
         */
        it('reads a null session as no session at all', async () => {
            const {onAnswer} = inLoop({
                ...question,
                designSession: null
            } as unknown as UserQuestionPrompt)

            expect(
                screen.queryByRole('button', {name: 'Complete and handoff'})
            ).not.toBeInTheDocument()
            expect(screen.getByRole('button', {name: 'Answer'})).toBeInTheDocument()

            await userEvent.keyboard('{Escape}')
            expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({skipped: true}))
        })

        /** An ordinary question is unchanged: Escape is still the user leaving it to the agent. */
        it('leaves an ordinary question dismissable', async () => {
            const {onAnswer} = inLoop(question)

            await userEvent.keyboard('{Escape}')

            expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({skipped: true}))
        })
    })
})
