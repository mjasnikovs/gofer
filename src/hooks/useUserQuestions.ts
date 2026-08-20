import {useCallback} from 'react'
import {invoke} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {useSettledQueue} from './useSettledQueue'
import type {UserQuestionPrompt, UserQuestionResponse} from '../models/brief'

type UserQuestionOptions = Readonly<{
    onError: (message: string) => void
}>

const keyOf = (prompt: UserQuestionPrompt) => prompt.questionId

/**
 * Tracks the questions the agent is waiting on an answer to.
 *
 * Not a brief feature, despite being what the brief's grill phase was built for. `ask_user` is an
 * ordinary tool, so an ordinary chat turn can ask the user something too — which is a thing Gofer
 * could not do at all before. This hook is mounted once, beside the approvals dialog, and knows
 * nothing about briefs.
 *
 * Answering and skipping are different, and both are answers. A skip means the user read the
 * question and left the decision to the agent, which is a decision of its own; the agent is told so
 * and told not to ask again. An answer carrying nothing at all — no words, no pick, no marks — means
 * the same thing and the backend reads it that way, so the card cannot produce a decision nobody
 * made.
 */
export function useUserQuestions({onError}: UserQuestionOptions) {
    const {queue: questions, settle} = useSettledQueue<UserQuestionPrompt>({
        requestEvent: 'ai-question-request',
        settledEvent: 'ai-question-settled',
        keyOf
    })

    const answer = useCallback(
        (request: UserQuestionResponse) => {
            // Dropped here as well as on the settled event: the agent resumes the moment the backend
            // has the answer, and the card must not outlive that.
            settle(request.questionId)
            void invoke('respond_user_question', {request}).catch((error: unknown) => {
                onError(`The answer could not be sent: ${commandErrorMessage(error)}`)
            })
        },
        [onError, settle]
    )

    return {questions, answer}
}
