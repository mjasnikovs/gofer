/**
 * What a refused `edit` anchor says, once the file has been asked whether it holds the same text
 * under different whitespace.
 *
 * The failure this closes, measured over a week of one project: seven anchors were refused, and
 * three of the seven were byte-identical retries sent with no read of the file in between. Every
 * retry was refused again. Zero of the four distinct anchors recovered in one call, and recovery
 * cost 17,634 bytes of calls and answers at the median — against the 136 bytes the file's own text
 * would have cost.
 *
 * Three of those seven were `edit` rather than `godot_script edit`, all on Markdown, and this is
 * the half of the fix that reaches them: the tool is pi's (`pi-agent-core`'s `createEditTool`) and
 * its refusal names the file and nothing else, because `getNotFoundError` is handed a path and an
 * index and never the content. Gofer already wraps that tool and already catches that error in
 * `confineTool`, so the region is added there rather than upstream.
 *
 * pi already forgives some of this: `normalizeForFuzzyMatch` strips TRAILING whitespace per line
 * and folds Unicode quotes, dashes and spaces. It does not touch indentation, and the two anchors
 * this reaches were an extra leading tab and an extra blank line. So a near miss here is what pi's
 * own fuzzy pass could not be.
 */

/**
 * How much of the file one refused anchor quotes back before it stops quoting.
 *
 * Measured, not chosen: the region a near miss would have quoted was 136 bytes at the median and
 * 950 at the worst over the week. A thousand covers every one of them. Past the cap the region is
 * named by its lines rather than quoted, because a block cut in half is the failure that a model
 * pastes straight back as `oldText` — a refusal that causes itself.
 */
export const MAX_NEAR_MISS_BYTES = 1000

/**
 * One text with every whitespace character removed, and the map back to where each surviving
 * character came from.
 *
 * `starts[i]` and `ends[i]` are the original range of the character that produced squeezed index
 * `i`, so a match over `squeezed.slice(a, b)` names the original span `starts[a] .. ends[b - 1]`.
 * Two maps rather than one: the end of the last matched character is not the start of the next,
 * and the difference between them is exactly the whitespace a near miss exists to forgive.
 */
export function squeeze(text) {
    let squeezed = ''
    const starts = []
    const ends = []
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (/\s/u.test(character)) continue
        squeezed += character
        starts.push(index)
        ends.push(index + 1)
    }
    return {text: squeezed, starts, ends}
}

function lineOf(text, offset) {
    let line = 1
    for (let index = 0; index < offset; index += 1) if (text[index] === '\n') line += 1
    return line
}

function everyIndexOf(haystack, needle) {
    const found = []
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1))
        found.push(at)
    return found
}

/**
 * The sentence to add to a refused anchor, or nothing when the file holds no such region.
 *
 * Whitespace is squeezed out of both sides only to FIND the region. What is quoted back is the
 * file's own text, never the squeezed form, and nothing here writes anything: a region found
 * without indentation is a thing to show the model, not a thing to apply. Silence is the fallback
 * on purpose — over the measured week this answered with a region three times and with nothing
 * four times, and never once with the wrong region.
 */
export function nearMiss(content, oldText) {
    const haystack = squeeze(content)
    const needle = squeeze(oldText)
    if (needle.text.length === 0) return undefined
    const found = everyIndexOf(haystack.text, needle.text)
    if (found.length === 0) return undefined
    if (found.length > 1) {
        const lines = found.map(at => lineOf(content, haystack.starts[at]))
        return (
            `Apart from whitespace it matches ${lines.length} regions, at lines `
            + `${lines.join(', ')}, so it still names no single region. Quote one of them from the `
            + 'file, with a neighbouring line.'
        )
    }
    const first = found[0]
    const last = first + needle.text.length - 1
    const held = content.slice(haystack.starts[first], haystack.ends[last])
    const firstLine = lineOf(content, haystack.starts[first])
    const lastLine = lineOf(content, haystack.starts[last])
    if (held.length > MAX_NEAR_MISS_BYTES) {
        const opening = (held.split('\n', 1)[0] ?? '').trim()
        return (
            `Apart from whitespace it matches lines ${firstLine} to ${lastLine}, which are too `
            + `long to quote here. They open with \`${opening}\`. Read those lines and anchor on `
            + 'what they hold.'
        )
    }
    return (
        `Apart from whitespace it matches lines ${firstLine} to ${lastLine}, which the file holds `
        + `as:\n\n${held}\n\nAnchor on that text exactly, or read the file again if it is not the `
        + 'region you meant.'
    )
}

/**
 * Which anchor of an `edit` call pi refused, or nothing when the error is about something else.
 *
 * pi writes two sentences for this one situation — `getNotFoundError` branches on whether the call
 * carried one edit or several — so both are recognised here, and a call of one is index 0. The
 * text is matched rather than a code, because the tool throws a bare `Error`: there is no code to
 * read.
 */
export function refusedAnchorIndex(message) {
    if (/^Could not find the exact text in /u.test(message)) return 0
    const several = /^Could not find edits\[(\d+)\] in /u.exec(message)
    return several ? Number(several[1]) : undefined
}
