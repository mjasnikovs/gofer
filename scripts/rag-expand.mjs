import {createModels, createProvider} from '@earendil-works/pi-ai'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex'
import {createCredentialStore} from './ai-credentials.mjs'
import {piThinkingLevel} from './thinking-level.mjs'
import {piModel} from './pi-model.mjs'
import {TUNING_DEFAULTS} from './tuning-defaults.mjs'

const PROVIDER_ID = 'rag'
export const CODEX_PROVIDER_ID = 'openai-codex'

export function isCodex(connection) {
    return connection?.connectionType === 'openai-codex'
}

export function isUsableConnection(connection) {
    if (connection === null || typeof connection !== 'object') return false
    if (typeof connection.model !== 'string' || connection.model === '') return false
    if (isCodex(connection)) return Boolean(connection.oauthCredential)
    return typeof connection.baseUrl === 'string' && connection.baseUrl !== ''
}

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
        {providerId: PROVIDER_ID, sessionAffinity: false, maxTokens}
    )
}

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

export function textOf(message) {
    return (message?.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
        .trim()
}

export function createCompletion(connection, {models: injected, persistCredential} = {}) {
    if (!isUsableConnection(connection)) return undefined
    const codex = isCodex(connection)
    const models =
        injected
        ?? (codex ? codexProviderFor(connection, persistCredential) : providerFor(connection))
    return async ({system, user, maxTokens}) => {
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
