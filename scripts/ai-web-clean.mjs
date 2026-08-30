import {Readability} from '@mozilla/readability'
import {parseHTML} from 'linkedom'
import TurndownService from 'turndown'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

const USER_AGENT = 'Gofer/1.0 (+https://github.com/mjasnikovs/gofer)'

const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    bulletListMarker: '-'
})

export class FetchAndCleanError extends Error {
    constructor(message, kind, cause) {
        super(message)
        this.name = 'FetchAndCleanError'
        this.kind = kind
        this.cause = cause
    }
}

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

export function decoderFor(contentType) {
    const charset = /charset=([^;]+)/iu
        .exec(contentType)?.[1]
        ?.trim()
        .replace(/^["']|["']$/gu, '')
    if (charset) {
        try {
            return new TextDecoder(charset, {fatal: false})
        } catch {}
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
        return {title: hostnameOf(finalUrl), markdown: text.trim(), finalUrl}
    } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onUserAbort)
    }
}
