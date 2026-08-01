import {createModels, createProvider} from '@earendil-works/pi-ai'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'

const PROVIDER_ID = 'local'

function zeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
    }
}

function modelFor(settings) {
    return {
        id: settings.model,
        name: settings.model === 'Qwen3.6-27B-UD-Q4_K_XL.gguf' ? 'Qwen3.6 27B' : settings.model,
        api: 'openai-completions',
        provider: PROVIDER_ID,
        baseUrl: settings.baseUrl,
        reasoning: false,
        input: ['text', 'image'],
        cost: {input: 0.3, output: 0.6, cacheRead: 0.03, cacheWrite: 0.3},
        contextWindow: 120_064,
        maxTokens: 120_064,
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false
        }
    }
}

function contextMessage(message, model) {
    if (message.sender === 'user') {
        return {role: 'user', content: message.text, timestamp: message.timestamp}
    }
    return {
        role: 'assistant',
        content: [{type: 'text', text: message.text}],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: 'stop',
        timestamp: message.timestamp
    }
}

export async function streamAiResponse({settings, apiKey, messages, emit, signal}) {
    const model = modelFor(settings)
    const provider = createProvider({
        id: PROVIDER_ID,
        name: settings.name,
        baseUrl: settings.baseUrl,
        auth: {
            apiKey: {
                name: settings.name,
                resolve: async () => ({auth: {apiKey: apiKey || 'local'}})
            }
        },
        models: [model],
        api: openAICompletionsApi()
    })
    const models = createModels()
    models.setProvider(provider)
    const stream = models.stream(
        model,
        {messages: messages.map(message => contextMessage(message, model))},
        {signal}
    )

    let text = ''
    for await (const event of stream) {
        if (event.type === 'text_delta') {
            text += event.delta
            emit({type: 'text-delta', delta: event.delta})
        }
    }

    const result = await stream.result()
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw new Error(result.errorMessage || `AI request ${result.stopReason}`)
    }

    const completion = {type: 'done', text, stopReason: result.stopReason, usage: result.usage}
    emit(completion)
    return completion
}
