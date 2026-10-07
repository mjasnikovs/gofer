import assert from 'node:assert/strict'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test from 'node:test'
import {
    cleanText,
    createEmbedder,
    DOCUMENT_PREFIX,
    DTYPE,
    embedText,
    loadGemma,
    missingModelFiles,
    MODEL,
    QUERY_PREFIX,
    REQUIRED_FILES
} from './memory-embedder.mjs'

function fakeEmbedder({vector = [0.6, 0.8], onLoad, onEmbed} = {}) {
    return createEmbedder({
        loadModel: async cacheDir => {
            onLoad?.(cacheDir)
            return 'model'
        },
        embed: async (loaded, text) => {
            onEmbed?.(loaded, text)
            return vector
        }
    })
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

function populatedCache() {
    const cacheDir = mkdtempSync(join(tmpdir(), 'gofer-memory-cache-'))
    for (const file of REQUIRED_FILES) {
        const path = join(cacheDir, MODEL, file)
        mkdirSync(dirname(path), {recursive: true})
        writeFileSync(path, '{}')
    }
    return cacheDir
}

function fakeTransformers(loads) {
    const loader = kind => ({
        from_pretrained: async (model, options) => {
            loads.push({kind, model, options})
            return kind === 'config' ? {vision_config: {}, audio_config: {}} : kind
        }
    })
    return {
        AutoConfig: loader('config'),
        AutoTokenizer: loader('tokenizer'),
        AutoModel: loader('model'),
        LogLevel: {ERROR: 40},
        env: {allowRemoteModels: true}
    }
}

function fakeModel({ids, embedding = [3, 4]}) {
    const calls = []
    const tokenizer = (texts, options) => {
        calls.push({texts, options})
        return {input_ids: {data: BigInt64Array.from(ids, BigInt)}}
    }
    tokenizer.eos_token_id = 1
    const model = async inputs => {
        calls.push({inputs})
        return {sentence_embedding: {data: Float32Array.from(embedding)}}
    }
    class Tensor {
        constructor(type, data, dims) {
            Object.assign(this, {type, data, dims})
        }
    }
    return {calls, loaded: {tokenizer, model, Tensor}}
}

test('embeds every document text in order and echoes the request id', async () => {
    const texts = []
    const handleLine = fakeEmbedder({onEmbed: (_loaded, text) => texts.push(text)})

    const response = await handleLine(request({texts: ['one', 'two']}))

    assert.deepEqual(response, {
        id: 7,
        vectors: [
            [0.6, 0.8],
            [0.6, 0.8]
        ]
    })
    assert.deepEqual(texts, [`${DOCUMENT_PREFIX}one`, `${DOCUMENT_PREFIX}two`])
})

test('a query carries the query prefix and a document the document prefix', async () => {
    const texts = []
    const handleLine = fakeEmbedder({onEmbed: (_loaded, text) => texts.push(text)})

    await handleLine(request({mode: 'query', texts: ['where is the player?']}))
    await handleLine(request({mode: 'documents', texts: ['where is the player?']}))

    assert.deepEqual(texts, [
        `${QUERY_PREFIX}where is the player?`,
        `${DOCUMENT_PREFIX}where is the player?`
    ])
})

test('the model is loaded once from the request cache and reused', async () => {
    const loads = []
    const handleLine = fakeEmbedder({onLoad: cacheDir => loads.push(cacheDir)})

    await handleLine(request())
    await handleLine(request({id: 8}))

    assert.deepEqual(loads, ['/cache'])
})

test('a control token in the text is removed even when removing one makes another', () => {
    assert.equal(cleanText('see <|ima<pad>ge|> here<eos>'), 'see  here')
    assert.equal(cleanText('a <T> stays'), 'a <T> stays')
})

test('rejects every malformed request shape and still reports the request id', async () => {
    const handleLine = fakeEmbedder()

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
    const handleLine = fakeEmbedder()

    const response = await handleLine('{not json')

    assert.equal('id' in response, false)
    assert.ok(response.error.length > 0)
})

test('a failing load is reported and a later request still succeeds', async () => {
    let attempts = 0
    const handleLine = createEmbedder({
        loadModel: async () => {
            attempts += 1
            if (attempts === 1) throw new Error('model is unavailable')
            return 'model'
        },
        embed: async () => [0.25]
    })

    const failure = await handleLine(request())
    const recovery = await handleLine(request({id: 9}))

    assert.deepEqual(failure, {id: 7, error: 'model is unavailable'})
    assert.deepEqual(recovery, {id: 9, vectors: [[0.25]]})
})

test('a cache without the model is refused before anything can download it', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'gofer-memory-cache-'))
    const loads = []

    await assert.rejects(
        loadGemma(fakeTransformers(loads), cacheDir),
        /is not downloaded yet: config\.json/u
    )
    assert.deepEqual(missingModelFiles(cacheDir), REQUIRED_FILES)
    assert.deepEqual(loads, [])
})

test('an empty file left by an interrupted download counts as missing', () => {
    const cacheDir = populatedCache()
    writeFileSync(join(cacheDir, MODEL, 'onnx/model_quantized.onnx_data'), '')

    assert.deepEqual(missingModelFiles(cacheDir), ['onnx/model_quantized.onnx_data'])
})

test('a full cache loads text-only, quantized, and never from the network', async () => {
    const cacheDir = populatedCache()
    const loads = []
    const transformers = fakeTransformers(loads)

    const loaded = await loadGemma(transformers, cacheDir)

    assert.deepEqual(loaded, {tokenizer: 'tokenizer', model: 'model'})
    assert.equal(transformers.env.allowRemoteModels, false)
    assert.equal(transformers.env.localModelPath, cacheDir)
    assert.deepEqual(
        loads.map(load => [load.kind, load.model]),
        [
            ['config', MODEL],
            ['tokenizer', MODEL],
            ['model', MODEL]
        ]
    )
    const modelOptions = loads[2].options
    assert.equal(modelOptions.dtype, DTYPE)
    assert.deepEqual(modelOptions.config, {vision_config: null, audio_config: null})
})

test('the vector is the normalized sentence embedding with no media attached', async () => {
    const {calls, loaded} = fakeModel({ids: [2, 5, 1], embedding: [3, 4]})

    const vector = await embedText(loaded, 'text')

    assert.deepEqual(vector, [0.6, 0.8])
    const {inputs} = calls[1]
    for (const media of ['image_features', 'video_features', 'audio_features']) {
        assert.deepEqual(inputs[media].dims, [0, 512])
    }
})

test('a text cut at the token ceiling still ends on the end-of-sequence token', async () => {
    const {calls, loaded} = fakeModel({ids: [2, 5, 6]})

    await embedText(loaded, 'a very long prompt')

    assert.deepEqual(Array.from(calls[1].inputs.input_ids.data), [2n, 5n, 1n])
})

test('a vector of zeros is an error and not a memory nothing can find', async () => {
    const {loaded} = fakeModel({ids: [2, 1], embedding: [0, 0]})

    await assert.rejects(embedText(loaded, 'text'), /empty vector/u)
})
