import {createInterface} from 'node:readline'
import {EVENT_PREFIX, TOOL_PREFIX, createToolHost} from './ai-host.mjs'
import {runAgent} from './ai-provider.mjs'

export {EVENT_PREFIX}

function write(prefix, message) {
    process.stdout.write(`${prefix}${JSON.stringify(message)}\n`)
}

try {
    // Duplex NDJSON: the first line is the startup context, every later line answers a tool
    // request. Reading to EOF the way the one-shot protocol did would deadlock — Rust keeps the
    // channel open for the whole turn precisely so the tools can be answered.
    const lines = createInterface({input: process.stdin})[Symbol.asyncIterator]()
    const first = await lines.next()
    if (first.done) throw new Error('The AI worker received no startup context')
    const request = JSON.parse(first.value)
    const host = createToolHost(call => write(TOOL_PREFIX, call))
    // Deliberately not awaited: the reader ends only when the backend closes the channel, which
    // happens after the turn it is feeding. Awaiting it would outlive the agent and hang the exit.
    void (async () => {
        for await (const line of lines) {
            if (line.trim() === '') continue
            host.deliver(JSON.parse(line))
        }
        host.close('The Gofer backend closed the tool channel')
    })().catch(error => {
        host.close(`The tool channel failed: ${error.message}`)
    })

    try {
        await runAgent({...request, host, emit: event => write(EVENT_PREFIX, event)})
    } finally {
        host.close('The agent turn ended')
        process.stdin.destroy()
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
}
