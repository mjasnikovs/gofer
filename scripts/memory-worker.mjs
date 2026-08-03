import readline from 'node:readline'
import {pipeline} from '@huggingface/transformers'
import {createEmbedder, RESPONSE_PREFIX} from './memory-embedder.mjs'

const handleLine = createEmbedder({
    loadPipeline: (model, options) => pipeline('feature-extraction', model, options)
})

const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity})
for await (const line of lines) {
    const response = await handleLine(line)
    process.stdout.write(`${RESPONSE_PREFIX}${JSON.stringify(response)}\n`)
}
