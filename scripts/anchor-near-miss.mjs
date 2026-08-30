export const MAX_NEAR_MISS_BYTES = 1000

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

export function refusedAnchorIndex(message) {
    if (/^Could not find the exact text in /u.test(message)) return 0
    const several = /^Could not find edits\[(\d+)\] in /u.exec(message)
    return several ? Number(several[1]) : undefined
}
