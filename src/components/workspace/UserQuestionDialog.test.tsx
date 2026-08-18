import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {UserQuestionDialog} from './UserQuestionDialog'
import type {UserQuestionPrompt} from '../../models/brief'

afterEach(cleanup)

const question: UserQuestionPrompt = {
    questionId: 'q-1',
    question: 'Where does the pause menu live?',
    options: ['its own scene', 'inside the HUD'],
    why: 'it changes the scene tree'
}

// Not a default parameter: `show(undefined)` would take the default and quietly test the opposite
// of what it says.
const show = (...prompts: readonly (UserQuestionPrompt | undefined)[]) => {
    const prompt = prompts.length === 0 ? question : prompts[0]
    const onAnswer = vi.fn<(questionId: string, answer: string | null) => void>()
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

        expect(onAnswer).toHaveBeenCalledWith('q-1', 'a CanvasLayer on the level')
    })

    // Something has to be said either way: there is a tool call on the other side holding a thread
    // open. A skip says the user read it and left the decision to the agent.
    it('sends a skip rather than an empty answer', async () => {
        const {onAnswer} = show()

        await userEvent.click(screen.getByRole('button', {name: 'Let the agent decide'}))

        expect(onAnswer).toHaveBeenCalledWith('q-1', null)
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
        const onAnswer = vi.fn<(questionId: string, answer: string | null) => void>()
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
        const badges = screen.getAllByText('Recommended')
        expect(badges).toHaveLength(1)

        const cards = document.querySelectorAll('.astryx-selectable-card')
        expect(cards).toHaveLength(2)
        expect(cards[0]?.getAttribute('data-variant')).toBe('green')
        expect(cards[1]?.getAttribute('data-variant')).not.toBe('green')
        // And it is the first option that carries it, which is the one the asker recommended.
        expect(cards[0]?.textContent).toContain('its own scene')
    })

    it('asks a question that came with no suggestions at all', () => {
        show({questionId: 'q-3', question: 'What should it be called?', options: [], why: ''})
        expect(screen.getByText('What should it be called?')).toBeInTheDocument()
        expect(answerBox()).toBeInTheDocument()
    })
})
