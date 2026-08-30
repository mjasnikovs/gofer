import {turnState} from './ai-events.mjs'

export function withoutTrailingAnswer(messages) {
    return messages.at(-1)?.role === 'assistant' ? messages.slice(0, -1) : messages
}

export function createTranscript(agent, emit) {
    return {
        messages: () => agent.state.messages,

        checkpoint: () => {
            emit(turnState(agent.state.messages))
        },

        replaceWith: compacted => {
            agent.state.messages = compacted
            return compacted
        },

        dropTrailingAnswer: () => {
            agent.state.messages = withoutTrailingAnswer(agent.state.messages)
            return agent.state.messages
        }
    }
}
