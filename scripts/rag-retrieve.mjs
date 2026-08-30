import {readFileSync} from 'node:fs'
import {createCompletion as defaultCreateCompletion} from './rag-expand.mjs'
import {readableProviderError} from './provider-error.mjs'
import {askDocs as defaultAskDocs} from './rag-ask.mjs'

export const RESPONSE_PREFIX = 'GOFER_RAG_RESULT:'

export const refuseCompletion = async () => {
    throw new Error('No model connection was supplied to the documentation search')
}

export const PROBE_ANSWER = 'docs-ask-reachable'

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
        ...(request.connection === undefined ? {} : {connection: request.connection})
    }
}

export function createRetriever({
    retrieve,
    persistCredential,
    createCompletion = defaultCreateCompletion,
    askDocs = defaultAskDocs
}) {
    return async function handleLine(line) {
        try {
            const request = validateRequest(JSON.parse(line))
            const complete =
                createCompletion(request.connection, {persistCredential}) ?? refuseCompletion
            const chunks = await retrieve(request.question, {
                cacheDir: request.cacheDir,
                allowModelDownloads: false,
                maxPassages: request.maxPassages,
                complete
            })
            const passages = (chunks ?? []).slice(0, request.maxPassages).map(chunk => ({
                text: String(chunk.text ?? '').slice(0, request.maxTextChars),
                chapter: String(chunk.chapter ?? ''),
                order: Number(chunk.order ?? 0),
                score: Number(chunk.score ?? 0),
                pinned: chunk.pinned === true
            }))
            const corpus = corpusVersion()
            if (request.mode === 'search') return {passages, corpusVersion: corpus}
            const read = async reader => ({
                ...(await askDocs({question: request.question, passages, complete: reader})),
                corpusVersion: corpus
            })
            try {
                return await read(complete)
            } catch (error) {
                if (!saysReasoningIsMandatory(error)) {
                    return {...whenTheReaderCannotBeReached(error, passages), corpusVersion: corpus}
                }
                const insisting =
                    createCompletion(
                        {...request.connection, reasoningMandatory: true},
                        {persistCredential}
                    ) ?? refuseCompletion
                try {
                    return await read(insisting)
                } catch (again) {
                    return {...whenTheReaderCannotBeReached(again, passages), corpusVersion: corpus}
                }
            }
        } catch (error) {
            return {error: error instanceof Error ? error.message : String(error)}
        }
    }
}

export function saysReasoningIsMandatory(error) {
    const message = error instanceof Error ? error.message : String(error ?? '')
    return /reasoning is mandatory/iu.test(message)
}

export function whenTheReaderCannotBeReached(error, passages) {
    if (error instanceof TypeError || error instanceof ReferenceError) throw error
    if (error?.name === 'AbortError') throw error
    const because = readableProviderError(error instanceof Error ? error.message : String(error))
    return {
        passages,
        text:
            `The documentation could not be read into an answer, so these are the passages the `
            + `search operation would have returned. ${because}`,
        readerUnavailable: because
    }
}

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

export async function probeRetriever({output = message => process.stdout.write(message)} = {}) {
    const response = await defaultAskDocs({
        question: 'Is the documentation reader reachable?',
        passages: [{text: PROBE_ANSWER, chapter: 'Probe', score: 1}],
        complete: async () => `<answer>${PROBE_ANSWER}</answer><excerpt>${PROBE_ANSWER}</excerpt>`
    })
    const answer = {...response, corpusVersion: corpusVersion()}
    output(`${RESPONSE_PREFIX}${JSON.stringify(answer)}\n`)
    return answer
}
