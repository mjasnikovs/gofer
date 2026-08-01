import {runAgent} from './ai-provider.mjs'

export const EVENT_PREFIX = 'GOFER_AI_EVENT:'

function emit(event) {
    process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(event)}\n`)
}

try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    await runAgent({...request, emit})
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
}
