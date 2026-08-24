import {createContext, use, useCallback} from 'react'
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

/**
 * The questions waiting right now, published rather than passed.
 *
 * A question is drawn by the block in the conversation feed that asked it, and that block is several
 * components below the one that owns this hook — inside a message, inside the list, inside the IDE
 * frame. Handing it down as a prop would mean threading it through every one of them, and a streamed
 * reply replaces that conversation once per token.
 *
 * So the hook is still mounted once, and what it holds travels here, reaching only the blocks that
 * read it. Two questions can be live at once and each block takes its own by `ownerCallId`.
 */
export type AskedQuestions = Readonly<{
    questions: readonly UserQuestionPrompt[]
    answer: (response: UserQuestionResponse) => void
}>

export const AskedQuestionsContext = createContext<AskedQuestions | undefined>(undefined)

/**
 * The question this tool call is waiting on, and where its answer goes.
 *
 * Answers `undefined` for the context itself when there is none, which is what a test rendering one
 * message on its own gets. A block with nowhere to send an answer draws its finished state, which is
 * the honest thing for it to draw.
 */
export function useAskedQuestion(ownerCallId: string) {
    const asked = use(AskedQuestionsContext)
    return {
        prompt: asked?.questions.find(question => question.ownerCallId === ownerCallId),
        answer: asked?.answer
    }
}

/**
 * Every question waiting right now, for whoever has to notice that one arrived.
 *
 * The blocks that draw a question take theirs by owner; this is the whole queue, and its one reader
 * is the frame. Both places a question can be drawn — the block in the conversation and the slot
 * beside the composer — are inside the chat column, and the chat column is mounted only while the
 * Chat tab is showing. So a question asked while the user was watching the game, or the scripts, or
 * a design appeared nowhere at all and blocked its full thirty minutes. Approvals never had that
 * problem: their dialog is mounted beside the frame rather than inside it.
 */
export function useWaitingQuestions(): readonly UserQuestionPrompt[] {
    return use(AskedQuestionsContext)?.questions ?? NOTHING_WAITING
}

/** One array, so a frame reading an empty queue is not re-rendered by its identity. */
const NOTHING_WAITING: readonly UserQuestionPrompt[] = []

/**
 * A question that names no call, and where its answer goes.
 *
 * `ownerCallId` is put on a request by the `ask_user` tool, which means it is there for every
 * question a chat turn asks. A task brief asks its grill questions before the first turn exists —
 * no assistant message, no tool row, nothing for a block to hang on — so it names no call, and with
 * `AskBlock` as the only reader those questions reached nobody and timed out after thirty minutes.
 *
 * So one is drawn beside the composer instead, which is on screen whether or not a conversation is.
 * Only the oldest is taken: nothing asks two of these at once, and a queue of cards in that slot
 * would push the plan's own progress off the screen.
 */
export function useUnownedQuestion() {
    const asked = use(AskedQuestionsContext)
    return {
        prompt: asked?.questions.find(question => question.ownerCallId === undefined),
        answer: asked?.answer
    }
}
