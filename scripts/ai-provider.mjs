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
import {createGodotTools} from './ai-host.mjs'
import {confineTool} from './workspace-confinement.mjs'

const PROVIDER_ID = 'local'
const DEFAULT_CONTEXT_WINDOW = 120_064
const DEFAULT_SYSTEM_PROMPT = `You are Gofer, a capable local coding agent. Work autonomously toward the user's goal.
You can inspect and modify files and run shell commands with the provided tools. Use tools when they help; never claim an action succeeded unless its result confirms it. Keep the user informed with a concise final response.`
/**
 * Appended when the backend offers the Godot domain tools. It carries only what the tool
 * descriptions cannot: that the two scene trees are different things, that a mutation needs the
 * revision the last read reported, and that stopping is an event a caller has to wait for.
 */
const GODOT_TOOL_PROMPT = `A Gofer-managed Godot editor is available through the godot_* tools. Start with godot_session status, and start the session if it is offline.
The edited scene (godot_scene, godot_node) and the running game (godot_runtime) are separate: editing one never changes the other. Scene mutations take expectedRevision from the last read that reported one, and are undoable in the editor until godot_scene save writes them.
Scenes and project.godot belong to the editor, which holds them open: build and change them with godot_scene, godot_node and godot_project, never by writing the file as text. The write and edit tools refuse those files for that reason, and so does a shell command that names one; scripts and every other file are yours to write.
A property that holds a resource — a CollisionShape2D's shape, a Sprite2D's texture — is set with {"type": "resource", "value": {"path": "res://..."}}, and a path written as a string is refused. There is no tool that creates a resource, so write the small ones yourself as .tres files and point at them: a shape is \`[gd_resource type="RectangleShape2D" format=3]\`, a blank line, \`[resource]\`, then \`size = Vector2(64, 16)\`.
After godot_debug launch, wait with await_stop before reading the stack, scopes, or variables. Read godot_logs when something fails without explanation.
A few operations ask the user first — deleting or moving a file, enabling a plugin, and writing a machine-wide editor setting. The call waits for their answer, and approval_denied means they said no: do not retry it, ask what to do instead.`

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
        const images = Array.isArray(message.images) ? message.images : []
        const content = [
            ...(message.text ? [{type: 'text', text: message.text}] : []),
            ...images.map(image => ({type: 'image', data: image.data, mimeType: image.mimeType}))
        ]
        return {
            role: 'user',
            content: images.length > 0 ? content : message.text,
            timestamp: message.timestamp
        }
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
    if (name.startsWith('godot_')) return args.op
    return args.path
}

function bindTool(tool, context) {
    return {
        ...tool,
        execute: (id, params, signal, onUpdate) =>
            tool.execute(id, params, signal, onUpdate, context)
    }
}

/**
 * The tools one turn may use: the confined file and shell tools, plus the Godot domain tools the
 * backend offered. The domain tools are forwarded to Rust rather than implemented here, so the
 * agent and the desktop UI drive one implementation of every operation.
 */
export function createAgentTools(workspacePath, domains, host) {
    const env = new NodeExecutionEnv({cwd: workspacePath})
    const context = {env}
    const confined = [createReadTool(), createWriteTool(), createEditTool(), createBashTool()]
        .map(tool => confineTool(tool, workspacePath))
        .map(tool => bindTool(tool, context))
    return {
        env,
        tools: host ? [...confined, ...createGodotTools(domains, host)] : confined
    }
}

export async function runAgent({
    settings,
    apiKey,
    messages,
    agentMessages,
    workspacePath,
    memoryContext,
    tools: domains,
    host,
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
    const {env, tools} = createAgentTools(workspacePath, domains, host)
    const previousMessages =
        Array.isArray(agentMessages) ? agentMessages : (
            messages.slice(0, -1).map(message => contextMessage(message, model))
        )
    const promptMessage = messages.at(-1)
    if (!promptMessage || (!promptMessage.text && promptMessage.images.length === 0)) {
        throw new Error('The agent request does not contain a user prompt or image')
    }

    const agent = new Agent({
        initialState: {
            systemPrompt: `${settings.systemPrompt || DEFAULT_SYSTEM_PROMPT}${tools.some(tool => tool.name.startsWith('godot_')) ? `\n\n${GODOT_TOOL_PROMPT}` : ''}${memoryContext ? `\n\nRelevant persistent project memory:\n${memoryContext}` : ''}`,
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
        await agent.prompt(contextMessage(promptMessage, model))
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
