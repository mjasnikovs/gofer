import {createContext, use, useCallback} from 'react'
import {invoke} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {useSettledQueue} from './useSettledQueue'
import type {UserQuestionPrompt, UserQuestionResponse} from '../models/brief'

type UserQuestionOptions = Readonly<{
    onError: (message: string) => void
}>

const keyOf = (prompt: UserQuestionPrompt) => prompt.questionId

export function useUserQuestions({onError}: UserQuestionOptions) {
    const {queue: questions, settle} = useSettledQueue<UserQuestionPrompt>({
        requestEvent: 'ai-question-request',
        settledEvent: 'ai-question-settled',
        keyOf
    })

    const answer = useCallback(
        (request: UserQuestionResponse) => {
            settle(request.questionId)
            void invoke('respond_user_question', {request}).catch((error: unknown) => {
                onError(`The answer could not be sent: ${commandErrorMessage(error)}`)
            })
        },
        [onError, settle]
    )

    return {questions, answer}
}

export type AskedQuestions = Readonly<{
    questions: readonly UserQuestionPrompt[]
    answer: (response: UserQuestionResponse) => void
}>

export const AskedQuestionsContext = createContext<AskedQuestions | undefined>(undefined)

export function useAskedQuestion(ownerCallId: string) {
    const asked = use(AskedQuestionsContext)
    return {
        prompt: asked?.questions.find(question => question.ownerCallId === ownerCallId),
        answer: asked?.answer
    }
}

export function useWaitingQuestions(): readonly UserQuestionPrompt[] {
    return use(AskedQuestionsContext)?.questions ?? NOTHING_WAITING
}

const NOTHING_WAITING: readonly UserQuestionPrompt[] = []

export function useUnownedQuestion() {
    const asked = use(AskedQuestionsContext)
    return {
        prompt: asked?.questions.find(question => question.ownerCallId === undefined),
        answer: asked?.answer
    }
}
