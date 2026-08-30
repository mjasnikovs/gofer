import {parseHTML} from 'linkedom'

export const WEB_SEARCH_TOOL_NAME = 'web_search'

const DEFAULT_COUNT = 10
const MAX_COUNT = 20

export const SEARCH_PROVIDERS = ['exa', 'ddg', 'brave']

export const SEARCH_PROVIDER_LABELS = {exa: 'Exa', ddg: 'DuckDuckGo', brave: 'Brave'}

export function isSearchProvider(value) {
    return typeof value === 'string' && SEARCH_PROVIDERS.includes(value)
}

function clampCount(count) {
    return Math.max(1, Math.min(MAX_COUNT, count ?? DEFAULT_COUNT))
}

function describeError(error) {
    return error instanceof Error ? error.message : String(error)
}

function collapse(text) {
    return text.replace(/\s+/gu, ' ').trim()
}

export class SearchError extends Error {
    constructor(message, kind, status) {
        super(message)
        this.name = 'SearchError'
        this.kind = kind
        this.status = status
    }
}

async function requestWith({url, init, timeoutMs, signal, fetchImpl, engine}) {
    const controller = new AbortController()
    let userAborted = false
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onUserAbort = () => {
        userAborted = true
        controller.abort()
    }
    if (signal?.aborted) onUserAbort()
    else signal?.addEventListener('abort', onUserAbort, {once: true})

    try {
        return await fetchImpl(url, {...init, signal: controller.signal})
    } catch (error) {
        if (userAborted) throw new SearchError('Search stopped.', 'aborted')
        throw new SearchError(`${engine} request failed: ${describeError(error)}`, 'network')
    } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onUserAbort)
    }
}

const EXA_ENDPOINT = 'https://mcp.exa.ai/mcp'
const EXA_TIMEOUT_MS = 30_000
const MAX_DESCRIPTION_CHARS = 400

export function parseExaBody(body) {
    for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
            const candidate = JSON.parse(payload)
            if (candidate.result || candidate.error) return candidate
        } catch {}
    }
    try {
        const candidate = JSON.parse(body)
        if (candidate.result || candidate.error) return candidate
    } catch {}
    throw new SearchError('Exa returned a response that could not be read.', 'protocol')
}

export function parseExaResults(text) {
    const results = []
    for (const block of text.split(/(?=^Title: )/mu).filter(part => part.trim().length > 0)) {
        const title = /^Title: (.+)/mu.exec(block)?.[1]?.trim() ?? ''
        const url = /^URL: (.+)/mu.exec(block)?.[1]?.trim() ?? ''
        if (!url) continue

        let content = ''
        const textAt = block.indexOf('\nText: ')
        if (textAt >= 0) content = block.slice(textAt + '\nText: '.length)
        else {
            const highlights = /\nHighlights:[ \t]*\n/u.exec(block)
            if (highlights?.index !== undefined)
                content = block.slice(highlights.index + highlights[0].length)
        }

        results.push({
            title: title || url,
            url,
            description: content
                .replace(/\n---\s*$/u, '')
                .replace(/\s+/gu, ' ')
                .trim()
                .slice(0, MAX_DESCRIPTION_CHARS)
        })
    }
    return results
}

export async function exaSearch(query, {count, signal, fetch: fetchImpl = globalThis.fetch} = {}) {
    const wanted = clampCount(count)
    const response = await requestWith({
        url: EXA_ENDPOINT,
        engine: 'Exa',
        timeoutMs: EXA_TIMEOUT_MS,
        signal,
        fetchImpl,
        init: {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'web_search_exa',
                    arguments: {
                        query,
                        numResults: wanted,
                        type: 'auto',
                        livecrawl: 'fallback',
                        contextMaxCharacters: 3000
                    }
                }
            })
        }
    })

    if (!response.ok) {
        throw new SearchError(
            `Exa answered HTTP ${String(response.status)} ${response.statusText}`,
            'http',
            response.status
        )
    }

    const rpc = parseExaBody(await response.text())
    if (rpc.error) {
        throw new SearchError(
            `Exa error${rpc.error.code === undefined ? '' : ` ${String(rpc.error.code)}`}: `
                + `${rpc.error.message ?? 'no reason given'}`,
            'protocol'
        )
    }
    const text = rpc.result?.content?.find(
        part => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0
    )?.text
    if (rpc.result?.isError)
        throw new SearchError(text?.trim() || 'Exa returned an error result.', 'protocol')
    if (!text) throw new SearchError('Exa returned no results at all.', 'protocol')

    return parseExaResults(text).slice(0, wanted)
}

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'
const DDG_TIMEOUT_MS = 15_000

const DDG_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'

export function unwrapDdgRedirect(href) {
    let parsed
    try {
        parsed = new URL(href, 'https://duckduckgo.com')
    } catch {
        return null
    }
    if (!parsed.hostname.endsWith('duckduckgo.com')) return parsed.toString()
    const destination = parsed.searchParams.get('uddg')
    if (!destination) return null
    try {
        return new URL(destination).toString()
    } catch {
        return null
    }
}

export function parseDdgHtml(html) {
    const {document} = parseHTML(html)
    const results = []
    for (const anchor of document.querySelectorAll('a.result__a')) {
        if (anchor.closest('.result--ad')) continue

        const href = anchor.getAttribute('href')
        const url = href === null ? null : unwrapDdgRedirect(href)
        if (url === null) continue

        const title = collapse(anchor.textContent ?? '')
        if (!title) continue

        const row = anchor.closest('.result')
        results.push({
            title,
            url,
            description: collapse(row?.querySelector('.result__snippet')?.textContent ?? '')
        })
    }
    return results
}

export async function ddgSearch(query, {count, signal, fetch: fetchImpl = globalThis.fetch} = {}) {
    const response = await requestWith({
        url: `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`,
        engine: 'DuckDuckGo',
        timeoutMs: DDG_TIMEOUT_MS,
        signal,
        fetchImpl,
        init: {method: 'GET', headers: {'user-agent': DDG_USER_AGENT, accept: 'text/html'}}
    })

    if (response.status === 429 || response.status === 403) {
        throw new SearchError(
            `DuckDuckGo is rate-limiting this machine (HTTP ${String(response.status)}). `
                + `Wait a moment, or switch the search engine in settings.`,
            'rate-limit',
            response.status
        )
    }
    if (!response.ok) {
        throw new SearchError(
            `DuckDuckGo answered HTTP ${String(response.status)} ${response.statusText}`,
            'http',
            response.status
        )
    }

    return parseDdgHtml(await response.text()).slice(0, clampCount(count))
}

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const BRAVE_TIMEOUT_MS = 10_000

export async function braveSearch(
    query,
    {apiKey, count, signal, fetch: fetchImpl = globalThis.fetch} = {}
) {
    const wanted = clampCount(count)
    const response = await requestWith({
        url: `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${String(wanted)}`,
        engine: 'Brave',
        timeoutMs: BRAVE_TIMEOUT_MS,
        signal,
        fetchImpl,
        init: {
            method: 'GET',
            headers: {accept: 'application/json', 'x-subscription-token': apiKey}
        }
    })

    if (response.status === 401 || response.status === 403) {
        throw new SearchError(
            `Brave rejected the key (HTTP ${String(response.status)}). Check it in settings.`,
            'auth',
            response.status
        )
    }
    if (response.status === 429) {
        throw new SearchError(
            'Brave rate limit reached (HTTP 429). Wait a moment, or switch the search engine.',
            'rate-limit',
            429
        )
    }
    if (!response.ok) {
        throw new SearchError(
            `Brave answered HTTP ${String(response.status)} ${response.statusText}`,
            'http',
            response.status
        )
    }

    const body = await response.json()
    return (body.web?.results ?? [])
        .filter(
            result =>
                typeof result.title === 'string'
                && typeof result.url === 'string'
                && typeof result.description === 'string'
        )
        .map(result => ({
            title: result.title,
            url: result.url,
            description: result.description
        }))
}

const NO_KEY_MESSAGE =
    'Brave Search has no API key. Add one on the settings page, or switch the search engine to '
    + 'Exa or DuckDuckGo, which need no key.'

export async function search({
    query,
    count,
    provider,
    apiKey,
    signal,
    exa = exaSearch,
    ddg = ddgSearch,
    brave = braveSearch,
    fetch: fetchImpl
} = {}) {
    if (provider === 'brave' && !apiKey) return {kind: 'no_key', message: NO_KEY_MESSAGE}

    const run = () => {
        const options = {count, signal, fetch: fetchImpl}
        if (provider === 'brave') return brave(query, {...options, apiKey})
        if (provider === 'ddg') return ddg(query, options)
        return exa(query, options)
    }

    try {
        return {kind: 'ok', results: await run()}
    } catch (error) {
        return {kind: 'error', message: describeError(error)}
    }
}

const MAX_RESULT_TEXT_CHARS = 8_000

export function formatResults(results) {
    const lines = results.map(
        (result, index) =>
            `${String(index + 1)}. [${result.title}](${result.url}) — ${result.description}`
    )
    const text = lines.join('\n')
    if (text.length <= MAX_RESULT_TEXT_CHARS) return text
    const kept = []
    let used = 0
    for (const line of lines) {
        if (used + line.length > MAX_RESULT_TEXT_CHARS) break
        kept.push(line)
        used += line.length + 1
    }
    return `${kept.join('\n')}\n[${String(lines.length - kept.length)} more results not shown]`
}

const WEB_SEARCH_DESCRIPTION =
    'Search the live web and get back a list of results — title, URL, and a snippet.\n'
    + '\n'
    + 'CALL THIS BEFORE ANSWERING any question about current or version-specific facts outside this '
    + 'project: library and framework versions, their APIs, recent releases, newly shipped '
    + 'features, current events, prices, or who holds a role right now. Your built-in knowledge has '
    + 'a cutoff and these are exactly the facts that move. Do NOT answer such questions from '
    + 'memory, and do NOT shell out with bash to guess at them.\n'
    + '\n'
    + 'Then call web_fetch on the result you want to read. This returns snippets, not pages.\n'
    + '\n'
    + 'Do not reach for it when:\n'
    + '- the question is about Godot itself — use godot_docs_search, which holds the real 4.7 docs\n'
    + '- the question is about this project’s own files — use the subagent tool'

export const WEB_SEARCH_PROBE_ANSWER = 'web-search-reachable'

export function createWebSearchTool({provider, apiKey, search: searchImpl = search} = {}) {
    return {
        name: WEB_SEARCH_TOOL_NAME,
        label: 'web search',
        description: WEB_SEARCH_DESCRIPTION,
        parameters: {
            type: 'object',
            properties: {
                query: {type: 'string', description: 'What to search for.'},
                count: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_COUNT,
                    description: 'How many results to return. Ten by default, twenty at most.'
                }
            },
            required: ['query']
        },
        execute: async (_toolCallId, params, signal) => {
            if (params?.probe === true) {
                return {
                    content: [{type: 'text', text: WEB_SEARCH_PROBE_ANSWER}],
                    details: {provider}
                }
            }
            if (typeof params?.query !== 'string' || params.query.trim() === '')
                throw new Error('web_search was given no query to search for.')

            const result = await searchImpl({
                query: params.query,
                count: params.count,
                provider,
                apiKey,
                signal
            })

            if (result.kind !== 'ok') {
                return {
                    content: [{type: 'text', text: result.message}],
                    details: {provider, resultCount: 0}
                }
            }
            if (result.results.length === 0) {
                return {
                    content: [{type: 'text', text: `No results for: ${params.query}`}],
                    details: {provider, resultCount: 0}
                }
            }
            return {
                content: [{type: 'text', text: formatResults(result.results)}],
                details: {provider, resultCount: result.results.length}
            }
        }
    }
}
