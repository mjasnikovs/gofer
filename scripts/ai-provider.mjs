import {
    Agent,
    InMemorySessionStorage,
    NodeExecutionEnv,
    Session,
    compact,
    convertToLlm,
    createBashTool,
    createCompactionSummaryMessage,
    createEditTool,
    createReadTool,
    createWriteTool,
    estimateContextTokens,
    prepareCompaction,
    shouldCompact
} from '@earendil-works/pi-agent-core/node'
import {createModels, createProvider} from '@earendil-works/pi-ai'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {createGodotTools} from './ai-host.mjs'
import {confineTool} from './workspace-confinement.mjs'

const PROVIDER_ID = 'local'
const DEFAULT_CONTEXT_WINDOW = 120_064
/**
 * How full the context may get before the old part of it is summarised away.
 *
 * Pi states the same line as a token reserve — 16,384 of a 120,064-token window — which is 86.4%
 * full. A percentage is the number that survives a change of model, so that is what Gofer stores
 * and what the reserve is derived back from; 86 puts the line within ~400 tokens of Pi's.
 */
const DEFAULT_COMPACTION_PERCENT = 86
/** Recent conversation kept verbatim behind the summary. Pi's default, unchanged. */
const KEEP_RECENT_TOKENS = 20_000

/**
 * Says that the conversation left the model no room to answer.
 *
 * A turn that ran out of room is not an answer, and it does not look like a failure either: the
 * model emits a token or two and stops, and every layer above records a complete assistant message
 * whose text is the single word "I". The work carries on against a conversation that can no longer
 * hold a reply, and nothing on screen says why the answers went empty. So it is raised as the error
 * it is, naming the two numbers that explain it and the one thing that fixes it.
 */
function outOfRoom(message, model) {
    const used = message.usage?.input ?? 0
    const wrote = message.usage?.output ?? 0
    return (
        `This conversation no longer leaves room for an answer: the request filled `
        + `${used.toLocaleString()} of the model's ${model.contextWindow.toLocaleString()}-token `
        + `context window, so it stopped after ${wrote.toLocaleString()} token`
        + `${wrote === 1 ? '' : 's'}. Start a new task for the rest of this work — a task carries `
        + `its own conversation — or point the connection at a model with a larger context window.`
    )
}

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

/**
 * Where the compaction line sits, and how much conversation survives it.
 *
 * `reserveTokens` is the room left above the line: the summary request and the answer that follows
 * compaction both have to fit in it, which is why the percentage cannot be pushed to 100. At 100 it
 * means the user turned compaction off, and the conversation is sent whole until it no longer fits.
 */
function compactionSettings(percent, contextWindow) {
    const line = Math.floor((contextWindow * percent) / 100)
    return {
        enabled: percent < 100,
        reserveTokens: Math.max(1, contextWindow - line),
        keepRecentTokens: KEEP_RECENT_TOKENS
    }
}

/**
 * The conversation as session entries, the only shape the compaction helpers read.
 *
 * A summary an earlier compaction left behind goes back in as the compaction entry it came from
 * rather than as a message. That is what lets the next compaction update it — summarise only what
 * happened since — instead of summarising the summary along with everything after it.
 */
async function compactionSession(messages) {
    const session = new Session(new InMemorySessionStorage())
    for (const message of messages) {
        if (message.role === 'compactionSummary') {
            await session.appendCompaction(message.summary, undefined, message.tokensBefore ?? 0)
            continue
        }
        await session.appendMessage(message)
    }
    return session
}

/**
 * Summarise the part of a conversation that no longer leaves room for an answer, and return what to
 * send in its place: the summary, then the recent messages.
 *
 * The cut point comes from the library rather than from a slice of our own, because the only safe
 * cut is one that never leaves a tool result without the assistant message that asked for it.
 */
async function compactMessages(messages, models, model, settings, thinkingLevel, signal) {
    const session = await compactionSession(messages)
    const preparation = prepareCompaction(await session.getBranch(), settings)
    if (!preparation.ok) throw new Error(`Compaction failed: ${preparation.error.message}`)
    if (!preparation.value) return messages
    const result = await compact(preparation.value, models, model, undefined, signal, thinkingLevel)
    if (!result.ok) throw new Error(`Compaction failed: ${result.error.message}`)
    return [
        createCompactionSummaryMessage(
            result.value.summary,
            result.value.tokensBefore,
            new Date().toISOString()
        ),
        ...(result.value.retainedTail ?? [])
    ]
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

/**
 * The transcript with the last prompt, and everything the agent did about it, taken back off.
 *
 * A turn is checkpointed as it runs, so a turn that failed leaves its own prompt and its half-done
 * work in the transcript. Re-prompting on top of that asks the same question twice — once in the
 * history, once as the question — and the model answers the conversation it can see. A retry is the
 * one caller that means "this did not happen", so it is the one caller that rolls it back.
 */
function withoutLastPrompt(messages) {
    let at = -1
    for (const [index, message] of messages.entries()) {
        if (message.role === 'user') at = index
    }
    return at < 0 ? messages : messages.slice(0, at)
}

export async function runAgent({
    settings,
    systemPrompt = '',
    apiKey,
    messages,
    agentMessages,
    isRetry = false,
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
    /*
     * The model's memory, or the screen's copy of it when the memory is empty.
     *
     * This used to be `Array.isArray(agentMessages)`, and the renderer always sends an array — it
     * starts as `[]` — so the rebuild below was unreachable from the application and only ever ran
     * in a test that omitted the field. A task whose first turn failed therefore kept an empty
     * transcript for good, and every message after it was sent to the model with no history at all
     * while the window showed the whole conversation. Emptiness is the condition that matters, not
     * the type, so emptiness is what is asked.
     */
    const stored = Array.isArray(agentMessages) ? agentMessages : []
    const rolledBack = isRetry ? withoutLastPrompt(stored) : stored
    const isRebuilt = rolledBack.length === 0 && messages.length > 1
    const previousMessages =
        isRebuilt ?
            messages.slice(0, -1).map(message => contextMessage(message, model))
        :   rolledBack
    // Said out loud, because a rebuilt context is a conversation the model is seeing for the first
    // time: the tool calls it made are gone, and only what it wrote about them survives.
    if (isRebuilt) emit({type: 'context-rebuilt', messages: previousMessages.length})
    const promptMessage = messages.at(-1)
    if (!promptMessage || (!promptMessage.text && promptMessage.images.length === 0)) {
        throw new Error('The agent request does not contain a user prompt or image')
    }

    // Checked before the turn starts rather than after the last one ended, so a conversation that
    // was already over the line when it was stored — or that grew past it in a build with no
    // compaction at all — is compacted the first time it is picked up again.
    const compaction = compactionSettings(
        settings.compactionPercent ?? DEFAULT_COMPACTION_PERCENT,
        model.contextWindow
    )
    const contextTokens = estimateContextTokens(previousMessages).tokens
    let contextMessages = previousMessages
    if (shouldCompact(contextTokens, model.contextWindow, compaction)) {
        // Summarising is one or two model requests of its own, and the turn has nothing to show
        // while they run. It is announced because a minute spent summarising and a minute spent
        // stuck look exactly the same from the outside.
        emit({type: 'compaction-start', tokens: contextTokens, contextWindow: model.contextWindow})
        contextMessages = await compactMessages(
            previousMessages,
            models,
            model,
            compaction,
            settings.thinkingLevel || 'off',
            signal
        )
        emit({type: 'compaction-end'})
    }

    const agent = new Agent({
        initialState: {
            // The prompt arrives whole: the backend composes what it ships, the settings page
            // shows that text, and a project that edited it sends its own. Memory is the one thing
            // appended here, because it is this turn's data rather than the user's instructions.
            systemPrompt: `${systemPrompt}${memoryContext ? `\n\nRelevant persistent project memory:\n${memoryContext}` : ''}`,
            model,
            thinkingLevel: settings.thinkingLevel || 'off',
            tools,
            messages: contextMessages
        },
        // The Agent's own default drops every message that is not user, assistant or tool result,
        // which silently includes the compaction summary. Without this the summary is written, is
        // stored, is counted — and never reaches the model.
        convertToLlm,
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
            // The transcript is checkpointed at every step, not only at the end.
            //
            // It is the model's whole memory of this task, and it used to be reported once, in the
            // completion. A turn that crashed, was stopped, or whose worker was killed never got
            // that far, so everything it had done — every tool call, every file it edited — was
            // dropped from the memory while staying on screen and on disk. The next turn was then
            // answered against a conversation that had never happened.
            emit({type: 'turn-state', agentMessages: agent.state.messages})
        }
    })

    try {
        await agent.prompt(contextMessage(promptMessage, model))
        if (!finalMessage)
            throw new Error(agent.state.errorMessage || 'The agent ended without a response')
        if (finalMessage.stopReason === 'error') {
            throw new Error(finalMessage.errorMessage || 'The model returned an error')
        }
        if (finalMessage.stopReason === 'length') throw new Error(outOfRoom(finalMessage, model))
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
    } catch (error) {
        // The last word on what the agent remembers, for a turn that is ending badly. The events
        // above cover the steps that finished; this covers the one that was still running.
        emit({type: 'turn-state', agentMessages: agent.state.messages})
        throw error
    } finally {
        unsubscribe()
        await env.cleanup()
    }
}
