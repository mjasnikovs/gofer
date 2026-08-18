export const RESPONSE_PREFIX = 'GOFER_MEMORY_RESPONSE:'
export const MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'
export const QUERY_PREFIX =
    'Instruct: Given a question about a software project, retrieve memories that help answer it\nQuery:'

const MODES = new Set(['query', 'documents'])

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

/**
 * Builds the line handler used by the memory worker.
 *
 * `loadPipeline` is injected so tests never download or run the real ONNX model. The extractor is
 * created once and reused, because loading it costs far more than an embedding call.
 */
export function createEmbedder({loadPipeline}) {
    let extractor

    return async function handleLine(line) {
        // The id is read before any validation so a failure can always be correlated to its
        // request; an unparseable line is the only case that answers without one.
        let id
        try {
            const parsed = JSON.parse(line)
            id = parsed?.id
            const request = requireRequest(parsed)
            extractor ??= await loadPipeline(MODEL, {
                dtype: 'fp16',
                device: 'cpu',
                cache_dir: request.cacheDir
            })
            const texts =
                request.mode === 'query' ?
                    request.texts.map(text => `${QUERY_PREFIX}${text}`)
                :   request.texts
            const output = await extractor(texts, {pooling: 'mean', normalize: true})
            return {id, vectors: output.tolist()}
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {...(id !== undefined && {id}), error: message}
        }
    }
}
