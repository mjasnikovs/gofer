const MEMORY_HEADING = 'Relevant persistent project memory:'

export function turnContextText({memoryContext, sessionContext, inventory} = {}) {
    const blocks = []
    if (memoryContext) blocks.push(`${MEMORY_HEADING}\n${memoryContext}`)
    if (sessionContext) blocks.push(sessionContext)
    if (inventory) blocks.push(inventory)
    if (blocks.length === 0) return undefined
    return blocks.join('\n\n')
}

function withText(message, text) {
    if (typeof message.content === 'string') {
        return {...message, content: `${message.content}\n\n${text}`}
    }
    if (!Array.isArray(message.content)) return message
    return {...message, content: [...message.content, {type: 'text', text}]}
}

function lastAsked(messages) {
    let at = -1
    for (const [index, message] of messages.entries()) {
        if (message.role === 'user') at = index
    }
    return at
}

export function withTurnContext(messages, text, anchor = {}) {
    if (!text || !Array.isArray(messages)) return messages
    let at = anchor.asked === undefined ? -1 : messages.indexOf(anchor.asked)
    if (at < 0) {
        at = lastAsked(messages)
        anchor.asked = at < 0 ? undefined : messages[at]
    }
    if (at < 0) return [{role: 'user', content: text}, ...messages]
    return messages.map((message, index) => (index === at ? withText(message, text) : message))
}
