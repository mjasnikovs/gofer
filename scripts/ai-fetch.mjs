import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {
    abstentionSentence,
    isAbstention,
    isCoverageMiss,
    notCoveredSentence,
    parseChildOutput,
    verifyExcerpt,
    formatResultText as sharedFormatResultText
} from './ai-extract.mjs'
import {fetchAndClean as defaultFetchAndClean, FetchAndCleanError} from './ai-web-clean.mjs'
import {runSubagent, toolProgress} from './ai-subagent.mjs'

export const WEB_FETCH_TOOL_NAME = 'web_fetch'

const CONTENT_BUDGET = 30_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000
const TRUNCATION_MARKER = '\n\n[...page continues, truncated...]\n\n'

export const NOT_COVERED_ANSWER = notCoveredSentence('page')
export const UNCLEAR_ANSWER = abstentionSentence('page')

export {
    isAbstention,
    isExcerptInContent,
    normaliseWhitespace,
    parseChildOutput,
    verifyExcerpt
} from './ai-extract.mjs'

const GH_BLOB_RE =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/blob\/([^?#]+?)\/*(?:[?#].*)?$/iu

export function normaliseSourceUrl(url) {
    const match = GH_BLOB_RE.exec(url.trim())
    if (!match) return url
    const [, owner, repo, refAndPath] = match
    if (!refAndPath.includes('/')) return url
    return `https://raw.githubusercontent.com/${owner}/${repo}/${refAndPath}`
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function fragmentOf(url) {
    const at = url.indexOf('#')
    return at === -1 ? '' : url.slice(at + 1).trim()
}

function sliceSection(markdown, fragment) {
    const lines = markdown.split('\n')
    const anchor = new RegExp(`#${escapeRegExp(fragment)}(?![a-z0-9-])`, 'iu')
    let start = -1
    let level = 0
    for (const [index, line] of lines.entries()) {
        const heading = /^(#{1,6})\s/u.exec(line)
        if (heading && anchor.test(line)) {
            start = index
            level = heading[1].length
            break
        }
    }
    if (start === -1) return undefined
    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
        const heading = /^(#{1,6})\s/u.exec(lines[index])
        if (heading && heading[1].length <= level) {
            end = index
            break
        }
    }
    const section = lines.slice(start, end).join('\n').trim()
    return section.length > 0 ? section : undefined
}

function truncate(markdown) {
    if (markdown.length <= CONTENT_BUDGET) return markdown
    return (
        markdown.slice(0, HEAD_CHARS)
        + TRUNCATION_MARKER
        + markdown.slice(markdown.length - TAIL_CHARS)
    )
}

export function selectContent(markdown, requestedUrl) {
    const fragment = fragmentOf(requestedUrl)
    if (fragment) {
        const section = sliceSection(markdown, fragment)
        if (section) return {content: truncate(section), section: fragment}
    }
    return {content: truncate(markdown)}
}

export function buildFetchPrompt({query, url, title, content, section}) {
    const sectionNote =
        section ?
            `<page-section>The content below has been narrowed to the "#${section}" section of\n`
            + `the page — the section the URL points to. Treat it as the relevant part of the page.</page-section>\n`
        :   ''
    return (
        `You extract a single piece of information from a web page to answer one question.\n`
        + `\n`
        + `Rules:\n`
        + `1. Output ONLY two tags, in this order, with NO text outside them:\n`
        + `   <answer>...your answer...</answer>\n`
        + `   <excerpt>...verbatim quote from <page-content>...</excerpt>\n`
        + `2. The <excerpt> MUST be copied character-for-character from <page-content>.\n`
        + `   Do not paraphrase, translate, or summarise inside <excerpt>.\n`
        + `3. Distinguish content from UI: button labels, player widgets, status indicators,\n`
        + `   navigation, breadcrumbs, and footers are NOT the answer unless the question is\n`
        + `   specifically about page UI.\n`
        + `4. If the page is not in English, write the <answer> in English (translate key\n`
        + `   non-English terms) and keep the original-language text in <excerpt>.\n`
        + `5. Answer from <page-content> whenever it supports an answer — INCLUDING a partial\n`
        + `   one. If the content states only part of what is asked, give the part that IS\n`
        + `   present and note what is missing; do NOT fall back to "unclear" merely because\n`
        + `   the coverage is incomplete. When <page-content> plainly contains the asked-for\n`
        + `   thing (e.g. it lists the methods, fields, or signature asked about), you MUST\n`
        + `   answer it — "unclear" is the wrong response in that case.\n`
        + `6. If <page-content> is about a DIFFERENT version, topic, or page than the question\n`
        + `   asks about — the asked-about thing is simply not on this page — write exactly:\n`
        + `   <answer>${NOT_COVERED_ANSWER}</answer> and quote in <excerpt> the text that\n`
        + `   shows what this page IS about. Use this, not "unclear", so the caller can try a\n`
        + `   different page.\n`
        + `7. Only when the answer is genuinely present but ambiguous or self-contradictory,\n`
        + `   write exactly: <answer>${UNCLEAR_ANSWER}</answer> with the closest text in\n`
        + `   <excerpt>. Never invent an answer or state anything not supported by\n`
        + `   <page-content>.\n`
        + `8. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<question>${query}</question>\n`
        + `<url>${url}</url>\n`
        + `<page-title>${title}</page-title>\n`
        + sectionNote
        + `<page-content>\n${content}\n</page-content>\n`
    )
}

const UNVERIFIED_WARNING =
    'WARNING: the quote below is not on the page, so this answer may have been remembered rather '
    + 'than read. Treat it as unsourced.'

export function formatResultText(parsed, verified) {
    return sharedFormatResultText(parsed, verified, {unverifiedWarning: UNVERIFIED_WARNING})
}

export function coverageMissNextStep(requestedUrl, fetchedUrl) {
    const rewritten =
        fetchedUrl === requestedUrl ? '' : (
            ` ${requestedUrl} is a GitHub file viewer whose HTML does not carry the file, so the`
            + ` file itself was already read from ${fetchedUrl} — fetching that raw URL by hand`
            + ` returns exactly this.`
        )
    return (
        `NEXT STEP: this page does not contain the answer.${rewritten}`
        + ` Asking ${fetchedUrl} the same question a different way returns this same result —`
        + ` do not re-read it. Try a different URL, or search for one.`
    )
}

export async function fetchFocused({
    url,
    query,
    workspacePath,
    models,
    model,
    thinkingLevel,
    streamOptions,
    settings,
    signal,
    timers,
    probe,
    progress,
    fetchAndClean = defaultFetchAndClean
}) {
    const fetchedUrl = normaliseSourceUrl(url)
    const page = await fetchAndClean(fetchedUrl, {signal})

    const selected = selectContent(page.markdown, url)
    const prompt = buildFetchPrompt({
        query,
        url: page.finalUrl,
        title: page.title,
        content: selected.content,
        section: selected.section
    })

    const child = await runSubagent({
        prompt,
        systemPrompt: 'You extract one fact from the content you are given, and quote it verbatim.',
        toolNames: [],
        workspacePath,
        models,
        model,
        thinkingLevel,
        streamOptions,
        settings,
        signal,
        timers,
        probe,
        progress
    })

    const parsed = parseChildOutput(child.text)
    const check = parsed.excerpt ? verifyExcerpt(parsed.excerpt, page.markdown) : undefined
    const coverageMiss = isCoverageMiss(parsed.answer)

    return {
        answer: parsed.answer,
        excerpt: parsed.excerpt,
        excerptVerified: check?.verified,
        excerptCheck: check,
        coverageMiss,
        nextStep: coverageMiss ? coverageMissNextStep(url, fetchedUrl) : undefined,
        anchoredSection: selected.section,
        prompt,
        usage: child.usage,
        turns: child.turns
    }
}

const WEB_FETCH_DESCRIPTION =
    'Read one web page and get back only the answer to your question about it. The page itself '
    + 'never enters this conversation: an isolated reader with no tools holds it, answers, and the '
    + 'page is thrown away.\n'
    + '\n'
    + 'REACH FOR THIS whenever you need to know how an external library, tool, plugin, framework or '
    + 'service is CONFIGURED, WIRED or INTEGRATED. Fetch its README or its official documentation '
    + 'page and read the setup out of it. Do NOT answer configuration or integration questions from '
    + 'memory — what you remember is a version ago, and a wrong wiring detail costs more to find '
    + 'later than the fetch costs now.\n'
    + '\n'
    + 'Use it when:\n'
    + '- you have a URL and want one thing out of it\n'
    + '- web_search returned a result worth reading\n'
    + '- a library, API or tool outside this project has to be configured\n'
    + '\n'
    + 'Do not reach for it when:\n'
    + '- the question is about Godot itself — use godot_docs_search\n'
    + '- the question is about this project’s own files — use the subagent tool\n'
    + '- you have no URL — use web_search first\n'
    + '\n'
    + 'Ask for one specific thing per call. The reader sees your question and the page, nothing '
    + 'else, so name the option, function or setting you are after.'

const PROBE_URL = 'https://gofer.invalid/probe'
export const WEB_FETCH_PROBE_ANSWER = 'web-fetch-reachable'

function cannedPage() {
    return () =>
        Promise.resolve({
            title: 'Probe',
            markdown: `<answer>${WEB_FETCH_PROBE_ANSWER}</answer>`,
            finalUrl: PROBE_URL
        })
}

function cannedReader(model) {
    return {
        streamSimple: () => {
            const message = {
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text:
                            `<answer>${WEB_FETCH_PROBE_ANSWER}</answer>`
                            + `<excerpt>${WEB_FETCH_PROBE_ANSWER}</excerpt>`
                    }
                ],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
                },
                stopReason: 'stop'
            }
            const stream = createAssistantMessageEventStream()
            stream.push({type: 'done', reason: 'stop', message})
            stream.end(message)
            return stream
        }
    }
}

export function createWebFetchTool({
    workspacePath,
    models,
    model,
    thinkingLevel,
    streamOptions,
    settings,
    timers,
    probe,
    fetchAndClean
}) {
    return {
        name: WEB_FETCH_TOOL_NAME,
        label: 'read page',
        description: WEB_FETCH_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The page to read. Must be http or https.'
                },
                query: {
                    type: 'string',
                    description:
                        'What to take from the page. The reader returns only what answers this, '
                        + 'so name the option, function or setting you are after.'
                }
            },
            required: ['url', 'query']
        },
        execute: async (_toolCallId, params, signal, onUpdate) => {
            const probing = params?.probe === true
            const url = probing ? PROBE_URL : params?.url
            if (!probing) {
                if (typeof params?.query !== 'string' || params.query.trim() === '')
                    throw new Error(webFetchFailure('it was given no question to answer'))
                try {
                    const parsed = new URL(url)
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
                        throw new Error('not http')
                } catch {
                    throw new Error(
                        `${String(url)} is not an http or https URL, so there is nothing to fetch.`
                    )
                }
            }

            let result
            try {
                result = await fetchFocused({
                    url,
                    query: probing ? 'Is this reachable?' : params.query,
                    workspacePath,
                    models: probing ? cannedReader(model) : models,
                    model,
                    thinkingLevel,
                    streamOptions,
                    settings,
                    signal,
                    timers,
                    probe,
                    progress: toolProgress(onUpdate),
                    fetchAndClean: probing ? cannedPage() : fetchAndClean
                })
            } catch (error) {
                if (error instanceof FetchAndCleanError) throw new Error(error.message)
                throw error
            }

            const body = formatResultText(
                {answer: result.answer, excerpt: result.excerpt},
                result.excerptVerified
            )
            const text = result.nextStep ? `${body}\n\n${result.nextStep}` : body
            return {
                content: [{type: 'text', text: text || '(the page produced no answer)'}],
                details: {
                    excerptVerified: result.excerptVerified,
                    coverageMiss: result.coverageMiss,
                    anchoredSection: result.anchoredSection,
                    turns: result.turns,
                    usage: result.usage
                }
            }
        }
    }
}

export function webFetchFailure(reason) {
    return (
        `The page was not read: ${reason}. Nothing from it reached this conversation, so treat the `
        + `question as unanswered — ask again for one narrower thing, or try a different URL.`
    )
}
