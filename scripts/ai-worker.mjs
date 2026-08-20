import {createInterface} from 'node:readline'
import {registerBunOAuthFlows} from '@earendil-works/pi-ai/bun-oauth'
import {cleanupSessionResources} from '@earendil-works/pi-ai/compat'
import {CREDENTIAL_PREFIX, EVENT_PREFIX, TOOL_PREFIX, createToolHost} from './ai-host.mjs'
import {runAgent} from './ai-provider.mjs'

export {EVENT_PREFIX}

// Pi loads each OAuth flow through a variable import specifier, on purpose: it keeps bundlers from
// following the import into Node-only flow code. The cost is that a bundle has no such file to
// import at runtime — `scripts/build-workers.mjs` produces one file, and deriving the ChatGPT auth
// asked it for `./openai-codex.js` next to itself. This is Pi's own answer: the flows are imported
// statically here and registered, so the dynamic import is never reached. Called in the source
// worker too, so there is one code path rather than two.
registerBunOAuthFlows()

function write(prefix, message) {
    process.stdout.write(`${prefix}${JSON.stringify(message)}\n`)
}

/**
 * Closes what the provider kept for later.
 *
 * A remote turn does not leave empty-handed: the ChatGPT path parks the Codex WebSocket it just
 * used in a per-session cache, to be reused for five minutes. An open socket keeps Node alive, and
 * the backend reads this process's stdout until it closes — so a worker that will not exit is a
 * turn that never ends. The answer is on screen, the model is finished, nothing is running, and
 * the composer still says Gofer is working until the user presses Stop.
 *
 * Everything, not this session's share of it: the process is one turn, and it is over.
 *
 * Reported rather than raised, because this runs on the way out of a turn that has already ended.
 * A socket that would not close must not turn a finished answer into a failed one.
 */
/**
 * Which job this process was started to do.
 *
 * Absent means a chat turn, so every request written before this existed still means what it always
 * meant. An unknown value throws rather than falling back, and that is the important half: the
 * application runs the BUNDLED copy of this file, not the one in `scripts/`, so a backend asking for
 * work a stale bundle has never heard of would otherwise quietly run an ordinary empty turn and leave
 * nothing anywhere pointing at why.
 */
async function runRequest(request, {host, credentialHost, emit}) {
    const mode = request.mode ?? 'turn'
    if (mode === 'turn') {
        await runAgent({...request, host, credentialHost, emit})
        return
    }
    if (mode === 'brief') {
        const {runBrief} = await import('./brief/run.mjs')
        await runBrief({...request, host, credentialHost, emit})
        return
    }
    if (mode === 'judge') {
        const {runMemoryJudge} = await import('./memory-judge.mjs')
        await runMemoryJudge({...request, host, credentialHost, emit})
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
    // Duplex NDJSON: the first line is the startup context, every later line answers a tool
    // request. Reading to EOF the way the one-shot protocol did would deadlock — Rust keeps the
    // channel open for the whole turn precisely so the tools can be answered.
    const lines = createInterface({input: process.stdin})[Symbol.asyncIterator]()
    const first = await lines.next()
    if (first.done) throw new Error('The AI worker received no startup context')
    const request = JSON.parse(first.value)
    const host = createToolHost(call => write(TOOL_PREFIX, call))
    const credentialHost = createToolHost(call => write(CREDENTIAL_PREFIX, call), 'credential')
    // Deliberately not awaited: the reader ends only when the backend closes the channel, which
    // happens after the turn it is feeding. Awaiting it would outlive the agent and hang the exit.
    void (async () => {
        for await (const line of lines) {
            if (line.trim() === '') continue
            const response = JSON.parse(line)
            host.deliver(response)
            credentialHost.deliver(response)
        }
        host.close('The Gofer backend closed the tool channel')
    })().catch(error => {
        host.close(`The tool channel failed: ${error.message}`)
    })

    try {
        await runRequest(request, {
            host,
            credentialHost,
            emit: event => write(EVENT_PREFIX, event)
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
