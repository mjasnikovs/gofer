// A plan's ALL-CAPS sections, and the backticked tokens inside one.
// Header form is `GOAL` or `## GOAL`; both appear in real plans.

// ALL-CAPS (pi-task) or Title Case behind a `##` (Claude's own plans).
const HEADER = /^(?:#{1,3}\s*([A-Z][A-Za-z -]{2,})|([A-Z][A-Z -]{2,}))\s*$/
const TOKEN = /`([^`\s]+)`/g

export function sections(text) {
    const out = {}
    let cur = null
    let buf = []
    for (const line of text.split('\n')) {
        const h = line.match(HEADER)
        if (h) {
            if (cur) out[cur] = (out[cur] ?? '') + buf.join('\n')
            cur = (h[1] ?? h[2]).trim()
            buf = []
            continue
        }
        buf.push(line)
    }
    if (cur) out[cur] = (out[cur] ?? '') + buf.join('\n')
    // A plan with no ALL-CAPS headers is not a plan with no content. Claude's
    // own plans use Title Case ("## Context"), and keying only on the pi-task
    // convention made 80 of 83 of them scan as empty.
    if (Object.keys(out).length === 0) return {DOCUMENT: text}
    return out
}

/**
 * Sections that describe what ALREADY EXISTS, so a path in one is a reference
 * and must resolve. Everything else in a plan - the steps, the goal, the file
 * list - legitimately names files the plan is about to create, and scanning
 * those produced 2.45 findings per plan against a ceiling of 1.
 *
 * Measured: whole-document scanning of ~/.claude/plans flagged proposed test
 * files, proposed modules, and `~/`-rooted config as missing. Every one was
 * correct about the filesystem and wrong about the plan.
 */
const REFERENCE_SECTIONS = new Set(['CONSTRAINTS', 'CONTEXT', 'BACKGROUND', 'DOCUMENT'])

export function referenceSections(text) {
    const all = sections(text)
    const out = {}
    for (const [k, v] of Object.entries(all)) {
        const key = k.toUpperCase()
        if (REFERENCE_SECTIONS.has(key) && key !== 'DOCUMENT') out[k] = v
    }
    return out
}

export function tokensIn(body) {
    return [...body.matchAll(TOKEN)].map(m => m[1])
}
