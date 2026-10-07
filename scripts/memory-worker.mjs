import readline from 'node:readline'
import {
    AutoConfig,
    AutoModel,
    AutoTokenizer,
    env,
    LogLevel,
    Tensor
} from '@huggingface/transformers'
import {createEmbedder, embedText, loadGemma, RESPONSE_PREFIX} from './memory-embedder.mjs'

const handleLine = createEmbedder({
    loadModel: cacheDir =>
        loadGemma({AutoConfig, AutoModel, AutoTokenizer, env, LogLevel}, cacheDir),
    embed: (loaded, text) => embedText({...loaded, Tensor}, text)
})

const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity})
for await (const line of lines) {
    const response = await handleLine(line)
    process.stdout.write(`${RESPONSE_PREFIX}${JSON.stringify(response)}\n`)
}
