/**
 * Answering one question from the Godot documentation, instead of handing back the passages.
 *
 * `search` returns five ranked chapters — around nine thousand characters of manual — and the agent
 * carries every one of them for the rest of the turn. That is the right answer to "which class do I
 * even use", where the ranked list IS the finding. It is the wrong answer to "what does
 * tween_property take", where the agent wanted one sentence and paid for a chapter.
 *
 * So `ask` reads them here instead. A reader is given the passages and the question, told to answer
 * in one paragraph and to quote the manual verbatim, and only that comes back. The quote is checked
 * against the passages it was drawn from: an answer whose citation is not in the material is an
 * answer remembered rather than read, and that is the one failure this shape can hide.
 *
 * It runs on the same connection `search` expands with — the sub-agent's — and it reuses that
 * connection's `complete`, because a reader with content already in its prompt needs no tools and a
 * one-shot completion is exactly that.
 */

import {
    extractionRules,
    formatResultText,
    isAbstention,
    isCoverageMiss,
    parseChildOutput,
    verifyExcerpt
} from './ai-extract.mjs'

const CORPUS = 'documentation'
const TAG = 'documentation'

/** How much manual reaches the reader. Five chunks of ~1800 characters, with room to spare. */
const CONTENT_BUDGET = 24_000

/** The reader's own ceiling. Its answer is one paragraph; the rest is a reasoning model thinking. */
export const ASK_MAX_TOKENS = 4096

const SYSTEM_PROMPT =
    'You answer one question about the Godot engine from documentation you are given, and quote it '
    + 'verbatim.'

/**
 * The passages as the reader sees them, each under the chapter it came from.
 *
 * The chapter is shown because it is the only provenance these passages have — the stored chunks
 * carry a chapter and an order and no URL — so an answer that names one is as far as a citation can
 * go here.
 */
export function buildContent(passages, budget = CONTENT_BUDGET) {
    const parts = []
    let total = 0
    for (const passage of passages ?? []) {
        const block = `[${passage.chapter}]\n${passage.text}`
        if (parts.length > 0 && total + block.length > budget) break
        parts.push(block)
        total += block.length
    }
    return parts.join('\n\n')
}

export function buildAskPrompt(question, content) {
    return (
        `You answer one question about the Godot engine using only the documentation below.\n`
        + `\n`
        + `Rules:\n`
        + extractionRules(CORPUS, TAG)
        + `6. Godot 4 only. The passages are the 4.7 manual; if you are about to write a class,\n`
        + `   method or constant name that is not in <${TAG}>, do not write it.\n`
        + `7. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<question>${question}</question>\n`
        + `<${TAG}>\n${content}\n</${TAG}>\n`
    )
}

const UNVERIFIED_WARNING =
    'WARNING: the quote below is not in the documentation that was retrieved, so this answer may '
    + 'have been remembered rather than read. Treat it as unsourced and search again.'

/**
 * What to do next when the retrieval itself came back empty.
 *
 * This is gofer-rag's own refusal, not the reader's: nothing cleared the rerank threshold, so no
 * model was asked anything. It is a different event from "unclear", and the next move is different
 * too — the words missed the manual, so different words are what is needed, not a different
 * question about the same passages.
 */
export const NOTHING_RETRIEVED =
    'The Godot documentation returned no passage above the relevance threshold, so nothing was read '
    + 'and no answer was written. This is the search missing, not the manual being silent: ask again '
    + 'with the Godot class, method or property name you are after, or use the search operation to '
    + 'see which chapters come back at all.'

/** What to do next when the reader had the passages and they were about something else. */
export const COVERAGE_MISS_NEXT_STEP =
    'NEXT STEP: the retrieved chapters do not contain the answer. Asking them the same question a '
    + 'different way returns this same result. Search again with different terms, or name the class '
    + 'you mean.'

/**
 * Reads the retrieved passages and answers the question from them.
 *
 * `complete` is the sub-agent connection's. Absent means no model can be reached, and that is
 * reported rather than silently answered from the passages, because an `ask` with no reader has
 * nothing to hand back at all.
 */
export async function askDocs({question, passages, complete}) {
    if (!complete) {
        return {
            error:
                'The documentation cannot be read without a model connection. Configure a local '
                + 'connection or sign in to ChatGPT, or use the search operation, which needs no model.'
        }
    }
    if (!passages || passages.length === 0) return {text: NOTHING_RETRIEVED, nothingRetrieved: true}

    const content = buildContent(passages)
    const reply = await complete({
        system: SYSTEM_PROMPT,
        user: buildAskPrompt(question, content),
        maxTokens: ASK_MAX_TOKENS
    })
    const parsed = parseChildOutput(reply)
    // Verified against the whole content the reader was shown, which is what it was told to quote.
    const check = parsed.excerpt ? verifyExcerpt(parsed.excerpt, content) : undefined
    const coverageMiss = isCoverageMiss(parsed.answer)
    const body = formatResultText(parsed, check?.verified, {
        unverifiedWarning: UNVERIFIED_WARNING
    })
    return {
        text: coverageMiss ? `${body}\n\n${COVERAGE_MISS_NEXT_STEP}` : body,
        excerptVerified: check?.verified,
        excerptCheck: check,
        coverageMiss,
        abstained: isAbstention(parsed.answer),
        // The chapters the answer rests on, without their text. Provenance the agent can act on at
        // a fraction of what the passages themselves cost.
        chapters: passages.map(passage => ({chapter: passage.chapter, score: passage.score}))
    }
}
