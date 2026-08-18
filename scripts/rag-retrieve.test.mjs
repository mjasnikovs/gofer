import assert from 'node:assert/strict'
import test from 'node:test'
import {createRetriever, RESPONSE_PREFIX, runRetrieve, validateRequest} from './rag-retrieve.mjs'

function fakeRetrieve(chunks) {
    return async (_question, _options) => chunks
}

function request(overrides = {}) {
    return JSON.stringify({
        question: 'how do I use tweens?',
        cacheDir: '/cache',
        ...overrides
    })
}

test('validateRequest normalizes defaults and rejects malformed input', () => {
    assert.deepEqual(validateRequest({question: '  hello ', cacheDir: '/cache'}), {
        question: 'hello',
        cacheDir: '/cache',
        maxPassages: 10,
        maxTextChars: 2000,
        mode: 'search'
    })

    assert.deepEqual(
        validateRequest({question: 'x', cacheDir: '/cache', maxPassages: 3, maxTextChars: 100}),
        {
            question: 'x',
            cacheDir: '/cache',
            maxPassages: 3,
            maxTextChars: 100,
            mode: 'search'
        }
    )

    for (const [label, value, expected] of [
        ['empty question', {question: '', cacheDir: '/cache'}, 'non-empty question'],
        ['whitespace question', {question: '   ', cacheDir: '/cache'}, 'non-empty question'],
        ['missing question', {cacheDir: '/cache'}, 'non-empty question'],
        ['empty cacheDir', {question: 'x', cacheDir: ''}, 'cacheDir'],
        ['missing cacheDir', {question: 'x'}, 'cacheDir'],
        ['zero maxPassages', {question: 'x', cacheDir: '/cache', maxPassages: 0}, 'maxPassages'],
        [
            'negative maxPassages',
            {question: 'x', cacheDir: '/cache', maxPassages: -1},
            'maxPassages'
        ],
        [
            'string maxPassages',
            {question: 'x', cacheDir: '/cache', maxPassages: 'many'},
            'maxPassages'
        ],
        ['zero maxTextChars', {question: 'x', cacheDir: '/cache', maxTextChars: 0}, 'maxTextChars'],
        [
            'string maxTextChars',
            {question: 'x', cacheDir: '/cache', maxTextChars: 'long'},
            'maxTextChars'
        ]
    ]) {
        assert.throws(() => validateRequest(value), new RegExp(expected, 'u'), label)
    }
})

test('returns ranked passages stripped of vector and bounded by maxTextChars', async () => {
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([
            {text: 'a'.repeat(3000), chapter: 'Tween', order: 3, score: 0.9, vector: [1, 2]},
            {text: 'b', chapter: 'Animation', order: 7, score: 0.8, vector: [3, 4]}
        ])
    })

    const response = await handleLine(request({maxPassages: 2, maxTextChars: 10}))

    // `corpusVersion` rides along so a cached answer can be thrown away when the manual moves. It
    // is read from the installed package, so the value is whatever this checkout has.
    assert.deepEqual(response.passages, [
        {text: 'a'.repeat(10), chapter: 'Tween', order: 3, score: 0.9},
        {text: 'b', chapter: 'Animation', order: 7, score: 0.8}
    ])
    assert.match(response.corpusVersion, /^\d+\.\d+\.\d+/u)
})

test('uses default limits when they are omitted', async () => {
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([{text: 'short', chapter: 'Node', order: 1, score: 0.5}])
    })

    const response = await handleLine(request())

    assert.equal(response.passages.length, 1)
    assert.equal(response.passages[0].text, 'short')
})

test('the connection becomes the complete function gofer-rag calls', async () => {
    const connection = {baseUrl: 'http://127.0.0.1:8080/v1', model: 'small.gguf'}
    let received
    let built
    const handleLine = createRetriever({
        retrieve: async (_question, options) => {
            received = options
            return []
        },
        createCompletion: supplied => {
            built = supplied
            return async () => 'Tween, Animation'
        }
    })

    await handleLine(request({connection}))

    assert.deepEqual(built, connection)
    assert.equal(typeof received.complete, 'function')
    assert.equal(
        await received.complete({system: 's', user: 'u', maxTokens: 100}),
        'Tween, Animation'
    )
})

test('no connection refuses rather than letting the package open its own socket', async () => {
    let received
    const handleLine = createRetriever({
        retrieve: async (_question, options) => {
            received = options
            return []
        },
        createCompletion: () => undefined
    })

    await handleLine(request())

    // Handed nothing, gofer-rag posts to a hardcoded localhost address instead. A refusal is what
    // makes "no connection" mean unexpanded retrieval rather than a prompt sent to a stranger.
    assert.equal(typeof received.complete, 'function')
    await assert.rejects(() => received.complete({}), /No model connection was supplied/u)
})

test('a connection that is not an object is refused', async () => {
    const handleLine = createRetriever({retrieve: fakeRetrieve([])})

    for (const connection of ['local', 42, null]) {
        const response = await handleLine(request({connection}))
        assert.match(response.error, /connection must be an object/u)
    }
})

test('passes cacheDir and disables model downloads to retrieve', async () => {
    let receivedOptions
    const handleLine = createRetriever({
        retrieve: async (_question, options) => {
            receivedOptions = options
            return []
        }
    })

    await handleLine(request())

    assert.equal(receivedOptions.cacheDir, '/cache')
    assert.equal(receivedOptions.allowModelDownloads, false)
})

test('rejects malformed requests and still returns an error shape', async () => {
    const handleLine = createRetriever({retrieve: fakeRetrieve([])})

    for (const [overrides, expected] of [
        [{question: ''}, 'non-empty question'],
        [{question: '   '}, 'non-empty question'],
        [{question: undefined}, 'non-empty question'],
        [{cacheDir: ''}, 'cacheDir'],
        [{cacheDir: undefined}, 'cacheDir'],
        [{maxPassages: 0}, 'maxPassages'],
        [{maxPassages: 'many'}, 'maxPassages'],
        [{maxTextChars: -1}, 'maxTextChars'],
        [{maxTextChars: 'long'}, 'maxTextChars']
    ]) {
        const response = await handleLine(request(overrides))
        assert.equal('error' in response, true, `${expected} must produce an error`)
        assert.match(response.error, new RegExp(expected, 'u'))
    }
})

test('an unparseable line reports an error', async () => {
    const handleLine = createRetriever({retrieve: fakeRetrieve([])})

    const response = await handleLine('{not json')

    assert.equal('error' in response, true)
    assert.ok(response.error.length > 0)
})

test('a retrieve failure is reported without throwing', async () => {
    const handleLine = createRetriever({
        retrieve: async () => {
            throw new Error('embedder is unavailable')
        }
    })

    const response = await handleLine(request())

    assert.deepEqual(response, {error: 'embedder is unavailable'})
})

test('runRetrieve drives input and output and reports input failures', async () => {
    const output = []
    const failures = []

    await runRetrieve({
        retrieve: fakeRetrieve([{text: 'result', chapter: 'Input', order: 2, score: 0.95}]),
        input: async () => request(),
        output: message => output.push(message),
        fail: message => failures.push(message)
    })

    assert.deepEqual(failures, [])
    assert.equal(output.length, 1)
    assert.ok(output[0].startsWith(RESPONSE_PREFIX))
    const parsed = JSON.parse(output[0].slice(RESPONSE_PREFIX.length))
    assert.deepEqual(parsed.passages, [{text: 'result', chapter: 'Input', order: 2, score: 0.95}])

    await runRetrieve({
        retrieve: fakeRetrieve([]),
        input: async () => {
            throw new Error('stdin closed')
        },
        output: message => output.push(message),
        fail: message => failures.push(message)
    })

    assert.deepEqual(failures, ['stdin closed'])
})
