import {
    Agent,
    NodeExecutionEnv,
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool
} from '@earendil-works/pi-agent-core/node'
import {createModels, createProvider} from '@earendil-works/pi-ai'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'

const PROVIDER_ID = 'local'
const DEFAULT_CONTEXT_WINDOW = 120_064
const DEFAULT_SYSTEM_PROMPT = `You are Gofer, a capable local coding agent. Work autonomously toward the user's goal.
You can inspect and modify files and run shell commands with the provided tools. Use tools when they help; never claim an action succeeded unless its result confirms it. Keep the user informed with a concise final response.`

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
        name: settings.modelName || settings.model,
        api: 'openai-completions',
        provider: PROVIDER_ID,
        baseUrl: settings.baseUrl,
        reasoning: settings.reasoning ?? false,
        input: settings.input ?? ['text'],
        cost: settings.cost ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: settings.maxTokens ?? settings.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: settings.supportsReasoningEffort ?? false
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

function textContent(content) {
    return content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

function toolTarget(name, args) {
    if (name === 'bash') return args.command
    return args.path
}

function bindTool(tool, context) {
    return {
        ...tool,
        execute: (id, params, signal, onUpdate) =>
            tool.execute(id, params, signal, onUpdate, context)
    }
}

export function createAgentTools(workspacePath) {
    const env = new NodeExecutionEnv({cwd: workspacePath})
    const context = {env}
    return {
        env,
        tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()].map(tool =>
            bindTool(tool, context)
        )
    }
}

export async function runAgent({
    settings,
    apiKey,
    messages,
    agentMessages,
    workspacePath,
    emit,
    signal
}) {
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
    const {env, tools} = createAgentTools(workspacePath)
    const previousMessages =
        Array.isArray(agentMessages) ? agentMessages : (
            messages.slice(0, -1).map(message => contextMessage(message, model))
        )
    const prompt = messages.at(-1)?.text
    if (!prompt) throw new Error('The agent request does not contain a user prompt')

    const agent = new Agent({
        initialState: {
            systemPrompt: settings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
            model,
            thinkingLevel: settings.thinkingLevel || 'off',
            tools,
            messages: previousMessages
        },
        streamFn: (nextModel, context, options) =>
            models.streamSimple(nextModel, context, {
                ...options,
                timeoutMs: settings.timeoutMs ?? 120_000,
                maxRetries: settings.maxRetries ?? 2,
                maxRetryDelayMs: 15_000
            }),
        sessionId: settings.sessionId,
        toolExecution: 'parallel'
    })

    if (signal) signal.addEventListener('abort', () => agent.abort(), {once: true})
    let finalMessage
    const unsubscribe = agent.subscribe(event => {
        if (event.type === 'message_update') {
            const update = event.assistantMessageEvent
            if (update.type === 'text_delta') emit({type: 'text-delta', delta: update.delta})
            if (update.type === 'thinking_delta')
                emit({type: 'thinking-delta', delta: update.delta})
            return
        }
        if (event.type === 'tool_execution_start') {
            emit({
                type: 'tool-start',
                id: event.toolCallId,
                name: event.toolName,
                target: toolTarget(event.toolName, event.args),
                startedAt: Date.now()
            })
            return
        }
        if (event.type === 'tool_execution_update') {
            emit({
                type: 'tool-update',
                id: event.toolCallId,
                output: textContent(event.partialResult.content ?? [])
            })
            return
        }
        if (event.type === 'tool_execution_end') {
            emit({
                type: 'tool-end',
                id: event.toolCallId,
                output: textContent(event.result.content ?? []),
                isError: event.isError,
                endedAt: Date.now()
            })
            return
        }
        if (event.type === 'turn_end' && event.message.role === 'assistant') {
            finalMessage = event.message
            emit({type: 'usage', usage: event.message.usage, model: event.message.model})
        }
    })

    try {
        await agent.prompt(prompt)
        if (!finalMessage)
            throw new Error(agent.state.errorMessage || 'The agent ended without a response')
        if (finalMessage.stopReason === 'error') {
            throw new Error(finalMessage.errorMessage || 'The model returned an error')
        }
        const completion = {
            type: 'done',
            text: textContent(finalMessage.content),
            thinking: finalMessage.content
                .filter(part => part.type === 'thinking')
                .map(part => part.thinking)
                .join(''),
            stopReason: finalMessage.stopReason,
            usage: finalMessage.usage,
            model: finalMessage.model,
            agentMessages: agent.state.messages
        }
        emit(completion)
        return completion
    } finally {
        unsubscribe()
        await env.cleanup()
    }
}
