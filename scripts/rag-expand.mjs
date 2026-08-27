/**
 * The model call the documentation search makes, on the connection the user configured.
 *
 * gofer-rag asks a model twice: once to turn a plain-words question into Godot class names before
 * it searches, and once to write an answer from what it found. Left to itself it opens its own
 * connection to a hardcoded address, which is nobody's setting and was silently failing — a 27B
 * that thinks before it answers spent the whole token budget thinking, and the reply came back
 * empty. The package now takes a `complete` function instead, and this builds Gofer's.
 *
 * The prompts stay in gofer-rag. They are tuned against its own evals and none of them are Gofer's
 * to word. What crosses over is only how to reach a model: the address, the credential, the model
 * id and the reasoning level, all of them the sub-agent's own settings.
 *
 * Thinking is dropped here rather than by the package. Only this side knows the dialect, and pi-ai
 * already separates a thinking part from a text part, so there is nothing to parse out of a string.
 */

import {createModels, createProvider} from '@earendil-works/pi-ai'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex'
import {createCredentialStore} from './ai-credentials.mjs'
import {piThinkingLevel} from './thinking-level.mjs'
import {piModel} from './pi-model.mjs'
import {TUNING_DEFAULTS} from './tuning-defaults.mjs'

const PROVIDER_ID = 'rag'
export const CODEX_PROVIDER_ID = 'openai-codex'

/** True when this connection is the ChatGPT subscription rather than a local server. */
export function isCodex(connection) {
    return connection?.connectionType === 'openai-codex'
}

/**
 * What a connection has to carry before a model call can be made at all.
 *
 * ChatGPT is addressed by provider rather than by URL, and its credential is the thing that has to
 * be there instead: without one, Pi answers every ask with "Sign in with ChatGPT" rather than an
 * error, which would read here as a model that declined to expand.
 */
export function isUsableConnection(connection) {
    if (connection === null || typeof connection !== 'object') return false
    if (typeof connection.model !== 'string' || connection.model === '') return false
    if (isCodex(connection)) return Boolean(connection.oauthCredential)
    return typeof connection.baseUrl === 'string' && connection.baseUrl !== ''
}

/**
 * The model as pi-ai describes one, with the ceiling the caller asked for.
 *
 * The sidecar's connection is flat — Rust resolved the driver's key and address before it wrote
 * this record — so the model half is gathered here and the shape itself is `pi-model.mjs`'s, the
 * same one the agent worker builds. It used to be a copy of that builder, field for field.
 *
 * `maxTokens` is per request, not per connection: expansion wants a hundred tokens and an answer
 * wants the window.
 */
function modelFor(connection, maxTokens) {
    return piModel(
        {
            baseUrl: connection.baseUrl,
            chatTemplateThinking: connection.chatTemplateThinking,
            model: {
                id: connection.model,
                name: connection.modelName,
                reasoning: connection.reasoning,
                supportsReasoningEffort: connection.supportsReasoningEffort,
                thinkingLevels: connection.thinkingLevels,
                offEffort: connection.offEffort,
                contextWindow: connection.contextWindow
            }
        },
        // Off, because there is no second worker or proxy holding a prefix for a one-shot expansion
        // to route back to.
        {providerId: PROVIDER_ID, sessionAffinity: false, maxTokens}
    )
}

/**
 * The ChatGPT provider, with the credential Rust read out of the keyring.
 *
 * `persist` is what makes this safe to run outside the agent worker. An OAuth refresh token rotates
 * when it is used, so a refresh that happened here and stayed here would leave the keyring holding
 * a token the provider has already invalidated — the user would be asked to sign in again, with
 * nothing to say why. The store hands every rotation back to Rust and waits for it to be written.
 */
function codexProviderFor(connection, persist) {
    const models = createModels({
        credentials: createCredentialStore(connection.oauthCredential, persist)
    })
    models.setProvider(openaiCodexProvider())
    return models
}

function providerFor(connection) {
    const models = createModels()
    models.setProvider(
        createProvider({
            id: PROVIDER_ID,
            name: connection.modelName || connection.model,
            baseUrl: connection.baseUrl,
            auth: {
                apiKey: {
                    name: connection.modelName || connection.model,
                    resolve: async () => ({auth: {apiKey: connection.apiKey || 'local'}})
                }
            },
            models: [modelFor(connection, connection.maxTokens ?? 120_064)],
            api: openAICompletionsApi()
        })
    )
    return models
}

/** The assistant's words, with any thinking part left behind. */
export function textOf(message) {
    return (message?.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
        .trim()
}

/**
 * The `complete` function gofer-rag calls, or nothing when no connection was supplied.
 *
 * Nothing is an ordinary state, not a fault: a machine with no local connection configured still
 * searches, it just searches unexpanded, which is what the package does by itself anyway.
 */
export function createCompletion(connection, {models: injected, persistCredential} = {}) {
    if (!isUsableConnection(connection)) return undefined
    const codex = isCodex(connection)
    const models =
        injected
        ?? (codex ? codexProviderFor(connection, persistCredential) : providerFor(connection))
    return async ({system, user, maxTokens}) => {
        // ChatGPT's models come from Pi's own catalogue, so the id is looked up rather than
        // described. A model the subscription does not offer is named here, where it can be read.
        const model = codex ? models.getModel(CODEX_PROVIDER_ID, connection.model) : undefined
        if (codex && !model) {
            throw new Error(`The sub-agent's model '${connection.model}' is unavailable on ChatGPT`)
        }
        const stream = models.streamSimple(
            codex ? {...model, maxTokens} : modelFor(connection, maxTokens),
            {systemPrompt: system, messages: [{role: 'user', content: user}]},
            {
                reasoning: piThinkingLevel(connection.thinkingLevel, connection),
                timeoutMs: connection.timeoutMs ?? TUNING_DEFAULTS.timeoutMs,
                maxRetries: connection.maxRetries ?? TUNING_DEFAULTS.maxRetries
            }
        )
        const message = await stream.result()
        if (message?.stopReason === 'error') {
            throw new Error(message.errorMessage || 'the model returned an error')
        }
        return textOf(message)
    }
}
