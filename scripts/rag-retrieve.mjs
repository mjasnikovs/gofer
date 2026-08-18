import {readFileSync} from 'node:fs'
import {createCompletion as defaultCreateCompletion} from './rag-expand.mjs'
import {askDocs as defaultAskDocs} from './rag-ask.mjs'

export const RESPONSE_PREFIX = 'GOFER_RAG_RESULT:'

/**
 * What a documentation search reaches for when no model connection was supplied.
 *
 * Throwing is the point: gofer-rag catches it and retrieves unexpanded, exactly as it does for an
 * unreachable server, and no socket is opened to an address nobody configured.
 */
export const refuseCompletion = async () => {
    throw new Error('No model connection was supplied to the documentation search')
}

/** The word a probed documentation reader has to come back with. Shared with `rag.rs`. */
export const PROBE_ANSWER = 'docs-ask-reachable'

/**
 * Which manual answered, so a cached answer can be thrown away when the manual moves.
 *
 * The Godot documentation is frozen inside the gofer-rag package — the LanceDB table ships with it,
 * built from one release of the EPUB — so the package's version IS the corpus's version, and it is
 * the only thing that can invalidate an answer. Read through `import.meta.resolve` rather than a
 * require of the package.json, which its `exports` map refuses.
 *
 * Unknown rather than fatal when it cannot be read: a search still works, it simply is not cached.
 */
export function corpusVersion() {
    try {
        const entry = import.meta.resolve('@mjasnikovs/gofer-rag')
        const manifest = readFileSync(new URL('../package.json', entry), 'utf8')
        return JSON.parse(manifest).version ?? undefined
    } catch {
        return undefined
    }
}

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
    if (request.mode !== undefined && request.mode !== 'search' && request.mode !== 'ask') {
        throw new Error("mode must be 'search' or 'ask'")
    }
    if (
        request.connection !== undefined
        && (request.connection === null || typeof request.connection !== 'object')
    ) {
        throw new Error('connection must be an object when it is supplied')
    }
    return {
        question: request.question.trim(),
        cacheDir: request.cacheDir,
        maxPassages: request.maxPassages ?? 10,
        maxTextChars: request.maxTextChars ?? 2000,
        mode: request.mode ?? 'search',
        // Absent stays absent rather than becoming an undefined key: a machine with no local
        // connection searches unexpanded, which is what gofer-rag does on its own.
        ...(request.connection === undefined ? {} : {connection: request.connection})
    }
}

/**
 * Builds the line handler used by the RAG retrieve worker.
 *
 * `retrieve` is injected so tests exercise the response formatting and vector stripping
 * without downloading or running the real ONNX models.
 */
export function createRetriever({
    retrieve,
    persistCredential,
    createCompletion = defaultCreateCompletion,
    askDocs = defaultAskDocs
}) {
    return async function handleLine(line) {
        try {
            const request = validateRequest(JSON.parse(line))
            // The prompts and the term-list guard stay in gofer-rag; only the connection crosses.
            //
            // A refusal rather than nothing when there is no connection. Handed no `complete`, the
            // package falls back to opening its own socket to a hardcoded localhost address — which
            // is nobody's setting, and on a machine running something else on that port it posts a
            // Godot prompt to a stranger. Refusing degrades to unexpanded retrieval, which is what
            // an unreachable model was always supposed to mean.
            const complete =
                createCompletion(request.connection, {persistCredential}) ?? refuseCompletion
            const chunks = await retrieve(request.question, {
                cacheDir: request.cacheDir,
                allowModelDownloads: false,
                complete
            })
            const passages = (chunks ?? []).slice(0, request.maxPassages).map(chunk => ({
                text: String(chunk.text ?? '').slice(0, request.maxTextChars),
                chapter: String(chunk.chapter ?? ''),
                order: Number(chunk.order ?? 0),
                score: Number(chunk.score ?? 0)
            }))
            const corpus = corpusVersion()
            if (request.mode === 'search') return {passages, corpusVersion: corpus}
            // `ask` reads the very passages `search` would have returned, so the retrieval above is
            // shared rather than repeated: the two operations differ only in what comes back.
            return {
                ...(await askDocs({question: request.question, passages, complete})),
                corpusVersion: corpus
            }
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
export async function runRetrieve({
    retrieve,
    input,
    output,
    fail,
    createCompletion,
    persistCredential,
    askDocs
}) {
    const handleLine = createRetriever({
        retrieve,
        persistCredential,
        ...(createCompletion ? {createCompletion} : {}),
        ...(askDocs ? {askDocs} : {})
    })
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

/**
 * Proves the reading half assembles and answers, without a model and without the manual.
 *
 * `ask` grew a second dependency that `search` does not have: a reader, and a connection for it to
 * run on. A connection cannot be proven here — a real call would put a model request, and on a
 * ChatGPT sub-agent a paid one, in front of every turn the user takes — so this asks the narrower
 * question the page reader's probe asks: does the tool build, and does an answer come back out
 * through the same parsing, verification and formatting the real path uses.
 *
 * Everything below the canned reader is real. The passage goes through `buildContent`, the reply
 * through `parseChildOutput`, and the quote through the excerpt check — so a probe that answers has
 * proven the verification works, not merely that a function exists. A missing model is reported by
 * the call that needs it, in a sentence that points at `search`.
 */
export async function probeRetriever({output = message => process.stdout.write(message)} = {}) {
    const response = await defaultAskDocs({
        question: 'Is the documentation reader reachable?',
        passages: [{text: PROBE_ANSWER, chapter: 'Probe', score: 1}],
        complete: async () => `<answer>${PROBE_ANSWER}</answer><excerpt>${PROBE_ANSWER}</excerpt>`
    })
    // The probe is also where the corpus version is learned. It runs before every agent turn, so
    // the cache knows which manual it is holding answers from before it is asked for one — which
    // is what keeps a package upgrade from serving a single answer out of the old manual.
    const answer = {...response, corpusVersion: corpusVersion()}
    output(`${RESPONSE_PREFIX}${JSON.stringify(answer)}\n`)
    return answer
}
