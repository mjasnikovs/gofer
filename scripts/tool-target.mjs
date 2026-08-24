/**
 * What one tool call is pointed at, in the few words a row has for it.
 *
 * One namer, because there were two and they disagreed. The parent's rows were named here; a child's
 * steps were named by a second function that knew `bash` and `read` and answered `read undefined` for
 * everything else — which was half of what a child may hold, since `web_search` and
 * `godot_docs_search` are on its list too. A child reading the web said it was reading a file called
 * nothing.
 *
 * Data in, string out, no imports. Both agents call it and a test can call it with a literal.
 */

/**
 * What one row of the chat says a domain call is doing.
 *
 * A call is a list, so the row names what the list holds rather than one operation: three
 * inspections read `inspect ×3`, and a mixed list names its operations in the order they run. The
 * entries themselves are under the row — this is the one line it collapses to.
 *
 * `op` beside the list is the shape a model wrote before the arguments were repaired, and the event
 * carrying it is emitted either side of that repair depending on the path, so both are read.
 */
function godotTarget(args) {
    const ops = Array.isArray(args.ops) ? args.ops.map(entry => entry?.op).filter(Boolean) : []
    if (ops.length === 0) return args.op
    if (ops.length === 1) return ops[0]
    const distinct = [...new Set(ops)]
    if (distinct.length === 1) return `${distinct[0]} ×${String(ops.length)}`
    return distinct.length > 3 ?
            `${distinct.slice(0, 3).join(', ')} +${String(distinct.length - 3)} more`
        :   distinct.join(', ')
}

/** One line of whatever was written, because a row is one line and does not un-wrap. */
function flatten(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
}

export function toolTarget(name, args) {
    const given = args ?? {}
    if (name === 'bash') return given.command
    if (name.startsWith('godot_')) return godotTarget(given)
    if (name === 'web_search') return given.query
    // The URL rather than the question: a row is read to see where the agent went, and two fetches
    // of different pages must not look like the same row.
    if (name === 'web_fetch') return given.url
    // A question carrying sketches is named by them: two revisions of one layout must not read as
    // the same row, and neither must two different layouts. Everything else is flattened, because a
    // question written as a paragraph lands in a row that is one line.
    if (name === 'ask_user') {
        const labels =
            Array.isArray(given.sketches) ?
                given.sketches.map(sketch => sketch?.label).filter(Boolean)
            :   []
        if (labels.length > 0) return labels.join(' / ')
        return flatten(given.question ?? given.brief)
    }
    if (name === 'subagent') return flatten(given.prompt)
    return given.path
}

/**
 * The same call as one line of a running report: the tool, then what it is pointed at.
 *
 * Flattened onto one line on the way out, and that is not cosmetic. A heredoc handed to `bash` is a
 * dozen lines, and a report that joins a dozen steps with newlines turns one step into a dozen rows
 * — so the twelve steps a report keeps became one command, and the eleven before it scrolled away.
 */
export function toolStepLine(name, args) {
    const target = toolTarget(name, args)
    const flat =
        target === undefined || target === null ? '' : String(target).replace(/\s+/gu, ' ').trim()
    return flat ? `${name}: ${flat}` : name
}
