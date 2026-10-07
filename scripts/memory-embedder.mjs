import {statSync} from 'node:fs'
import {join} from 'node:path'

export const RESPONSE_PREFIX = 'GOFER_MEMORY_RESPONSE:'
export const MODEL = 'onnx-community/embeddinggemma-2-ONNX'
export const DTYPE = 'q8'
export const QUERY_PREFIX = 'task: search result | query: '
export const DOCUMENT_PREFIX = 'title: none | text: '
// The files gofer-rag downloads for this dtype, mirrored by `required_model_files` in rag.rs.
export const REQUIRED_FILES = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model_quantized.onnx',
    'onnx/model_quantized.onnx_data'
]
// The model's context. Its tokenizer config gives no usable limit of its own.
const MAX_TOKENS = 8192

// Gemma's tokenizer reads these as control tokens even inside plain text, and "<|image|>" makes the
// forward pass throw. gofer-rag's prompts.ts holds the same list and does not export it.
const SPECIAL_TOKENS = [
    '<pad>',
    '<eos>',
    '<bos>',
    '<unk>',
    '<mask>',
    '<|tool>',
    '<tool|>',
    '<|tool_call>',
    '<tool_call|>',
    '<|tool_response>',
    '<tool_response|>',
    '<|"|>',
    '<|think|>',
    '<|channel>',
    '<channel|>',
    '<|turn>',
    '<turn|>',
    '<|image>',
    '<|audio>',
    '<|image|>',
    '<|audio|>',
    '<image|>',
    '<audio|>',
    '<|video|>'
]
const SPECIAL_TOKEN = new RegExp(
    SPECIAL_TOKENS.map(token => token.replace(/[|]/g, '\\|')).join('|'),
    'g'
)

const MODES = new Set(['query', 'documents'])

// Until nothing changes: one pass over "<|ima<pad>ge|>" would put "<|image|>" back together.
export function cleanText(text) {
    let cleaned = text.replace(SPECIAL_TOKEN, '')
    while (cleaned !== text) {
        text = cleaned
        cleaned = text.replace(SPECIAL_TOKEN, '')
    }
    return cleaned
}

export function promptText(mode, text) {
    return `${mode === 'query' ? QUERY_PREFIX : DOCUMENT_PREFIX}${cleanText(text)}`
}

function requireRequest(request) {
    if (!request || typeof request !== 'object') throw new Error('The request must be an object')
    if (!MODES.has(request.mode)) throw new Error(`Unsupported embedding mode '${request.mode}'`)
    if (!Array.isArray(request.texts) || request.texts.length === 0) {
        throw new Error('The request must carry a non-empty texts array')
    }
    if (request.texts.some(text => typeof text !== 'string')) {
        throw new Error('Every request text must be a string')
    }
    if (typeof request.cacheDir !== 'string' || request.cacheDir === '') {
        throw new Error('The request must carry a cacheDir')
    }
    return request
}

// Empty counts as missing, as in gofer-rag: an interrupted download leaves one behind.
export function missingModelFiles(cacheDir) {
    return REQUIRED_FILES.filter(
        file => !(statSync(join(cacheDir, MODEL, file), {throwIfNoEntry: false})?.size > 0)
    )
}

// Never the feature-extraction pipeline: it pools the hidden state itself and skips the model's
// 512→768 projection. Remote loading is off so memory never downloads what the user did not
// approve in the documentation warmup, and so a full cache works offline.
export async function loadGemma({AutoConfig, AutoModel, AutoTokenizer, LogLevel, env}, cacheDir) {
    const missing = missingModelFiles(cacheDir)
    if (missing.length > 0) {
        throw new Error(
            `${MODEL} is not downloaded yet: ${missing.join(', ')} missing from ${cacheDir}`
        )
    }
    // ERROR: transformers.js warns on every load that it does not know embedding_gemma2, and its
    // fallback is the right graph.
    Object.assign(env, {
        allowRemoteModels: false,
        allowLocalModels: true,
        localModelPath: cacheDir,
        logLevel: LogLevel.ERROR
    })
    const options = {cache_dir: cacheDir}
    const config = await AutoConfig.from_pretrained(MODEL, options)
    Object.assign(config, {vision_config: null, audio_config: null})
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL, options)
    const model = await AutoModel.from_pretrained(MODEL, {
        ...options,
        config,
        dtype: DTYPE,
        device: 'cpu'
    })
    return {tokenizer, model}
}

export async function embedText({tokenizer, model, Tensor}, text) {
    const encoded = tokenizer([text], {truncation: true, max_length: MAX_TOKENS})
    // Truncation runs after <eos> is added, so a long text would lose the <eos> the model pools on.
    const ids = encoded.input_ids.data
    const eos = BigInt(tokenizer.eos_token_id)
    if (ids[ids.length - 1] !== eos) ids[ids.length - 1] = eos
    const noMedia = () => new Tensor('float32', new Float32Array(0), [0, 512])
    const output = await model({
        ...encoded,
        image_features: noMedia(),
        video_features: noMedia(),
        audio_features: noMedia()
    })
    return normalize(Array.from(output.sentence_embedding.data))
}

function normalize(vector) {
    const magnitude = Math.hypot(...vector)
    if (!Number.isFinite(magnitude) || magnitude === 0)
        throw new Error('The memory embedder returned an empty vector')
    return vector.map(value => value / magnitude)
}

export function createEmbedder({loadModel, embed}) {
    let loaded

    return async function handleLine(line) {
        let id
        try {
            const parsed = JSON.parse(line)
            id = parsed?.id
            const request = requireRequest(parsed)
            loaded ??= await loadModel(request.cacheDir)
            const vectors = []
            for (const text of request.texts)
                vectors.push(await embed(loaded, promptText(request.mode, text)))
            return {id, vectors}
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {...(id !== undefined && {id}), error: message}
        }
    }
}
