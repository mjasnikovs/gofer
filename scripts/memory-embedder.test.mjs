import assert from 'node:assert/strict'
import test from 'node:test'
import {createEmbedder, MODEL, QUERY_PREFIX} from './memory-embedder.mjs'

function fakePipeline({vectors = [[0.5, 0.5]], onLoad, onCall} = {}) {
    return async (model, options) => {
        onLoad?.(model, options)
        return async (texts, callOptions) => {
            onCall?.(texts, callOptions)
            return {tolist: () => vectors}
        }
    }
}

function request(overrides = {}) {
    return JSON.stringify({
        id: 7,
        mode: 'documents',
        texts: ['the player scene'],
        cacheDir: '/cache',
        ...overrides
    })
}

test('embeds documents and echoes the request id', async () => {
    const calls = []
    const handleLine = createEmbedder({
        loadPipeline: fakePipeline({vectors: [[1, 0]], onCall: texts => calls.push(texts)})
    })

    const response = await handleLine(request())

    assert.deepEqual(response, {id: 7, vectors: [[1, 0]]})
    assert.deepEqual(calls, [['the player scene']])
})

test('prefixes query texts with the retrieval instruction and documents without it', async () => {
    const calls = []
    const handleLine = createEmbedder({
        loadPipeline: fakePipeline({onCall: texts => calls.push(texts)})
    })

    await handleLine(request({mode: 'query', texts: ['where is the player?']}))
    await handleLine(request({mode: 'documents', texts: ['where is the player?']}))

    assert.equal(calls[0][0], `${QUERY_PREFIX}where is the player?`)
    assert.equal(calls[1][0], 'where is the player?')
})

test('loads the pinned model once and reuses it with mean pooling and normalization', async () => {
    const loads = []
    const options = []
    const handleLine = createEmbedder({
        loadPipeline: fakePipeline({
            onLoad: (model, loadOptions) => loads.push({model, loadOptions}),
            onCall: (_texts, callOptions) => options.push(callOptions)
        })
    })

    await handleLine(request())
    await handleLine(request({id: 8}))

    assert.equal(loads.length, 1)
    assert.equal(loads[0].model, MODEL)
    assert.equal(loads[0].loadOptions.dtype, 'fp16')
    assert.equal(loads[0].loadOptions.cache_dir, '/cache')
    assert.deepEqual(options[0], {pooling: 'mean', normalize: true})
})

test('rejects every malformed request shape and still reports the request id', async () => {
    const handleLine = createEmbedder({loadPipeline: fakePipeline()})

    for (const [overrides, expected] of [
        [{mode: 'rerank'}, 'Unsupported embedding mode'],
        [{texts: []}, 'non-empty texts array'],
        [{texts: 'text'}, 'non-empty texts array'],
        [{texts: [1]}, 'must be a string'],
        [{cacheDir: ''}, 'must carry a cacheDir']
    ]) {
        const response = await handleLine(request(overrides))
        assert.equal(response.id, 7, `${expected} must stay correlated to its request`)
        assert.match(response.error, new RegExp(expected, 'u'))
        assert.equal(response.vectors, undefined)
    }
})

test('an unparseable line reports an error without an id', async () => {
    const handleLine = createEmbedder({loadPipeline: fakePipeline()})

    const response = await handleLine('{not json')

    assert.equal('id' in response, false)
    assert.ok(response.error.length > 0)
})

test('a failing extractor is reported and a later request still succeeds', async () => {
    let attempts = 0
    const handleLine = createEmbedder({
        loadPipeline: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('model is unavailable')
            return async () => ({tolist: () => [[0.25]]})
        }
    })

    const failure = await handleLine(request())
    const recovery = await handleLine(request({id: 9}))

    assert.deepEqual(failure, {id: 7, error: 'model is unavailable'})
    assert.deepEqual(recovery, {id: 9, vectors: [[0.25]]})
})
