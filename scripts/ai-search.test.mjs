import assert from 'node:assert/strict'
import test from 'node:test'
import {
    SEARCH_PROVIDERS,
    SEARCH_PROVIDER_LABELS,
    SearchError,
    braveSearch,
    createWebSearchTool,
    ddgSearch,
    exaSearch,
    formatResults,
    isSearchProvider,
    parseDdgHtml,
    parseExaResults,
    search,
    unwrapDdgRedirect
} from './ai-search.mjs'

/** A server that answers once, passed in rather than swapped onto the global. */
function servedWith(body, {status = 200, statusText = 'OK', headers = {}} = {}) {
    const calls = []
    return {
        calls,
        fetch: (url, init) => {
            calls.push({url, init})
            return Promise.resolve(new Response(body, {status, statusText, headers}))
        }
    }
}

const sseBody = payload => `event: message\ndata: ${JSON.stringify(payload)}\n\n`

const mcpText = (...blocks) => ({
    result: {content: [{type: 'text', text: blocks.join('\n\n---\n\n')}]}
})

const exaBlock = (title, url, text) => `Title: ${title}\nURL: ${url}\nText: ${text}`

// ─── Exa ────────────────────────────────────────────────────────────────────

test('an Exa event-stream body parses into results', async () => {
    const server = servedWith(
        sseBody(
            mcpText(
                exaBlock('Bun SQLite', 'https://bun.com/docs/api/sqlite', 'The bun:sqlite module.'),
                exaBlock('Bun HTTP', 'https://bun.com/docs/api/http', 'Bun.serve starts a server.')
            )
        )
    )

    const results = await exaSearch('bun sqlite', {fetch: server.fetch})

    assert.equal(results.length, 2)
    assert.deepEqual(results[0], {
        title: 'Bun SQLite',
        url: 'https://bun.com/docs/api/sqlite',
        description: 'The bun:sqlite module.'
    })
})

test('a plain JSON Exa body parses the same way', async () => {
    // The endpoint genuinely answers both ways. A parser written to only the documented shape
    // breaks intermittently, which looks like the query having no results.
    const server = servedWith(
        JSON.stringify(mcpText(exaBlock('One', 'https://one.example/', 'first')))
    )

    const results = await exaSearch('q', {fetch: server.fetch})

    assert.equal(results[0].url, 'https://one.example/')
})

test('Exa blocks with no URL are dropped and the rest survive', () => {
    const results = parseExaResults(
        [
            'Title: No link\nText: nothing to read',
            exaBlock('Real', 'https://real.example/', 'yes')
        ].join('\n\n---\n\n')
    )

    assert.equal(results.length, 1)
    assert.equal(results[0].title, 'Real')
})

test('an Exa block with no title is titled by its URL', () => {
    const results = parseExaResults('Title: \nURL: https://x.example/\nText: body')

    assert.equal(results[0].title, 'https://x.example/')
})

test('Exa descriptions are collapsed to one line', () => {
    const results = parseExaResults(exaBlock('T', 'https://x.example/', 'one\n\ntwo   three'))

    assert.equal(results[0].description, 'one two three')
})

test('Exa returns no more results than were asked for', async () => {
    const blocks = Array.from({length: 5}, (_unused, index) =>
        exaBlock(`T${String(index)}`, `https://x.example/${String(index)}`, 'body')
    )
    const server = servedWith(sseBody(mcpText(...blocks)))

    const results = await exaSearch('q', {count: 2, fetch: server.fetch})

    assert.deepEqual(
        results.map(result => result.title),
        ['T0', 'T1']
    )
})

test('an Exa error frame is reported with its reason', async () => {
    const server = servedWith(sseBody({error: {code: -32_000, message: 'rate limited'}}))

    await assert.rejects(exaSearch('q', {fetch: server.fetch}), error => {
        assert.match(error.message, /Exa error -32000: rate limited/u)
        return true
    })
})

test('an Exa HTTP failure carries its status', async () => {
    const server = servedWith('down', {status: 503, statusText: 'Service Unavailable'})

    await assert.rejects(exaSearch('q', {fetch: server.fetch}), error => {
        assert.ok(error instanceof SearchError)
        assert.equal(error.kind, 'http')
        assert.equal(error.status, 503)
        return true
    })
})

test('an unreadable Exa body is a protocol failure, not a crash', async () => {
    const server = servedWith('<html>not json at all</html>')

    await assert.rejects(exaSearch('q', {fetch: server.fetch}), error => {
        assert.equal(error.kind, 'protocol')
        return true
    })
})

test('Exa is asked keylessly, and asked for what it was told', async () => {
    const server = servedWith(sseBody(mcpText(exaBlock('T', 'https://x.example/', 'b'))))

    await exaSearch('bun sqlite api', {count: 7, fetch: server.fetch})

    const [call] = server.calls
    assert.equal(call.url, 'https://mcp.exa.ai/mcp')
    // Keyless is the whole reason this is the default engine. A header that looks like auth would
    // mean a key had crept in from somewhere.
    for (const name of Object.keys(call.init.headers)) assert.doesNotMatch(name, /key|token|auth/iu)
    const body = JSON.parse(call.init.body)
    assert.equal(body.params.name, 'web_search_exa')
    assert.equal(body.params.arguments.query, 'bun sqlite api')
    assert.equal(body.params.arguments.numResults, 7)
})

// ─── DuckDuckGo ─────────────────────────────────────────────────────────────

const ddgRow = (title, href, snippet, {ad = false} = {}) =>
    `<div class="result${ad ? ' result--ad' : ''}">`
    + `<a class="result__a" href="${href}">${title}</a>`
    + `<a class="result__snippet">${snippet}</a>`
    + `</div>`

const ddgPage = (...rows) => `<div id="links" class="results">${rows.join('')}</div>`

const wrapped = destination =>
    `//duckduckgo.com/l/?uddg=${encodeURIComponent(destination)}&rut=abc123`

test('a DuckDuckGo redirect is unwrapped to its destination', () => {
    const html = ddgPage(
        ddgRow('Bun docs', wrapped('https://bun.com/docs'), 'The <b>bun</b> runtime.')
    )

    const [result] = parseDdgHtml(html)

    assert.equal(result.url, 'https://bun.com/docs')
    assert.equal(result.title, 'Bun docs')
    assert.equal(result.description, 'The bun runtime.')
})

test('ad rows and links that never leave duckduckgo.com are dropped', () => {
    // The middle href is a real observed shape: an ad click-tracker with no uddg destination.
    // Without this, DuckDuckGo's own trackers are handed back as search results.
    const html = ddgPage(
        ddgRow('An ad', wrapped('https://sponsor.example/'), 'buy', {ad: true}),
        ddgRow('Tracker', '//duckduckgo.com/y.js?ad_provider=x', 'promoted'),
        ddgRow('Real', wrapped('https://real.example/'), 'genuine')
    )

    const results = parseDdgHtml(html)

    assert.equal(results.length, 1)
    assert.equal(results[0].url, 'https://real.example/')
})

test('a non-DuckDuckGo href passes through, and an unparseable one is dropped', () => {
    assert.equal(unwrapDdgRedirect('https://direct.example/a'), 'https://direct.example/a')
    assert.equal(unwrapDdgRedirect('//duckduckgo.com/l/?rut=x'), null)
    assert.equal(unwrapDdgRedirect('//duckduckgo.com/l/?uddg=not%20a%20url'), null)
})

test('DuckDuckGo titles and snippets are collapsed to one line', () => {
    const html = ddgPage(ddgRow('  Spaced\n  Title  ', wrapped('https://x.example/'), 'a\n  b'))

    const [result] = parseDdgHtml(html)

    assert.equal(result.title, 'Spaced Title')
    assert.equal(result.description, 'a b')
})

test('a bot-challenge page is no results rather than a throw', () => {
    // DuckDuckGo serves this with HTTP 200 and no error, so nothing else can tell it apart.
    assert.deepEqual(parseDdgHtml('<div class="anomaly-modal">prove you are human</div>'), [])
})

test('DuckDuckGo returns no more results than were asked for', async () => {
    const rows = Array.from({length: 5}, (_unused, index) =>
        ddgRow(`T${String(index)}`, wrapped(`https://x.example/${String(index)}`), 'body')
    )
    const server = servedWith(ddgPage(...rows))

    const results = await ddgSearch('q', {count: 2, fetch: server.fetch})

    assert.equal(results.length, 2)
})

test('DuckDuckGo is asked keylessly, as a browser', async () => {
    const server = servedWith(ddgPage())

    await ddgSearch('bun sqlite api', {fetch: server.fetch})

    const [call] = server.calls
    assert.equal(call.url, 'https://html.duckduckgo.com/html/?q=bun%20sqlite%20api')
    // Without a browser user-agent DuckDuckGo serves the challenge page above — HTTP 200, zero
    // results, no error. The worst shape of silent breakage.
    assert.match(call.init.headers['user-agent'], /^Mozilla\/5\.0/u)
    for (const name of Object.keys(call.init.headers)) assert.doesNotMatch(name, /key|token|auth/iu)
})

test('DuckDuckGo rate limiting is its own kind of failure', async () => {
    for (const status of [429, 403]) {
        const server = servedWith('slow down', {status})

        await assert.rejects(ddgSearch('q', {fetch: server.fetch}), error => {
            // Distinct from a broken engine, so the message can say "wait" rather than "it is down".
            assert.equal(error.kind, 'rate-limit')
            assert.match(error.message, /rate-limiting/u)
            return true
        })
    }
})

test('any other DuckDuckGo HTTP failure carries its status', async () => {
    const server = servedWith('boom', {status: 500, statusText: 'Internal Server Error'})

    await assert.rejects(ddgSearch('q', {fetch: server.fetch}), error => {
        assert.equal(error.kind, 'http')
        assert.equal(error.status, 500)
        return true
    })
})

// ─── Brave ──────────────────────────────────────────────────────────────────

test('Brave results are normalised, and the key travels in its header', async () => {
    const server = servedWith(
        JSON.stringify({
            web: {
                results: [
                    {title: 'A', url: 'https://a.example/', description: 'first'},
                    {title: 'B', url: 'https://b.example/', description: 'second'}
                ]
            }
        })
    )

    const results = await braveSearch('hello world', {apiKey: 'test-key', fetch: server.fetch})

    assert.equal(server.calls[0].init.headers['x-subscription-token'], 'test-key')
    assert.match(server.calls[0].url, /q=hello%20world/u)
    assert.deepEqual(results[0], {title: 'A', url: 'https://a.example/', description: 'first'})
})

test('a Brave body with no results is an empty list, not a crash', async () => {
    const server = servedWith(JSON.stringify({query: {original: 'x'}}))

    assert.deepEqual(await braveSearch('x', {apiKey: 'k', fetch: server.fetch}), [])
})

test('a rejected Brave key says so, and says where to fix it', async () => {
    for (const status of [401, 403]) {
        const server = servedWith('nope', {status})

        await assert.rejects(braveSearch('q', {apiKey: 'bad', fetch: server.fetch}), error => {
            assert.equal(error.kind, 'auth')
            assert.match(error.message, /settings/u)
            return true
        })
    }
})

test('an over-large Brave request is clamped rather than refused by Brave', async () => {
    const server = servedWith(JSON.stringify({web: {results: []}}))

    await braveSearch('q', {apiKey: 'k', count: 999, fetch: server.fetch})

    assert.match(server.calls[0].url, /count=20/u)
})

// ─── Choosing an engine ─────────────────────────────────────────────────────

function refuses(name) {
    return () => {
        throw new Error(`${name} must not be called`)
    }
}

test('the chosen engine is the only one asked', async () => {
    for (const provider of ['exa', 'ddg', 'brave']) {
        const asked = []
        const engine = name => query => {
            asked.push(name)
            return Promise.resolve([
                {title: name, url: `https://${name}.example/`, description: query}
            ])
        }

        const result = await search({
            query: 'q',
            provider,
            apiKey: 'k',
            exa: provider === 'exa' ? engine('exa') : refuses('exa'),
            ddg: provider === 'ddg' ? engine('ddg') : refuses('ddg'),
            brave: provider === 'brave' ? engine('brave') : refuses('brave')
        })

        assert.equal(result.kind, 'ok')
        assert.deepEqual(asked, [provider])
    }
})

test('a failing engine is reported as a failure, never answered by another one', async () => {
    // The highest-value assertion here. A valid Brave key is present, so an engine that quietly
    // fell back would pass every other test in this file — and the user would be reading results
    // from an engine they did not choose, with nothing on screen saying so.
    const result = await search({
        query: 'q',
        provider: 'exa',
        apiKey: 'a-perfectly-good-brave-key',
        exa: () => Promise.reject(new SearchError('Exa error: down', 'protocol')),
        ddg: refuses('ddg'),
        brave: refuses('brave')
    })

    assert.equal(result.kind, 'error')
    assert.match(result.message, /Exa error: down/u)
})

test('Brave with no key says so before any request is made', async () => {
    const result = await search({query: 'q', provider: 'brave', brave: refuses('brave')})

    assert.equal(result.kind, 'no_key')
    // Both ways out are named: add a key, or pick an engine that needs none.
    assert.match(result.message, /settings page/u)
    assert.match(result.message, /Exa or DuckDuckGo/u)
})

test('the count and the stop signal reach the engine unchanged', async () => {
    const controller = new AbortController()
    let seen

    await search({
        query: 'q',
        count: 3,
        provider: 'exa',
        signal: controller.signal,
        exa: (_query, options) => {
            seen = options
            return Promise.resolve([])
        }
    })

    assert.equal(seen.count, 3)
    assert.equal(seen.signal, controller.signal)
})

test('every engine has a label, and no label is a storable value', () => {
    for (const provider of SEARCH_PROVIDERS) {
        assert.equal(typeof SEARCH_PROVIDER_LABELS[provider], 'string')
        assert.ok(isSearchProvider(provider))
    }
    // A settings file holding "DuckDuckGo" would match no engine at all, so the display name must
    // never pass as a stored id.
    assert.ok(!isSearchProvider('DuckDuckGo'))
    assert.ok(!isSearchProvider('Google'))
    const labels = Object.values(SEARCH_PROVIDER_LABELS)
    assert.equal(new Set(labels).size, labels.length)
})

// ─── The tool ───────────────────────────────────────────────────────────────

test('results are numbered markdown the model can act on', () => {
    const text = formatResults([
        {title: 'Foo', url: 'https://foo.example/', description: 'about foo'},
        {title: 'Bar', url: 'https://bar.example/', description: 'about bar'}
    ])

    assert.equal(
        text,
        '1. [Foo](https://foo.example/) — about foo\n2. [Bar](https://bar.example/) — about bar'
    )
})

test('an oversized result set is cut at a whole result', () => {
    // ai-host.mjs caps only the results it builds itself, so a tool that assembles its own text is
    // capped by nothing at all.
    const many = Array.from({length: 20}, (_unused, index) => ({
        title: `Result ${String(index)}`,
        url: `https://example.com/${String(index)}`,
        description: 'x'.repeat(400)
    }))

    const text = formatResults(many)

    assert.ok(text.length < 9_000)
    assert.match(text, /more results not shown/u)
    // Cut between results, never mid-line: half a URL is not a link anyone can follow.
    for (const line of text.split('\n')) {
        if (line.startsWith('[')) continue
        assert.match(line, /^\d+\. \[.+\]\(https:\/\/example\.com\/\d+\) — x+$/u)
    }
})

test('no results is an answer, not an error', async () => {
    const tool = createWebSearchTool({
        provider: 'exa',
        search: () => Promise.resolve({kind: 'ok', results: []})
    })

    const result = await tool.execute('id', {query: 'asdfqwerty'}, undefined)

    assert.match(result.content[0].text, /No results for: asdfqwerty/u)
    assert.equal(result.details.resultCount, 0)
})

test('an engine failure reaches the model as words it can read', async () => {
    const tool = createWebSearchTool({
        provider: 'brave',
        search: () => Promise.resolve({kind: 'no_key', message: 'Brave Search has no API key.'})
    })

    const result = await tool.execute('id', {query: 'q'}, undefined)

    // Not a throw: the model can pick a different approach if it is told why, and a thrown error
    // reads to it as the tool being broken.
    assert.match(result.content[0].text, /no API key/u)
    assert.equal(result.details.resultCount, 0)
})

test('an empty query is refused before an engine is reached', async () => {
    const tool = createWebSearchTool({provider: 'exa', search: refuses('search')})

    await assert.rejects(tool.execute('id', {query: '   '}, undefined), /no query/u)
})

test('the tool proves itself before the turn, without spending a search', async () => {
    const tool = createWebSearchTool({provider: 'exa', search: refuses('search')})

    const result = await tool.execute('reachability-probe', {probe: true}, undefined)

    // A real request here would leak a query to an engine every turn, and spend a Brave quota on a
    // tool the user may never call.
    assert.match(result.content[0].text, /web-search-reachable/u)
})
