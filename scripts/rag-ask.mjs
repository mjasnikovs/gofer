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

const CONTENT_BUDGET = 24_000

export const ASK_MAX_TOKENS = 4096

const SYSTEM_PROMPT =
    'You answer one question about the Godot engine from documentation you are given, and quote it '
    + 'verbatim.'

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

export const NOTHING_RETRIEVED =
    'The Godot documentation returned no passage above the relevance threshold, so nothing was read '
    + 'and no answer was written. This is the search missing, not the manual being silent: ask again '
    + 'with the Godot class, method or property name you are after, or use the search operation to '
    + 'see which chapters come back at all.'

export const COVERAGE_MISS_NEXT_STEP =
    'NEXT STEP: the retrieved chapters do not contain the answer. Asking them the same question a '
    + 'different way returns this same result. Search again with different terms, or name the class '
    + 'you mean.'

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
        chapters: passages.map(passage => ({chapter: passage.chapter, score: passage.score}))
    }
}
