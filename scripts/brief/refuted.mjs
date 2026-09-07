/**
 * A refutation is a DELETION, never an addition.
 *
 * refine writes CONSTRAINTS before research has read anything, so a rule it took from
 * the task's own wording can be contradicted by the project itself. Appending the
 * correction loses that contradiction: CONSTRAINTS is what compose is told is
 * authoritative, so the invention outranks the note beside it. Only a subtraction holds.
 *
 * Lexical, never semantic, and never a model rewrite. A research CONTEXT bullet refutes
 * a refine CONSTRAINTS line when it negates the NEED for a backticked token the
 * constraint also names. The set is deliberately tiny — one false drop silently deletes
 * a real rule — and holds only shapes that cannot be read as anything else. "The project
 * does not have X yet" is a fact about the tree, not a refutation, so it is not in it.
 */

/** Bare ALL-CAPS section header, the boundary convention every brief section uses. */
const HEADER = /^[A-Z][A-Z -]*$/u

/** A backticked run with no whitespace inside — the only thing this pass calls a token. */
const TOKEN = '`[^`\\s]+`'

const TOKEN_LIST = `${TOKEN}(?:(?:\\s*,\\s*|\\s+or\\s+|\\s+and\\s+)${TOKEN})*`

const NEED = '(?:needed|required|necessary)'

/**
 * Each pattern anchors the token list INSIDE the negation, so a bullet that names one
 * symbol negatively and another positively can only ever refute the one it negates.
 */
const NEGATIONS = [
    {
        name: 'no-x-needed',
        re: new RegExp(
            `\\bno\\s+(${TOKEN_LIST})\\s+(?:\\w+\\s+){0,2}(?:is\\s+|are\\s+)?${NEED}\\b`,
            'iu'
        )
    },
    {
        name: 'x-not-needed',
        re: new RegExp(`(${TOKEN_LIST})\\s+(?:is|are)\\s+not\\s+${NEED}\\b`, 'iu')
    },
    {
        name: 'no-need-for-x',
        re: new RegExp(`\\bno\\s+need\\s+(?:for|to\\s+use|to\\s+call)\\s+(${TOKEN_LIST})`, 'iu')
    }
]

const tokensIn = text => [...(text ?? '').matchAll(new RegExp(TOKEN, 'gu'))].map(match => match[0])

/** The lines of one bare-headed section, or an empty list when it is not there. */
export function sectionLines(text, name) {
    const lines = (text ?? '').split('\n')
    const at = lines.findIndex(line => line.trim() === name)
    if (at === -1) return []
    const rest = lines.slice(at + 1)
    const end = rest.findIndex(line => HEADER.test(line.trim()) && line.trim().length > 0)
    return end === -1 ? rest : rest.slice(0, end)
}

/** Every token a research CONTEXT bullet says this task does not need. */
export function refutedTokens(research) {
    const found = new Map()
    for (const line of sectionLines(research, 'CONTEXT')) {
        for (const {name, re} of NEGATIONS) {
            const match = re.exec(line)
            if (!match) continue
            for (const token of tokensIn(match[1])) {
                if (!found.has(token)) found.set(token, {shape: name, bullet: line.trim()})
            }
        }
    }
    return found
}

/**
 * Drop every refine CONSTRAINTS line naming a refuted token, and say which and why.
 *
 * Only CONSTRAINTS is touched. GOAL is prose the implementer reads for intent, and
 * KNOWN-UNKNOWNS is already a question rather than a rule; deleting from either would
 * lose the reason a rule existed without removing its force.
 */
export function applyRefutations(refined, research) {
    const refuted = refutedTokens(research)
    if (refuted.size === 0) return {refined, trail: []}

    const lines = (refined ?? '').split('\n')
    const at = lines.findIndex(line => line.trim() === 'CONSTRAINTS')
    if (at === -1) return {refined, trail: []}
    const after = lines.slice(at + 1)
    const span = after.findIndex(line => HEADER.test(line.trim()) && line.trim().length > 0)
    const last = span === -1 ? lines.length : at + 1 + span

    const trail = []
    const kept = []
    for (let index = at + 1; index < last; index++) {
        const line = lines[index]
        const hit = tokensIn(line).find(token => refuted.has(token))
        if (hit === undefined) {
            kept.push(line)
            continue
        }
        const {shape, bullet} = refuted.get(hit)
        trail.push(
            `refutation (${shape}): dropped constraint ${line.trim()} — research says ${bullet}`
        )
    }
    if (trail.length === 0) return {refined, trail: []}
    return {refined: [...lines.slice(0, at + 1), ...kept, ...lines.slice(last)].join('\n'), trail}
}
