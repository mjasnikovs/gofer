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
    // `pinned` says whether gofer-rag rescued this passage rather than ranking it, and rides along
    // so the question of how often a rescue was the answer is a query rather than a guess.
    assert.deepEqual(response.passages, [
        {text: 'a'.repeat(10), chapter: 'Tween', order: 3, score: 0.9, pinned: false},
        {text: 'b', chapter: 'Animation', order: 7, score: 0.8, pinned: false}
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

    await handleLine(request({maxPassages: 4}))

    assert.equal(receivedOptions.cacheDir, '/cache')
    assert.equal(receivedOptions.allowModelDownloads, false)
    // The ceiling is asked for rather than sliced off afterwards. A title pin always sorts last, so
    // `slice(0, n)` would take the rescues first; given the number, gofer-rag applies it before
    // pinning and keeps room for one. The option exists from 0.2.0, and 0.1.3 throws on it — the
    // package bump and this line are the same change.
    assert.equal(receivedOptions.maxPassages, 4)
})

test('a rescued passage is reported as one', async () => {
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([
            {text: 'ranked', chapter: 'Tween', order: 1, score: 1.2},
            {text: 'rescued', chapter: 'BoxMesh', order: 4, score: -2.1, pinned: true}
        ])
    })

    const response = await handleLine(request())

    assert.deepEqual(
        response.passages.map(passage => passage.pinned),
        [false, true]
    )
})

/*
 * `godot_docs_search ask` answered `docs_unavailable: 400: {"message":"Reasoning is mandatory for
 * this endpoint and cannot be disabled."...}` in three recorded live runs, and in each of them the
 * agent never tried `ask` again for the rest of the turn. The retrieval had already happened, so
 * what was thrown away was the whole cost of the call.
 */
test('a reader that cannot be reached answers with the passages instead of the refusal', async () => {
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([
            {text: 'Tweens interpolate', chapter: 'Tween', order: 1, score: 0.9}
        ]),
        askDocs: async () => {
            throw new Error(
                '400: {"message":"Reasoning is mandatory for this endpoint and cannot be disabled.",'
                    + '"code":400,"metadata":{"provider_name":null}}'
            )
        }
    })

    const response = await handleLine(request({mode: 'ask'}))

    assert.equal(response.error, undefined, 'the call must not fail outright')
    assert.equal(response.passages.length, 1, 'the passages already retrieved are answered with')
    assert.equal(response.passages[0].chapter, 'Tween')
    // The provider's JSON body becomes a sentence, the way a turn's own failure already does.
    assert.match(response.text, /search operation would have returned/u)
    assert.match(response.text, /Reasoning is mandatory/u)
    assert.ok(!response.text.includes('{'), `no JSON reaches the model: ${response.text}`)
    // And the reason rides in its own field, which is what stops the answer being cached.
    assert.match(response.readerUnavailable, /provider refused this request \(400\)/u)
})

/*
 * The single most common failure in the recorded runs: seven of the nine that reached
 * `godot_docs_search` were told `Reasoning is mandatory for this endpoint and cannot be disabled`,
 * because the sub-agent's stored model says `thinkingLevel: "off"` and carries no
 * `reasoningMandatory` to escape it. The provider states the fact; the fix is to believe it.
 */
test('a model that says it cannot stop thinking is asked again without asking it to', async () => {
    const built = []
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([
            {text: 'Tweens interpolate', chapter: 'Tween', order: 1, score: 0.9}
        ]),
        createCompletion: connection => {
            built.push(connection.reasoningMandatory === true)
            return async () => 'unused'
        },
        askDocs: async ({complete}) => {
            await complete({})
            if (built.length === 1) {
                throw new Error(
                    '400: {"message":"Reasoning is mandatory for this endpoint and cannot be'
                        + ' disabled.","code":400}'
                )
            }
            return {text: 'A tween interpolates a property.', excerptVerified: true}
        }
    })

    const response = await handleLine(
        request({mode: 'ask', connection: {baseUrl: 'http://127.0.0.1:8080/v1', model: 'm'}})
    )

    assert.deepEqual(built, [false, true], 'the second attempt insists the model reasons')
    assert.equal(response.text, 'A tween interpolates a property.')
    assert.equal(response.readerUnavailable, undefined, 'nothing was lost, so nothing is reported')
})

/* And a refusal that means something else is not retried — one wasted request, not two. */
/* A fault of ours is not a reader that could not be reached, and must still fail the call. */
test('a defect in the reader is not answered with passages', async () => {
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([
            {text: 'Tweens interpolate', chapter: 'Tween', order: 1, score: 0.9}
        ]),
        createCompletion: () => async () => 'unused',
        askDocs: async () => {
            throw new TypeError('passages.map is not a function')
        }
    })

    const response = await handleLine(
        request({mode: 'ask', connection: {baseUrl: 'http://127.0.0.1:8080/v1', model: 'm'}})
    )

    assert.match(response.error, /passages\.map is not a function/u)
    assert.equal(response.passages, undefined, 'a defect is a failure, not a poorer answer')
})

test('a refusal that is not about reasoning is answered with the passages at once', async () => {
    let attempts = 0
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([
            {text: 'Tweens interpolate', chapter: 'Tween', order: 1, score: 0.9}
        ]),
        createCompletion: () => async () => 'unused',
        askDocs: async () => {
            attempts += 1
            throw new Error('503: {"message":"upstream is down","code":503}')
        }
    })

    const response = await handleLine(
        request({mode: 'ask', connection: {baseUrl: 'http://127.0.0.1:8080/v1', model: 'm'}})
    )

    assert.equal(attempts, 1, 'a refusal with no fix in it is not tried again')
    assert.equal(response.passages.length, 1)
    assert.match(response.readerUnavailable, /upstream is down/u)
})

/* A reader that answers is untouched: nothing about this path runs when the model is reachable. */
test('a reader that answers is left exactly as it was', async () => {
    const handleLine = createRetriever({
        retrieve: fakeRetrieve([
            {text: 'Tweens interpolate', chapter: 'Tween', order: 1, score: 0.9}
        ]),
        askDocs: async () => ({text: 'A tween interpolates a property.', excerptVerified: true})
    })

    const response = await handleLine(request({mode: 'ask'}))

    assert.equal(response.text, 'A tween interpolates a property.')
    assert.equal(response.readerUnavailable, undefined)
    assert.equal(response.passages, undefined, 'ask answers with prose, not with the chapters')
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
    assert.deepEqual(parsed.passages, [
        {text: 'result', chapter: 'Input', order: 2, score: 0.95, pinned: false}
    ])

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
