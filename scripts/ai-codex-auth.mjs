import {createInterface} from 'node:readline'
import {createModels} from '@earendil-works/pi-ai'
import {registerBunOAuthFlows} from '@earendil-works/pi-ai/bun-oauth'
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex'
import {createCredentialStore} from './ai-credentials.mjs'

// The ChatGPT flow is loaded through a variable specifier, which a bundle has no file to satisfy.
// See `scripts/ai-worker.mjs` for the whole story; this worker is the one that signs in, so it
// needs the flow more than any other.
registerBunOAuthFlows()

const EVENT_PREFIX = 'GOFER_CODEX_EVENT:'
const CREDENTIAL_PREFIX = 'GOFER_CODEX_CREDENTIAL:'

function write(prefix, value) {
    process.stdout.write(`${prefix}${JSON.stringify(value)}\n`)
}

const lines = createInterface({input: process.stdin})[Symbol.asyncIterator]()
const first = await lines.next()
if (first.done) throw new Error('The ChatGPT login worker received no request')
const request = JSON.parse(first.value)

if (request.operation === 'models') {
    const provider = openaiCodexProvider()
    write(EVENT_PREFIX, {type: 'models', models: provider.getModels()})
    process.exit(0)
}

if (request.operation === 'check') {
    const credentials = createCredentialStore(request.credential, async credential => {
        if (credential) write(CREDENTIAL_PREFIX, credential)
    })
    const models = createModels({credentials})
    models.setProvider(openaiCodexProvider())
    const auth = await models.getAuth('openai-codex')
    if (!auth) throw new Error('Sign in with ChatGPT before testing this connection')
    write(EVENT_PREFIX, {type: 'checked'})
    process.exit(0)
}

if (request.operation !== 'login') throw new Error('Unknown ChatGPT authentication operation')

let pendingPrompt
void (async () => {
    for await (const line of lines) {
        if (!pendingPrompt || line.trim() === '') continue
        const response = JSON.parse(line)
        if (response.type !== 'prompt-response') continue
        const settle = pendingPrompt
        pendingPrompt = undefined
        settle.resolve(String(response.value ?? ''))
    }
})().catch(error => pendingPrompt?.reject(error))

const credentials = createCredentialStore(undefined, async credential => {
    if (!credential) throw new Error('Login cannot clear the ChatGPT credential')
    write(CREDENTIAL_PREFIX, credential)
})
const models = createModels({credentials})
models.setProvider(openaiCodexProvider())

const prompt = authPrompt => {
    if (authPrompt.type === 'select') return Promise.resolve(request.method)
    return new Promise((resolve, reject) => {
        pendingPrompt = {resolve, reject}
        write(EVENT_PREFIX, {
            type: 'manual-code-request',
            message: authPrompt.message,
            placeholder: authPrompt.placeholder
        })
        authPrompt.signal?.addEventListener(
            'abort',
            () => {
                if (!pendingPrompt) return
                pendingPrompt = undefined
                reject(new Error('The browser callback completed'))
            },
            {once: true}
        )
    })
}

try {
    await models.login('openai-codex', 'oauth', {
        prompt,
        notify: event => write(EVENT_PREFIX, event)
    })
    write(EVENT_PREFIX, {type: 'completed'})
    // Exited rather than returned: the reader above holds stdin open, and Gofer holds the other
    // end open for as long as the login lives. Falling off the end would leave both sides waiting
    // for the other to close first, and the sign-in button spinning forever.
    process.exit(0)
} catch (error) {
    write(EVENT_PREFIX, {
        type: 'failed',
        message: error instanceof Error ? error.message : String(error)
    })
    process.exit(1)
}
