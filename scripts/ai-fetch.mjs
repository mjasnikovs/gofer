/**
 * Reading one web page, in a child, so the page never enters this conversation.
 *
 * The main agent holds a live shell, a live editor and a real worktree. Any text that lands in its
 * context sits next to a shell that runs without asking, and a web page is text somebody else wrote.
 * So the page is handed to a child that has no tools at all, asked one question about it, and only
 * the child's answer comes back. The page is thrown away with the child.
 *
 * No tools is the contract, not a default. The child is given everything it may use inside its
 * prompt, so a tool could only reach for something the page never said — and a page that can ask for
 * a shell command is the whole injection problem restated. `createChildTools` is told `[]`, and
 * `assertChildTools` refuses anything else.
 *
 * The rest of this file is the three things that decide whether the answer is worth anything:
 *
 *   which bytes are read   a GitHub blob URL serves a viewer, not the file, so it is rewritten; a
 *                          `#fragment` names the section the caller actually meant, so it is sliced
 *                          out rather than lost past the head of a long page.
 *   what the child is told the extraction rules, and the two sentinels it answers with when it
 *                          cannot answer — one for "this page is about something else", one for
 *                          "the page says it ambiguously". They are different moves for the caller.
 *   whether it made it up  the child must quote the page verbatim, and the quote is checked against
 *                          the page. A quote that is not there is the one visible sign of an answer
 *                          that came out of the model's memory instead of the page.
 */

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

/** How much page reaches the child, and how a longer one is cut. */
const CONTENT_BUDGET = 30_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000
const TRUNCATION_MARKER = '\n\n[...page continues, truncated...]\n\n'

/**
 * The two non-answers this page reader can give, taken from the shared table in `ai-extract.mjs`
 * rather than written here.
 *
 * They used to be two literals beside two regexes in this file, which is exactly the arrangement
 * that drifts — and a third corpus was about to be written the same way. The prompt below now
 * interpolates the same sentence the matcher looks for.
 */
export const NOT_COVERED_ANSWER = notCoveredSentence('page')
export const UNCLEAR_ANSWER = abstentionSentence('page')

// Re-exported rather than re-implemented: the protocol moved to `ai-extract.mjs` so a second
// corpus could share it, and this module is still where a page reader's callers look for it.
export {
    isAbstention,
    isExcerptInContent,
    normaliseWhitespace,
    parseChildOutput,
    verifyExcerpt
} from './ai-extract.mjs'

/**
 * `github.com/{owner}/{repo}/blob/{ref}/{path}` renders the file through a viewer written in
 * JavaScript, so the HTML carries GitHub's chrome and none of the file. `raw.githubusercontent.com`
 * serves the same bytes as text.
 *
 * Only the URL handed to the fetcher is rewritten. The caller's URL still supplies the `#fragment`,
 * and still reports as what was asked for.
 */
const GH_BLOB_RE =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/blob\/([^?#]+?)\/*(?:[?#].*)?$/iu

export function normaliseSourceUrl(url) {
    const match = GH_BLOB_RE.exec(url.trim())
    if (!match) return url
    const [, owner, repo, refAndPath] = match
    // `/blob/{ref}/{path}`. A bare `/blob/{ref}` names no file, so there is nothing to rewrite to.
    if (!refAndPath.includes('/')) return url
    return `https://raw.githubusercontent.com/${owner}/${repo}/${refAndPath}`
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** The `#fragment` of a URL, or an empty string. */
function fragmentOf(url) {
    const at = url.indexOf('#')
    return at === -1 ? '' : url.slice(at + 1).trim()
}

/**
 * The section a heading anchor names: from that heading to the next one of the same or higher level.
 *
 * Anchors are matched on the heading line in both the shapes real documentation emits — Docusaurus
 * writes `### Title[](#slug "…")`, GitHub writes `## [Title](#slug)`. `#foo` must not match
 * `#foobar`, or a link to a short section silently delivers a longer one.
 */
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

/**
 * Which part of the page the child is shown.
 *
 * A deep link is the caller saying which section they meant, and on a long page that section usually
 * sits past the head window — so head-truncating a fragment URL throws away the exact thing that was
 * asked for. When the fragment names no heading in this content, the page has changed since the link
 * was written, and falling back to truncation reads more of it than honouring a stale anchor would.
 */
export function selectContent(markdown, requestedUrl) {
    const fragment = fragmentOf(requestedUrl)
    if (fragment) {
        const section = sliceSection(markdown, fragment)
        if (section) return {content: truncate(section), section: fragment}
    }
    return {content: truncate(markdown)}
}

/**
 * What the child is told.
 *
 * In the message rather than the system prompt, deliberately: the rules and the page are one thing
 * to compare when a prompt change is measured, and a rule that migrates between the two slots would
 * otherwise pass every assertion about either.
 *
 * Rule 5 is the one that was tuned rather than invented. Sending the child to `unclear` on any
 * ambiguity threw away answers that were on the page. It now answers partially and says what is
 * missing; rule 6 reports a page about something else as its own outcome; rule 7 keeps `unclear` for
 * content that genuinely contradicts itself. Rules 1 and 2 — the verbatim quote — were not relaxed,
 * because that pair is the whole fabrication guard.
 */
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

/**
 * The page reader's own wording for a quote that is not on the page.
 *
 * The check itself, the parsing and the formatting are shared — see `ai-extract.mjs`. Only this
 * sentence is the page's, because a page and a manual are wrong in different ways: a page can be
 * the wrong page, where a documentation search that returned nothing has already said so.
 */
const UNVERIFIED_WARNING =
    'WARNING: the quote below is not on the page, so this answer may have been remembered rather '
    + 'than read. Treat it as unsourced.'

export function formatResultText(parsed, verified) {
    return sharedFormatResultText(parsed, verified, {unverifiedWarning: UNVERIFIED_WARNING})
}

/**
 * What to do instead, said only when the page was about something else.
 *
 * It carries the two things the bare sentinel does not: which URL was actually read — after a blob
 * rewrite that is not the one asked for, and a caller who cannot see that would "retry" the raw URL
 * it already got — and that asking this page again differently returns this same answer.
 *
 * Deliberately no suggestion of which other URL. Nothing here knows one, and naming a guess turns
 * one dead end into two.
 */
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

/**
 * Fetch one page and ask a no-tools child one question about it.
 *
 * The excerpt is verified against the WHOLE cleaned page even when only a `#fragment` section was
 * shown to the child. The section is a substring of the page, so a genuine quote still verifies and
 * a remembered one still fails — anchoring cannot weaken the detector. Verifying against anything
 * narrower would manufacture fabrication verdicts for quotes that are really there.
 */
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
    progress,
    fetchAndClean = defaultFetchAndClean
}) {
    const fetchedUrl = normaliseSourceUrl(url)
    const page = await fetchAndClean(fetchedUrl, {signal})

    // Anchored from the URL as asked for, not from the post-redirect one: a `#fragment` never
    // reaches a server, so the final URL has already dropped it.
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

/**
 * A page and a reader that answer at once, without a request leaving the machine.
 *
 * The probe has to prove the tool constructs, that a no-tools child can be built for it, and that an
 * answer comes back out through the same parsing and formatting the real path uses. What it cannot
 * prove is that the network is up — and it must not try, because a real request here would leak one
 * request per turn and spend a search quota on a tool the user may never call. A network that is
 * down is reported by the call that needs it, retried first.
 */
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
                    // The reader holds no tools, so its only steps are thinking and writing — which
                    // is exactly the silence this fills. A page of forty thousand characters read by
                    // a local model is a minute of a spinner that says nothing.
                    progress: toolProgress(onUpdate),
                    fetchAndClean: probing ? cannedPage() : fetchAndClean
                })
            } catch (error) {
                // A page that could not be fetched is the site's problem and is reported as itself.
                // Anything else is the reader's, and `runSubagent` has already worded it.
                if (error instanceof FetchAndCleanError) throw new Error(error.message)
                throw error
            }

            const body = formatResultText(
                {answer: result.answer, excerpt: result.excerpt},
                result.excerptVerified
            )
            // The coverage miss carries an instruction, so it goes in the text. `details` reaches
            // the window, not the model, and the model is what has to act on it.
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

/**
 * The one shape a fetch failure reaches the calling agent in.
 *
 * A sibling of `subagentFailure` rather than a call to it, because the remedy differs and the remedy
 * is the part that matters. A sub-agent that fails can be replaced by reading the files yourself.
 * There is no local fallback for a page: the caller either asks for less of it, or picks another URL.
 */
export function webFetchFailure(reason) {
    return (
        `The page was not read: ${reason}. Nothing from it reached this conversation, so treat the `
        + `question as unanswered — ask again for one narrower thing, or try a different URL.`
    )
}
