/**
 * The two-tag extraction protocol, and the one table that recognises what it answers with.
 *
 * A reader is given content it may use and nothing else, and must come back with two tags: the
 * answer, and a quote copied out of that content. The quote is then checked against the source. A
 * quote that is not there is the only visible sign of an answer that came out of the model's memory
 * rather than the material.
 *
 * Why the sentinels live in a table rather than in each prompt. The sentence a reader is told to
 * write and the sentence the host looks for have to agree, and when they are written twice they
 * drift. pi-task records what that cost: three prompts wrote three phrasings and four regexes
 * matched different subsets of them, so a real non-answer scored as an answer and was cached and
 * re-served. Gofer had two corpora written separately in `ai-fetch.mjs` and was about to gain a
 * third. Here the prompt builder and the matcher read one row, so a fourth corpus cannot be
 * half-wired.
 */

import {createHash} from 'node:crypto'

/**
 * The noun each corpus calls itself, in the prompt and therefore in the sentinel.
 *
 * `page` is one fetched web page. `documentation` is the ranked passages a documentation search
 * returned — plural chapters, so it cannot call itself a page, and "this documentation" is what a
 * reader shown several excerpts of one manual will write unprompted.
 */
const NOUNS = {page: 'page', documentation: 'documentation'}

/** The corpus a reader was pointed at. One row per corpus. */
export const CORPORA = Object.keys(NOUNS)

/**
 * The two non-answers, and why there are two.
 *
 * They are different instructions to whoever asked. `not covered` means the material is about
 * something else and the next move is different material. `unclear` means the answer is in there
 * but the material contradicts itself, and the next move is a different question. Collapsed into
 * one sentence, a caller re-reads the same dead end with reworded questions.
 */
export function notCoveredSentence(corpus) {
    return `not covered by this ${NOUNS[corpus]}`
}

export function abstentionSentence(corpus) {
    return `unclear from this ${NOUNS[corpus]}`
}

/**
 * The coverage sentinel is anchored; the abstention one is not, and the difference is load-bearing.
 *
 * The coverage rule asks for the sentinel as the whole answer, while a neighbouring rule asks for a
 * partial answer that NAMES what is missing — and a reader writing one says it in the prompt's own
 * words. A loose match would file that sourced answer as a dead end. Abstention is the other way
 * round: the sentinel replaces the answer, and readers wrap it in a sentence, so anchoring there
 * would miss the real non-answers this exists to catch.
 */
const nouns = Object.values(NOUNS).join('|')
const NOT_COVERED_RE = new RegExp(`^not covered by this (?:${nouns})[.\\s]*$`, 'iu')
const ABSTENTION_RE = new RegExp(`unclear\\s+from\\s+this\\s+(?:${nouns})\\b`, 'iu')

/** True when the reader declined to answer rather than answering. */
export function isAbstention(text) {
    return ABSTENTION_RE.test(text ?? '')
}

/** True when the reader reported the material as being about something else entirely. */
export function isCoverageMiss(text) {
    return NOT_COVERED_RE.test((text ?? '').trim())
}

/**
 * The reader's two tags, pulled back out.
 *
 * A reply with no `<answer>` is taken whole rather than treated as a failure: a model that answered
 * plainly still answered, and discarding it would spend the material to report nothing. An
 * `<excerpt>` holding only whitespace becomes absent, because a citation with no characters in it
 * is not one.
 */
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

/**
 * The one definition of "the reader really quoted the material".
 *
 * Emptiness is asked of the NORMALISED excerpt, not the raw one. `"   "` is a non-empty string that
 * normalises to `""`, and `content.includes('')` is true of every content — so a raw-string guard
 * lets a whitespace-only citation verify against anything at all.
 */
export function isExcerptInContent(excerpt, content) {
    const needle = normaliseWhitespace(excerpt)
    if (needle.length === 0) return false
    return normaliseWhitespace(content).includes(needle)
}

/**
 * The same verdict, plus what was actually checked.
 *
 * `verified` delegates rather than re-deciding, so there cannot be two opinions about one word. The
 * evidence beside it is what makes a `false` diagnosable later without fetching the material again:
 * whether the reader invented the quote, or quoted text that is present in a form the normaliser
 * does not see. Those need opposite fixes.
 */
export function verifyExcerpt(excerpt, content) {
    const normalised = normaliseWhitespace(content)
    return {
        verified: isExcerptInContent(excerpt, content),
        contentSha256: createHash('sha256').update(normalised).digest('hex'),
        contentLength: normalised.length,
        normalisedExcerpt: normaliseWhitespace(excerpt)
    }
}

/**
 * The answer as the calling agent reads it.
 *
 * The quote is shown because an answer with its source beside it can be checked and one without it
 * cannot. The warning is shown when the quote is not in the material, which is the only visible
 * sign that the answer came out of the model's memory — silently dropping the quote would hide
 * exactly the case worth seeing.
 */
export function formatResultText(parsed, verified, {header = '', unverifiedWarning} = {}) {
    const lead = header ? `${header}\n\n` : ''
    if (!parsed.excerpt) return `${lead}${parsed.answer}`
    const quote = parsed.excerpt.replace(/\n/gu, '\n> ')
    const warning = verified === false ? `${unverifiedWarning}\n\n` : ''
    return `${warning}${lead}${parsed.answer}\n\nSource excerpt:\n> ${quote}`
}

/**
 * The shared body of an extraction prompt: the two tags, the verbatim rule, and the two sentinels.
 *
 * Every corpus states these identically, and the abstention line is built from the same table the
 * matcher above reads — so the sentence a reader is told to write is the sentence that is
 * recognised, by construction rather than by two people remembering the same words.
 */
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
