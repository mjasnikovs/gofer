import {createHash} from 'node:crypto'

const NOUNS = {page: 'page', documentation: 'documentation'}

export const CORPORA = Object.keys(NOUNS)

export function notCoveredSentence(corpus) {
    return `not covered by this ${NOUNS[corpus]}`
}

export function abstentionSentence(corpus) {
    return `unclear from this ${NOUNS[corpus]}`
}

const nouns = Object.values(NOUNS).join('|')
const NOT_COVERED_RE = new RegExp(`^not covered by this (?:${nouns})[.\\s]*$`, 'iu')
const ABSTENTION_RE = new RegExp(`unclear\\s+from\\s+this\\s+(?:${nouns})\\b`, 'iu')

export function isAbstention(text) {
    return ABSTENTION_RE.test(text ?? '')
}

export function isCoverageMiss(text) {
    return NOT_COVERED_RE.test((text ?? '').trim())
}

export function parseChildOutput(text) {
    const trimmed = (text ?? '').trim()
    const answer = /<answer>([\s\S]*?)<\/answer>/iu.exec(trimmed)
    const excerpt = /<excerpt>([\s\S]*?)<\/excerpt>/iu.exec(trimmed)
    if (!answer) return {answer: trimmed}
    return {answer: answer[1].trim(), excerpt: excerpt?.[1].trim() || undefined}
}

export function normaliseWhitespace(text) {
    return (text ?? '').replace(/\s+/gu, ' ').trim()
}

export function isExcerptInContent(excerpt, content) {
    const needle = normaliseWhitespace(excerpt)
    if (needle.length === 0) return false
    return normaliseWhitespace(content).includes(needle)
}

export function verifyExcerpt(excerpt, content) {
    const normalised = normaliseWhitespace(content)
    return {
        verified: isExcerptInContent(excerpt, content),
        contentSha256: createHash('sha256').update(normalised).digest('hex'),
        contentLength: normalised.length,
        normalisedExcerpt: normaliseWhitespace(excerpt)
    }
}

export function formatResultText(parsed, verified, {header = '', unverifiedWarning} = {}) {
    const lead = header ? `${header}\n\n` : ''
    if (!parsed.excerpt) return `${lead}${parsed.answer}`
    const quote = parsed.excerpt.replace(/\n/gu, '\n> ')
    const warning = verified === false ? `${unverifiedWarning}\n\n` : ''
    return `${warning}${lead}${parsed.answer}\n\nSource excerpt:\n> ${quote}`
}

export function extractionRules(corpus, tag) {
    return (
        `1. Output ONLY two tags, in this order, with NO text outside them:\n`
        + `   <answer>...your answer...</answer>\n`
        + `   <excerpt>...verbatim quote from <${tag}>...</excerpt>\n`
        + `2. The <excerpt> MUST be copied character-for-character from <${tag}>.\n`
        + `   Do not paraphrase, translate, or summarise inside <excerpt>.\n`
        + `3. Answer from <${tag}> whenever it supports an answer — INCLUDING a partial one. If\n`
        + `   it states only part of what is asked, give the part that IS present and name what\n`
        + `   is missing; do NOT fall back to the sentinels merely because coverage is\n`
        + `   incomplete. When <${tag}> plainly contains the asked-for thing, you MUST answer it.\n`
        + `4. If <${tag}> is about a DIFFERENT version, topic or subject than the question asks\n`
        + `   about — the asked-about thing is simply not there — write exactly:\n`
        + `   <answer>${notCoveredSentence(corpus)}</answer> and quote in <excerpt> the text\n`
        + `   that shows what it IS about.\n`
        + `5. Only when the answer is genuinely present but ambiguous or self-contradictory,\n`
        + `   write exactly: <answer>${abstentionSentence(corpus)}</answer> with the closest\n`
        + `   text in <excerpt>. Never invent an answer or state anything not supported by\n`
        + `   <${tag}>.\n`
    )
}
