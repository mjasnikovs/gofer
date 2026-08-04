export const RESPONSE_PREFIX = 'GOFER_RAG_RESULT:'

export function validateRequest(request) {
    if (!request || typeof request !== 'object') throw new Error('The request must be an object')
    if (typeof request.question !== 'string' || request.question.trim() === '') {
        throw new Error('The request must carry a non-empty question string')
    }
    if (typeof request.cacheDir !== 'string' || request.cacheDir === '') {
        throw new Error('The request must carry a cacheDir')
    }
    if (
        request.maxPassages !== undefined
        && (!Number.isInteger(request.maxPassages) || request.maxPassages < 1)
    ) {
        throw new Error('maxPassages must be a positive integer')
    }
    if (
        request.maxTextChars !== undefined
        && (!Number.isInteger(request.maxTextChars) || request.maxTextChars < 1)
    ) {
        throw new Error('maxTextChars must be a positive integer')
    }
    return {
        question: request.question.trim(),
        cacheDir: request.cacheDir,
        maxPassages: request.maxPassages ?? 10,
        maxTextChars: request.maxTextChars ?? 2000
    }
}

/**
 * Builds the line handler used by the RAG retrieve worker.
 *
 * `retrieve` is injected so tests exercise the response formatting and vector stripping
 * without downloading or running the real ONNX models.
 */
export function createRetriever({retrieve}) {
    return async function handleLine(line) {
        try {
            const request = validateRequest(JSON.parse(line))
            const chunks = await retrieve(request.question, {
                cacheDir: request.cacheDir,
                allowModelDownloads: false
            })
            const passages = (chunks ?? []).slice(0, request.maxPassages).map(chunk => ({
                text: String(chunk.text ?? '').slice(0, request.maxTextChars),
                chapter: String(chunk.chapter ?? ''),
                order: Number(chunk.order ?? 0),
                score: Number(chunk.score ?? 0)
            }))
            return {passages}
        } catch (error) {
            return {error: error instanceof Error ? error.message : String(error)}
        }
    }
}

/**
 * Runs one retrieve request read from `input` and writes the response to `output`.
 *
 * `retrieve` is injected for testing.
 */
export async function runRetrieve({retrieve, input, output, fail}) {
    const handleLine = createRetriever({retrieve})
    let line
    try {
        line = await input()
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
        return
    }
    const response = await handleLine(line)
    output(`${RESPONSE_PREFIX}${JSON.stringify(response)}\n`)
}
