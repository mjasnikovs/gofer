/**
 * Fetching a web page and reducing it to the text it is actually about.
 *
 * A page is mostly not its content. Navigation, cookie banners, sidebars, related-article rails and
 * footers are the bulk of the markup, and handing all of it to a model spends the page budget on
 * chrome and buries the paragraph the question was about. So the HTML goes through Readability —
 * Firefox's own reader-mode extractor — and what survives is turned into markdown.
 *
 * Not every URL is a page. Markdown, plain text, JSON and XML arrive already clean and are passed
 * through untouched; a PDF or an image is refused by name rather than decoded into mojibake and
 * handed over as though it were prose. A missing content-type is read as text, because the plain
 * endpoints that omit it — `llms.txt`, `robots.txt` — are exactly the ones worth reading.
 *
 * Three things bound a fetch, and each covers a hole the others cannot see:
 *
 *   timeoutMs  the whole request. A server that accepts a connection and then says nothing holds
 *              the turn open with no error to report.
 *   maxBytes   the response. Counted while streaming and aborted mid-body, so a multi-gigabyte URL
 *              costs the first megabyte rather than the machine's memory.
 *   signal     the parent's. A stopped turn must not leave a download running behind it.
 *
 * `fetch` is a parameter rather than the global, so a test scripts a response instead of mutating
 * the process. Node runs test files in parallel; a global swapped in one file is a global swapped
 * under every other.
 */

import {Readability} from '@mozilla/readability'
import {parseHTML} from 'linkedom'
import TurndownService from 'turndown'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/**
 * What Gofer calls itself to the sites it reads.
 *
 * A real name and a real URL, because a fetcher that lies about what it is gets blocked once
 * somebody notices, and the block looks like the page being empty.
 */
const USER_AGENT = 'Gofer/1.0 (+https://github.com/mjasnikovs/gofer)'

const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    bulletListMarker: '-'
})

/** Every way a fetch can end without a page, in one type the caller can tell apart. */
export class FetchAndCleanError extends Error {
    constructor(message, kind, cause) {
        super(message)
        this.name = 'FetchAndCleanError'
        this.kind = kind
        this.cause = cause
    }
}

/**
 * How a response is handled, decided by its content-type alone.
 *
 * The header rather than the extension or the body: a `.txt` served as HTML is HTML, and sniffing
 * the body means deciding what a page is from the first bytes of chrome.
 */
export function classifyContentType(contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase()
    if (mime === '') return 'text'
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
    if (mime.startsWith('text/')) return 'text'
    if (mime === 'application/json' || mime.endsWith('+json')) return 'text'
    if (mime === 'application/xml' || mime.endsWith('+xml')) return 'text'
    if (mime === 'application/javascript' || mime === 'application/ecmascript') return 'text'
    return 'reject'
}

/**
 * The decoder the response's own charset asks for, or UTF-8.
 *
 * Never fatal: a page that declares one encoding and serves another is common, and a replacement
 * character in one word is worth more than no page at all.
 */
export function decoderFor(contentType) {
    const charset = /charset=([^;]+)/iu
        .exec(contentType)?.[1]
        ?.trim()
        .replace(/^["']|["']$/gu, '')
    if (charset) {
        try {
            return new TextDecoder(charset, {fatal: false})
        } catch {
            // An encoding label this runtime does not know. UTF-8 reads more of it than nothing.
        }
    }
    return new TextDecoder('utf-8', {fatal: false})
}

function hostnameOf(url) {
    try {
        return new URL(url).hostname
    } catch {
        return url
    }
}

function describeError(error) {
    return error instanceof Error ? error.message : String(error)
}

function formatBytes(count) {
    if (count >= 1024 * 1024) return `${(count / 1024 / 1024).toFixed(1)} MB`
    if (count >= 1024) return `${(count / 1024).toFixed(0)} KB`
    return `${String(count)} B`
}

/**
 * HTML to markdown, with the article kept and the furniture dropped.
 *
 * Readability answers with the article when it finds one and with nothing when it does not — a
 * single-page app whose content arrives by script has no article in the HTML at all. The fallback
 * turns the whole body instead, which is worth little but is not nothing: the caller sees a short
 * page and can say so, rather than seeing an error that reads as though the URL were wrong.
 */
export function cleanHtml(html, baseUrl) {
    const {document} = parseHTML(html)
    const article = new Readability(document).parse()

    if (article?.content) {
        return {
            title: article.title || document.title || hostnameOf(baseUrl),
            markdown: turndown.turndown(article.content).trim(),
            finalUrl: baseUrl
        }
    }

    return {
        title: document.title || hostnameOf(baseUrl),
        markdown: turndown.turndown(document.body ? document.body.innerHTML : '').trim(),
        finalUrl: baseUrl
    }
}

export async function fetchAndClean(url, options = {}) {
    const {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxBytes = DEFAULT_MAX_BYTES,
        signal,
        fetch: fetchImpl = globalThis.fetch
    } = options

    const controller = new AbortController()
    let sizeExceeded = false
    let userAborted = false

    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onUserAbort = () => {
        userAborted = true
        controller.abort()
    }
    if (signal?.aborted) onUserAbort()
    else signal?.addEventListener('abort', onUserAbort, {once: true})

    try {
        let response
        try {
            response = await fetchImpl(url, {
                headers: {'user-agent': USER_AGENT},
                redirect: 'follow',
                signal: controller.signal
            })
        } catch (error) {
            if (userAborted) throw new FetchAndCleanError('Fetch aborted.', 'aborted', error)
            throw new FetchAndCleanError(
                `Could not fetch ${url}: ${describeError(error)}`,
                'network',
                error
            )
        }

        if (!response.ok) {
            throw new FetchAndCleanError(
                `Fetch failed: HTTP ${String(response.status)} ${response.statusText} for ${url}`,
                'http-error'
            )
        }

        const contentType = response.headers.get('content-type') ?? ''
        const kind = classifyContentType(contentType)
        if (kind === 'reject') {
            throw new FetchAndCleanError(
                `${url} is ${contentType || 'an unknown content type'}, not a text or HTML page `
                    + `that can be read.`,
                'not-html'
            )
        }

        const reader = response.body?.getReader()
        if (!reader) {
            throw new FetchAndCleanError(`Could not fetch ${url}: empty response body`, 'network')
        }

        const decoder = decoderFor(contentType)
        let text = ''
        let bytesRead = 0
        try {
            for (;;) {
                const {value, done} = await reader.read()
                if (done) break
                if (!value) continue
                bytesRead += value.byteLength
                // Aborted mid-body rather than after it: the cap exists to stop a huge URL being
                // downloaded at all, and a check that ran after the read would have paid for it.
                if (bytesRead > maxBytes) {
                    sizeExceeded = true
                    controller.abort()
                    break
                }
                text += decoder.decode(value, {stream: true})
            }
            text += decoder.decode()
        } catch (error) {
            if (!sizeExceeded) {
                if (userAborted) throw new FetchAndCleanError('Fetch aborted.', 'aborted', error)
                throw new FetchAndCleanError(
                    `Could not fetch ${url}: ${describeError(error)}`,
                    'network',
                    error
                )
            }
        }

        if (sizeExceeded) {
            throw new FetchAndCleanError(
                `${url} is over the ${formatBytes(maxBytes)} size cap. Try a more specific URL.`,
                'too-large'
            )
        }

        const finalUrl = response.url || url
        if (kind === 'html') return cleanHtml(text, finalUrl)
        // Already clean. Turning markdown or JSON into markdown would only damage it.
        return {title: hostnameOf(finalUrl), markdown: text.trim(), finalUrl}
    } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onUserAbort)
    }
}
