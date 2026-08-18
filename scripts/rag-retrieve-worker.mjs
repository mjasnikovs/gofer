/**
 * The documentation retrieval sidecar: one request in, one answer out.
 *
 * It also holds a second, upward channel. gofer-rag's own model call may run on the ChatGPT
 * subscription, whose OAuth token rotates when it is used — so a refresh has to reach Gofer's
 * keyring rather than dying with this process. That is the same `GOFER_AI_CREDENTIAL:` request and
 * `tool-result` reply the agent worker already speaks, so it is the same host here.
 *
 * Which is why the request is the FIRST line rather than every line: stdin stays open for the
 * replies, so a loop that treated each line as a new question would never finish and would answer
 * a credential acknowledgement as though it were a search.
 *
 * gofer-rag is imported on demand rather than at load. It pulls in three ONNX models and a LanceDB
 * table, which is most of what a search costs — and the reachability probe below needs none of it,
 * because what the probe is asking is whether the reading half assembles and answers, not whether
 * the manual can be searched. A top-level import would have made every probe pay for the search it
 * is not doing.
 */
import readline from 'node:readline'
import {CREDENTIAL_PREFIX, createToolHost} from './ai-host.mjs'
import {PROBE_ANSWER, probeRetriever, runRetrieve} from './rag-retrieve.mjs'

const write = (prefix, payload) => process.stdout.write(`${prefix}${JSON.stringify(payload)}\n`)
const credentialHost = createToolHost(call => write(CREDENTIAL_PREFIX, call), 'credential')

/** Hands one rotated credential to Rust, and waits for the keyring write to be acknowledged. */
const persistCredential = credential =>
    credential ? credentialHost.call('store', {credential}) : credentialHost.call('clear', {})

/** The real search, with the heavy import paid for only when there is a search to run. */
const retrieve = async (question, options) => {
    const {retrieve: real} = await import('@mjasnikovs/gofer-rag')
    return real(question, options)
}

function isProbe(line) {
    try {
        return JSON.parse(line)?.probe === true
    } catch {
        return false
    }
}

const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity})
let question
let answered

for await (const line of lines) {
    if (question === undefined) {
        question = line
        const run =
            isProbe(question) ? probeRetriever() : (
                runRetrieve({
                    retrieve,
                    persistCredential,
                    input: async () => question,
                    output: message => process.stdout.write(message),
                    fail: message => process.stderr.write(`${message}\n`)
                })
            )
        // Started rather than awaited: the replies a real retrieval waits for arrive on the very
        // lines this loop is here to read.
        answered = Promise.resolve(run).finally(() => {
            credentialHost.close('The documentation search ended')
            lines.close()
        })
        continue
    }
    try {
        credentialHost.deliver(JSON.parse(line))
    } catch {
        // A line that is not a reply is not this channel's to complain about.
    }
}

await answered
export {PROBE_ANSWER}
