import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {
    FetchAndCleanError,
    classifyContentType,
    cleanHtml,
    decoderFor,
    fetchAndClean
} from './ai-web-clean.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = name => readFileSync(join(here, '__fixtures__', name), 'utf8')

function servedWith(body, {status = 200, statusText = 'OK', headers = {}, url} = {}) {
    const calls = []
    const respond = (requested, init) => {
        calls.push({url: requested, init})
        return Promise.resolve(
            new Response(body, {
                status,
                statusText,
                headers: {'content-type': 'text/html', ...headers}
            })
        )
    }
    return {
        calls,
        fetch:
            url ?
                async (...args) =>
                    Object.defineProperty(await respond(...args), 'url', {value: url})
            :   respond
    }
}

test('the article survives and the furniture does not', () => {
    const result = cleanHtml(fixture('article-clean.html'), 'https://example.com/post')

    assert.equal(result.title, 'Hello World')
    assert.ok(result.markdown.includes('first paragraph'))
    assert.ok(result.markdown.includes('second paragraph'))
    assert.ok(!result.markdown.includes('menu menu menu'))
    assert.ok(!result.markdown.includes('copyright'))
    assert.equal(result.finalUrl, 'https://example.com/post')
})

test('ads and sidebars are stripped, and the real paragraph is kept', () => {
    const result = cleanHtml(fixture('article-with-ads.html'), 'https://example.com/x')

    assert.ok(result.markdown.includes('genuine article paragraph one'))
    assert.ok(!result.markdown.includes('BUY NOW'))
    assert.ok(!result.markdown.includes('ANOTHER AD'))
    assert.ok(!result.markdown.includes('footer junk'))
})

test('a page whose content arrives by script cleans to almost nothing', () => {
    const result = cleanHtml(fixture('spa-empty.html'), 'https://example.com/app')

    assert.ok(result.markdown.length < 50)
})

test('code blocks stay fenced', () => {
    const result = cleanHtml(fixture('with-code-blocks.html'), 'https://example.com/code')

    assert.ok(result.markdown.includes('```'))
    assert.ok(result.markdown.includes('const x: number = 1'))
})

test('every table cell survives the conversion', () => {
    const result = cleanHtml(fixture('with-tables.html'), 'https://example.com/t')

    assert.ok(result.markdown.includes('a1'))
    assert.ok(result.markdown.includes('b2'))
    assert.ok(result.markdown.includes('Col A'))
})

test('a page with no title is titled by its host', () => {
    const result = cleanHtml('<html><body><p>hi</p></body></html>', 'https://example.com/p')

    assert.equal(result.title, 'example.com')
})

test('a fetched page comes back cleaned', async () => {
    const server = servedWith(fixture('article-clean.html'), {url: 'https://example.com/post'})

    const result = await fetchAndClean('https://example.com/post', {fetch: server.fetch})

    assert.equal(result.title, 'Hello World')
    assert.ok(result.markdown.includes('first paragraph'))
    assert.equal(result.finalUrl, 'https://example.com/post')
})

test('a PDF is refused by name rather than decoded into nonsense', async () => {
    const server = servedWith('%PDF-1.4 binary junk', {
        headers: {'content-type': 'application/pdf'}
    })

    await assert.rejects(
        fetchAndClean('https://example.com/doc.pdf', {fetch: server.fetch}),
        error => {
            assert.ok(error instanceof FetchAndCleanError)
            assert.equal(error.kind, 'not-html')
            assert.match(error.message, /not a text or HTML page/u)
            return true
        }
    )
})

test('markdown, plain text and JSON pass through untouched', async () => {
    const cases = [
        ['text/markdown; charset=utf-8', '# Title\n\nSome **bold** text.', /\*\*bold\*\*/u],
        ['text/plain', 'User-agent: *\nDisallow: /private', /Disallow: \/private/u],
        ['application/json', '{"name":"gofer","version":"1.0"}', /"name":"gofer"/u]
    ]

    for (const [contentType, body, expected] of cases) {
        const server = servedWith(body, {
            headers: {'content-type': contentType},
            url: 'https://e.co/f'
        })
        const result = await fetchAndClean('https://e.co/f', {fetch: server.fetch})

        assert.match(result.markdown, expected)
        assert.equal(result.title, 'e.co')
    }
})

test('a response with no content-type at all is read as text', async () => {
    assert.equal(classifyContentType(''), 'text')

    const server = servedWith('plain words', {headers: {'content-type': ''}})
    const result = await fetchAndClean('https://example.com/llms.txt', {fetch: server.fetch})

    assert.equal(result.markdown, 'plain words')
})

test('xhtml goes down the HTML path', async () => {
    const server = servedWith(fixture('article-clean.html'), {
        headers: {'content-type': 'application/xhtml+xml'},
        url: 'https://example.com/post'
    })

    const result = await fetchAndClean('https://example.com/post', {fetch: server.fetch})

    assert.ok(!result.markdown.includes('menu menu menu'))
})

test('a page that declares its charset is decoded with it', async () => {
    const server = servedWith(new Uint8Array([0x63, 0xe9]), {
        headers: {'content-type': 'text/plain; charset=iso-8859-1'}
    })

    const result = await fetchAndClean('https://example.com/fr', {fetch: server.fetch})

    assert.equal(result.markdown, 'cé')
    assert.ok(!result.markdown.includes('�'))
})

test('an unknown charset label falls back to UTF-8 instead of throwing', () => {
    assert.equal(decoderFor('text/plain; charset=not-a-real-encoding').encoding, 'utf-8')
    assert.equal(decoderFor('text/plain; charset="iso-8859-1"').encoding, 'windows-1252')
    assert.equal(decoderFor('text/html').encoding, 'utf-8')
})

test('the fetcher says what it is', async () => {
    const server = servedWith('<html><body><p>hi there friend</p></body></html>')

    await fetchAndClean('https://example.com/p', {fetch: server.fetch})

    assert.match(server.calls[0].init.headers['user-agent'], /^Gofer\//u)
    assert.equal(server.calls[0].init.redirect, 'follow')
})

test('a response over the size cap is abandoned mid-body', async () => {
    const server = servedWith('a'.repeat(3 * 1024 * 1024))

    await assert.rejects(
        fetchAndClean('https://example.com/huge', {fetch: server.fetch, maxBytes: 1024 * 1024}),
        error => {
            assert.equal(error.kind, 'too-large')
            assert.match(error.message, /1\.0 MB size cap/u)
            return true
        }
    )
})

test('an HTTP error is reported with its status', async () => {
    const server = servedWith('nope', {status: 404, statusText: 'Not Found'})

    await assert.rejects(
        fetchAndClean('https://example.com/missing', {fetch: server.fetch}),
        error => {
            assert.equal(error.kind, 'http-error')
            assert.match(error.message, /HTTP 404/u)
            return true
        }
    )
})

test('a stopped turn stops the fetch, and says so as a stop', async () => {
    const server = servedWith('<html><body><p>hi</p></body></html>')

    await assert.rejects(
        fetchAndClean('https://example.com/p', {
            fetch: () => Promise.reject(new Error('The operation was aborted')),
            signal: AbortSignal.abort()
        }),
        error => {
            assert.equal(error.kind, 'aborted')
            return true
        }
    )
    assert.equal(server.calls.length, 0)
})

test('a request that never answers is given up on', async () => {
    const result = fetchAndClean('https://example.com/slow', {
        timeoutMs: 20,
        fetch: (_url, init) =>
            new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                    once: true
                })
            })
    })

    await assert.rejects(result, error => {
        assert.equal(error.kind, 'network')
        return true
    })
})
