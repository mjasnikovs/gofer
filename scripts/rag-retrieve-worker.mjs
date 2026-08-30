import readline from 'node:readline'
import {CREDENTIAL_PREFIX, createToolHost} from './ai-host.mjs'
import {PROBE_ANSWER, probeRetriever, runRetrieve} from './rag-retrieve.mjs'

const write = (prefix, payload) => process.stdout.write(`${prefix}${JSON.stringify(payload)}\n`)
const credentialHost = createToolHost(call => write(CREDENTIAL_PREFIX, call), 'credential')

const persistCredential = credential =>
    credential ? credentialHost.call('store', {credential}) : credentialHost.call('clear', {})

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
        answered = Promise.resolve(run).finally(() => {
            credentialHost.close('The documentation search ended')
            lines.close()
        })
        continue
    }
    try {
        credentialHost.deliver(JSON.parse(line))
    } catch {}
}

await answered
export {PROBE_ANSWER}
