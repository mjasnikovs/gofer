import readline from 'node:readline'
import {pipeline} from '@huggingface/transformers'

const PREFIX = 'GOFER_MEMORY_RESPONSE:'
const MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX'
const QUERY_PREFIX =
    'Instruct: Given a question about a software project, retrieve memories that help answer it\nQuery:'
let extractor

async function embed(request) {
    extractor ??= await pipeline('feature-extraction', MODEL, {
        dtype: 'fp16',
        device: 'cpu',
        cache_dir: request.cacheDir
    })
    const texts =
        request.mode === 'query' ?
            request.texts.map(text => `${QUERY_PREFIX}${text}`)
        :   request.texts
    const output = await extractor(texts, {pooling: 'mean', normalize: true})
    return output.tolist()
}

const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity})
for await (const line of lines) {
    try {
        const request = JSON.parse(line)
        const vectors = await embed(request)
        process.stdout.write(`${PREFIX}${JSON.stringify({id: request.id, vectors})}\n`)
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stdout.write(`${PREFIX}${JSON.stringify({error: message})}\n`)
    }
}
