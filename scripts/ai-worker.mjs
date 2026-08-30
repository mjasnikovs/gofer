import {createInterface} from 'node:readline'
import {registerBunOAuthFlows} from '@earendil-works/pi-ai/bun-oauth'
import {cleanupSessionResources} from '@earendil-works/pi-ai/compat'
import {
    CREDENTIAL_PREFIX,
    EVENT_PREFIX,
    TOOL_PREFIX,
    createCancellation,
    createSteering,
    createToolHost
} from './ai-host.mjs'
import {runAgent} from './ai-provider.mjs'

export {EVENT_PREFIX}

registerBunOAuthFlows()

function write(prefix, message) {
    process.stdout.write(`${prefix}${JSON.stringify(message)}\n`)
}

async function runRequest(request, {host, credentialHost, emit, signal, steering}) {
    const mode = request.mode ?? 'turn'
    if (mode === 'turn') {
        await runAgent({...request, host, credentialHost, emit, signal, steering})
        return
    }
    if (mode === 'brief') {
        const {runBrief} = await import('./brief/run.mjs')
        await runBrief({...request, host, credentialHost, emit, signal})
        return
    }
    if (mode === 'judge') {
        const {runMemoryJudge} = await import('./memory-judge.mjs')
        await runMemoryJudge({...request, host, credentialHost, emit, signal})
        return
    }
    throw new Error(
        `The AI worker was asked for '${mode}', which it does not know how to run. `
            + 'If the backend was just updated, the bundled workers are stale: run '
            + '`npm run build:workers`.'
    )
}

function releaseProviderConnections() {
    try {
        cleanupSessionResources()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`Could not release the provider connections: ${message}\n`)
    }
}

try {
    const lines = createInterface({input: process.stdin})[Symbol.asyncIterator]()
    const first = await lines.next()
    if (first.done) throw new Error('The AI worker received no startup context')
    const request = JSON.parse(first.value)
    const host = createToolHost(call => write(TOOL_PREFIX, call))
    const credentialHost = createToolHost(call => write(CREDENTIAL_PREFIX, call), 'credential')
    const cancellation = createCancellation()
    const steering = createSteering()
    void (async () => {
        for await (const line of lines) {
            if (line.trim() === '') continue
            const response = JSON.parse(line)
            if (cancellation.deliver(response)) continue
            if (steering.deliver(response)) continue
            host.deliver(response)
            credentialHost.deliver(response)
        }
        host.close('The Gofer backend closed the tool channel')
        credentialHost.close('The Gofer backend closed the tool channel')
    })().catch(error => {
        host.close(`The tool channel failed: ${error.message}`)
        credentialHost.close(`The tool channel failed: ${error.message}`)
    })

    try {
        await runRequest(request, {
            host,
            credentialHost,
            emit: event => write(EVENT_PREFIX, event),
            signal: cancellation.signal,
            steering
        })
    } finally {
        host.close('The agent turn ended')
        credentialHost.close('The agent turn ended')
        releaseProviderConnections()
        process.stdin.destroy()
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
}
