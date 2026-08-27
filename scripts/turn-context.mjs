/**
 * The three blocks a turn knows that the conversation does not: what the project remembers, what
 * the editor is doing, and which files it tracks.
 *
 * They used to be concatenated onto the system prompt. All three are re-derived every turn — the
 * memory block is a search keyed on the words the user just typed — so the system message was never
 * twice the same, and every provider's prompt cache begins at the system message. Measured across
 * one project's 1,645 requests: 96.6% of the prompt was served from cache inside a turn and 14.3%
 * at a turn boundary, and the cached prefix stopped at 9,728 tokens every time, which is the base
 * prompt and the tool schemas and not one byte more.
 *
 * So they are sent at the tail instead, where the conversation is new anyway. Nothing here reads a
 * file, a clock or a database: what a turn knows is gathered in Rust and handed over whole.
 */

/** How the memory block is introduced, so a model that sees it knows what it is looking at. */
const MEMORY_HEADING = 'Relevant persistent project memory:'

/**
 * The turn's own context as one block of text, or nothing when the turn knows none of it.
 *
 * The order is the order it has always been sent in. It is not alphabetical and it is not
 * accidental: memory is the least certain of the three and the session line is the one the prompt
 * points at, so the listing the model reads last is the one it can act on without checking.
 */
export function turnContextText({memoryContext, sessionContext, inventory} = {}) {
    const blocks = []
    if (memoryContext) blocks.push(`${MEMORY_HEADING}\n${memoryContext}`)
    if (sessionContext) blocks.push(sessionContext)
    if (inventory) blocks.push(inventory)
    if (blocks.length === 0) return undefined
    return blocks.join('\n\n')
}

/** A message's text parts, appended to. `content` is a string until an image makes it a list. */
function withText(message, text) {
    if (typeof message.content === 'string') {
        return {...message, content: `${message.content}\n\n${text}`}
    }
    if (!Array.isArray(message.content)) return message
    return {...message, content: [...message.content, {type: 'text', text}]}
}

/** The last thing the user said, which is where the block goes when nothing is anchored yet. */
function lastAsked(messages) {
    let at = -1
    for (const [index, message] of messages.entries()) {
        if (message.role === 'user') at = index
    }
    return at
}

/**
 * The conversation as it goes to the model: the stored messages, with this turn's context on the
 * tail of the message the turn anchored to.
 *
 * The last *user* message, not the last message. A turn is one prompt and then twenty-odd tool
 * results, and anchoring on the end would move the block down the conversation on every one of
 * them — which is the same cache miss this exists to remove, twenty-four times a turn instead of
 * once.
 *
 * And once anchored, it stays there for the whole turn. A turn can gain a second user message
 * partway through — a red verify report is asked as one — and re-anchoring onto it would take the
 * block off the original prompt, which every earlier request of that turn had already sent it on.
 * The prefix would then break at the prompt and throw away the twenty tool results behind it: the
 * same loss as before, once per re-prompted turn rather than once per keystroke. `anchor` is the
 * turn's memory of where it put the block, and it is held by identity so that a compaction — which
 * replaces the messages rather than adding to them — drops it and anchors afresh.
 *
 * Returns a copy. The caller is `transformContext`, whose result Pi binds to a local and never
 * writes back, so what is stored and what is re-sent next turn stay the words the user typed.
 */
export function withTurnContext(messages, text, anchor = {}) {
    if (!text || !Array.isArray(messages)) return messages
    let at = anchor.asked === undefined ? -1 : messages.indexOf(anchor.asked)
    if (at < 0) {
        at = lastAsked(messages)
        anchor.asked = at < 0 ? undefined : messages[at]
    }
    // Compaction can leave a transcript whose head is a summary and whose tail is a tool result.
    // There is no user message to hang this on then, and a turn told nothing about the project it
    // is in is worse than a turn with one extra message.
    //
    // At the front rather than the end. Nothing here can anchor it — the message is made fresh on
    // every request and was never stored, so the next request finds no user message either — and a
    // block appended to the tail is behind a transcript that grows by two messages a tool call.
    // That is the per-call cache miss this module exists to remove, so the one position that is
    // the same bytes on every request of the turn is the only one to put it in.
    if (at < 0) return [{role: 'user', content: text}, ...messages]
    return messages.map((message, index) => (index === at ? withText(message, text) : message))
}
