const MEMORY_HEADING = 'Relevant persistent project memory:'

export function scratchLine(scratchPath) {
    return (
        `Scratch directory: ${scratchPath}. Every tool can read and write there by that full path, `
        + 'and nothing there is part of the project. Everything outside it is the project, named '
        + 'from the project root.'
    )
}

/** Everything the transcript already puts in front of the model, as plain text. */
export function carriedText(messages) {
    if (!Array.isArray(messages)) return ''
    return messages
        .flatMap(message =>
            typeof message.content === 'string' ? [message.content]
            : Array.isArray(message.content) ?
                message.content.filter(part => part.type === 'text').map(part => part.text)
            :   []
        )
        .join('\n')
}

/**
 * What this turn tells the model about the project, skipping what the conversation already says.
 *
 * The session line and the memories are a few lines and are sent every turn, because they answer
 * questions whose answer flips back and forth. The file inventory is the git index — 36 KB in one
 * real project — and a copy per turn would fill the context window in ten. It is sent once and
 * again only when it has actually changed, which is what its own wording already promises.
 */
export function turnContextText(
    {memoryContext, sessionContext, scratchPath, inventory} = {},
    carried = ''
) {
    const blocks = []
    if (memoryContext) blocks.push(`${MEMORY_HEADING}\n${memoryContext}`)
    if (sessionContext) blocks.push(sessionContext)
    if (scratchPath) blocks.push(scratchLine(scratchPath))
    if (inventory && !carried.includes(inventory)) blocks.push(inventory)
    if (blocks.length === 0) return undefined
    return blocks.join('\n\n')
}

/**
 * Puts the turn's context on the question that starts the turn, in the message the transcript
 * keeps.
 *
 * It used to be glued on at request time, to whichever user message was last. Nothing stored it,
 * so the next turn resent that same message without it and the server re-prefilled the whole
 * conversation — 26091 tokens where 28 were new, measured live. A block the transcript owns is
 * sent identically for the rest of the conversation, which is the only thing a prompt cache reads.
 */
export function withTurnContext(message, text) {
    if (!text || !message) return message
    if (typeof message.content === 'string') {
        return {...message, content: `${message.content}\n\n${text}`}
    }
    if (!Array.isArray(message.content)) return message
    return {...message, content: [...message.content, {type: 'text', text}]}
}

/**
 * Puts the block back on the question when a transcript has arrived without one: a retry carrying
 * on from a stored turn, or a compaction that folded the question away. Once only — a second copy
 * would be the rewrite the block exists to avoid.
 */
export function carryTurnContext(messages, text) {
    if (!text || !Array.isArray(messages)) return messages
    let at = -1
    for (const [index, message] of messages.entries()) if (message.role === 'user') at = index
    if (at < 0 || carriedText(messages).includes(text)) return messages
    return messages.map((message, index) =>
        index === at ? withTurnContext(message, text) : message
    )
}
