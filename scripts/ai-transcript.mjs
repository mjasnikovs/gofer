import {turnState} from './ai-events.mjs'

/**
 * What the model is given as its memory, and the only thing allowed to change it.
 *
 * The transcript is not the conversation: it holds tool calls and their results, it is opaque to
 * the renderer, and it is stored on every step of a turn rather than only at a clean end, so a turn
 * that crashed still leaves the model holding what it did.
 *
 * It had five writers spread over three hundred lines of `runAgent` — a retry entry point, a
 * mid-turn compaction, a checkpoint, an overflow recovery, and a retry rollback — plus two places
 * that emitted the checkpoint event. Two of the five wrote out "take the trailing answer off"
 * verbatim, and nothing said they had to agree. The invariants are real and none of them was
 * anywhere: stored is what is sent, so a compaction has to replace both; the checkpoint is emitted
 * at every step, not only at the end; and an answer that failed is taken back off before the model
 * is asked again, because left on it teaches the model that its own last word was the provider's
 * error text and the next answer is written to match.
 */

/**
 * The transcript with a trailing assistant message removed, if there is one.
 *
 * One definition, used by the retry rollback and by the overflow recovery. They wrote it out
 * separately, which is two chances to disagree about what "the answer" is.
 *
 * Distinct from the loop in `retryEntry`, which strips *every* trailing assistant message rather
 * than one: that is unwinding a whole failed turn back to the prompt, and this is taking one answer
 * off the end. They look alike and mean different things, so they stay apart.
 */
export function withoutTrailingAnswer(messages) {
    return messages.at(-1)?.role === 'assistant' ? messages.slice(0, -1) : messages
}

/**
 * Wraps the agent's message list so that everything which changes it goes through one place.
 *
 * `agent.state.messages` stays the storage — Pi owns the agent — but nothing outside this assigns
 * to it.
 */
export function createTranscript(agent, emit) {
    return {
        /** What the model remembers, and therefore what the next request sends. */
        messages: () => agent.state.messages,

        /**
         * Tells the desktop what the model remembers now.
         *
         * The only emitter of `turn-state`. It used to be emitted from two places — the step
         * subscriber and the failure path — and a third would have been easy to add and easy to
         * forget.
         */
        checkpoint: () => {
            emit(turnState(agent.state.messages))
        },

        /**
         * Replaces the transcript wholesale, which is what a compaction does.
         *
         * Stored is what is sent: the checkpoint and the next request have to agree on what the
         * model remembers, so a compaction that wrote only one of them would leave the desktop
         * holding a memory the model does not have.
         */
        replaceWith: compacted => {
            agent.state.messages = compacted
            return compacted
        },

        /** Takes the trailing answer off. See `withoutTrailingAnswer`. */
        dropTrailingAnswer: () => {
            agent.state.messages = withoutTrailingAnswer(agent.state.messages)
            return agent.state.messages
        }
    }
}
