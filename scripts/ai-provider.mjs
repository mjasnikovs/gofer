import {
    Agent,
    calculateContextTokens,
    compact,
    convertToLlm,
    createBashTool,
    createCompactionSummaryMessage,
    createEditTool,
    createReadTool,
    createWriteTool,
    estimateContextTokens,
    estimateTokens,
    prepareCompaction,
    shouldCompact
} from '@earendil-works/pi-agent-core/node'
import {createModels, createProvider} from '@earendil-works/pi-ai'
import {runVerifyPoints, verifyPointsIn, verifyReport, verifySummary} from './verify-points.mjs'
import {frozenPathsIn} from './frozen-paths.mjs'
import {promptWithSkills} from './skills.mjs'
import {isContextOverflow} from '@earendil-works/pi-ai/compat'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex'
import {createGodotTools} from './godot-tools.mjs'
import {turnContextText, withTurnContext} from './turn-context.mjs'
import {
    EMPTY_ANSWER,
    abortableWait,
    createToolEnv,
    decorateTools,
    isWorthRetrying,
    realTimers,
    textContent,
    zeroUsage
} from './agent-runtime.mjs'
import {
    compactDone,
    compactionEnd,
    compactionStart,
    contextRebuilt,
    retryScheduled,
    retryStart,
    steered,
    textDelta,
    thinkingDelta,
    toolCost,
    toolEnd,
    toolStart,
    toolUpdate,
    turnDone,
    usageReport
} from './ai-events.mjs'
import {createCredentialStore} from './ai-credentials.mjs'
import {probeTools} from './ai-reachability.mjs'
import {createAskUserTool} from './ai-ask.mjs'
import {createAskDelegate} from './ai-ask-loop.mjs'
import {createSubagentTool} from './ai-subagent.mjs'
import {createWebFetchTool} from './ai-fetch.mjs'
import {createWebSearchTool} from './ai-search.mjs'
import {createTranscript, withoutTrailingAnswer} from './ai-transcript.mjs'
import {toolTarget} from './tool-target.mjs'
import {withoutPackedLiterals} from './scene-text.mjs'
import {confineTool} from './workspace-confinement.mjs'
import {readableProviderError} from './provider-error.mjs'
import {piThinkingLevel} from './thinking-level.mjs'
import {piModel} from './pi-model.mjs'
import {DEFAULT_SEARCH_PROVIDER, TUNING_DEFAULTS} from './tuning-defaults.mjs'

export {readableProviderError, outOfRoom}

// GENERATED-BEGIN drivers sha256:d35c4544ffb31ba1
/** Every driver a build knows, in the order the pickers offer them. */
export const DRIVERS = [
    'local',
    'openai-compatible',
    'openai-codex',
    'openrouter',
    'qwen',
    'cerebras'
]

/** Which pi-ai provider answers each driver. ChatGPT has none: pi-ai ships its own. */
const PROVIDER_IDS = {
    local: 'local',
    'openai-compatible': 'openai-compatible',
    openrouter: 'openrouter',
    qwen: 'qwen',
    cerebras: 'cerebras'
}

/** What each driver is called in the one sentence a user reads about its connection. */
const DRIVER_NAMES = {
    local: 'local',
    'openai-compatible': 'OpenAI-compatible',
    'openai-codex': 'ChatGPT',
    openrouter: 'OpenRouter',
    qwen: 'Qwen',
    cerebras: 'Cerebras'
}

/**
 * Which stored secret each driver authenticates with.
 *
 * A key used to reach the worker as its own named field, so the name had to be spelt
 * the same on both sides of the process boundary and a driver whose field nobody
 * passed registered with no key at all. The request carries a map keyed by slot now,
 * and this is the lookup into it.
 */
export const DRIVER_SECRETS = {
    local: 'ai-default',
    'openai-compatible': 'openai-compatible',
    'openai-codex': 'chat-gpt',
    openrouter: 'openrouter',
    qwen: 'qwen',
    cerebras: 'cerebras'
}

/**
 * The hosted drivers `createModelContext` has to build a provider for, in order.
 *
 * Not every driver. pi-ai ships the ChatGPT provider, and the local one is registered
 * on its own because its key falls back to a placeholder where a hosted key must not.
 * What is left is the loop, and it used to be a hand-written pair of names — so a
 * fifth hosted driver passed `providerIdOf`, was never registered, and failed inside
 * pi-ai under a provider id nothing had created.
 */
const HOSTED_DRIVERS = ['openai-compatible', 'openrouter', 'qwen', 'cerebras']
// GENERATED-END drivers

const LOCAL_PROVIDER_ID = PROVIDER_IDS.local

const KEEP_RECENT_TOKENS = 20_000

// GENERATED-BEGIN turn-retry sha256:507be9930d939882
/** What a parent turn does when the provider fails. Overridden per call, never per file. */
export const TURN_RETRY = {
    // How many times one turn is put to the provider again after a failure worth retrying. High
    // because the failures this exists for are a local server being reloaded and a hosted one
    // rate-limiting: both clear on their own, and both take longer than two attempts to clear. A
    // failure that is not worth retrying does not reach this.
    attempts: 10,
    // The first wait, doubled on every attempt after it. Five seconds is what a llama.cpp host
    // takes to finish loading a model it has just been handed, which is the failure the retry is
    // most often waiting out.
    baseDelayMs: 5_000,
    // The ceiling the doubling stops at, so ten attempts are minutes rather than hours. A provider
    // still refusing after a minute of backoff is not going to answer this turn.
    maxDelayMs: 60_000
}
// GENERATED-END turn-retry

const RATE_LIMIT_BASE_DELAY_MS = 1_000

export function retryDelay(attempt, {baseDelayMs, maxDelayMs}) {
    return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
}

export function isRateLimited(errorMessage) {
    return typeof errorMessage === 'string' && /(?:^|[^\w])429(?:[^\w]|$)/u.test(errorMessage)
}

function rateLimitedBackoff(retry) {
    return {...retry, baseDelayMs: Math.min(retry.baseDelayMs, RATE_LIMIT_BASE_DELAY_MS)}
}

function answeredNothing(message) {
    if (message.stopReason !== 'stop') return false
    return !message.content.some(
        part => (part.type === 'text' && part.text.trim() !== '') || part.type === 'toolCall'
    )
}

function turnFailure(finalMessage, agent) {
    if (finalMessage && answeredNothing(finalMessage)) {
        return {...finalMessage, stopReason: 'error', errorMessage: EMPTY_ANSWER}
    }
    if (finalMessage) {
        return {
            ...finalMessage,
            errorMessage: finalMessage.errorMessage || 'The model returned an error'
        }
    }
    return {
        stopReason: 'error',
        errorMessage: agent.state.errorMessage || 'The agent ended without a response'
    }
}

function outOfRoom(message, model) {
    const fresh = message.usage?.input ?? 0
    const cached = message.usage?.cacheRead ?? 0
    const held = fresh + cached
    const wrote = message.usage?.output ?? 0
    const window = model.contextWindow ?? 0
    const ceiling = model.maxTokens ?? 0
    const free = window - held
    if (ceiling > 0 && wrote >= ceiling && free > ceiling) {
        return (
            `The answer ran to its full length and stopped: the model wrote `
            + `${wrote.toLocaleString()} tokens, which is this connection's whole response limit, `
            + `with ${free.toLocaleString()} of its ${window.toLocaleString()}-token context window `
            + `still free. That is a limit on one answer rather than on the conversation, so a `
            + `larger context window would not change it — ask for less at once, or raise the `
            + `response limit on this connection.`
        )
    }
    return (
        `This conversation no longer leaves room for an answer: the request filled `
        + `${held.toLocaleString()} of the model's ${window.toLocaleString()}-token `
        + `context window, so it stopped after ${wrote.toLocaleString()} token`
        + `${wrote === 1 ? '' : 's'}. Start a new task for the rest of this work — a task carries `
        + `its own conversation — or point the connection at a model with a larger context window.`
    )
}

function compactionSettings(percent, contextWindow) {
    const line = Math.floor((contextWindow * percent) / 100)
    return {
        enabled: percent < 100,
        reserveTokens: Math.max(1, contextWindow - line),
        keepRecentTokens: KEEP_RECENT_TOKENS
    }
}

// A slider at 100 means "never summarise on your own", not "summarise badly when asked": taken
// literally it leaves reserveTokens at 1, and generateSummary spends 0.8 of that on the summary.
function manualCompactionSettings(percent, contextWindow) {
    const usable = percent >= 100 ? TUNING_DEFAULTS.compactionPercent : percent
    return compactionSettings(usable, contextWindow)
}

function compactionEntries(messages) {
    return messages.map((message, index) => {
        const base = {
            id: String(index),
            seq: index,
            parentId: index === 0 ? null : String(index - 1),
            timestamp: message.timestamp ?? index
        }
        if (message.role === 'compactionSummary') {
            return {
                ...base,
                type: 'compaction',
                summary: message.summary,
                retainedTail: [],
                tokensBefore: message.tokensBefore ?? 0
            }
        }
        return {...base, type: 'message', message}
    })
}

// The count travels because no caller can recover it: the cut point is chosen inside
// prepareCompaction, and the retained tail does not say how much was folded away.
async function compactMessages(messages, models, model, settings, thinkingLevel, signal) {
    const preparation = prepareCompaction(compactionEntries(messages), settings)
    if (!preparation.ok) throw new Error(`Compaction failed: ${preparation.error.message}`)
    // Nothing older than the tail budget: there is no summary to write, and asking for one buys a
    // model request that folds away zero messages.
    if (!preparation.value || preparation.value.messagesToSummarize.length === 0)
        return {messages, summarised: 0}
    const result = await compact(preparation.value, models, model, undefined, signal, thinkingLevel)
    if (!result.ok) throw new Error(`Compaction failed: ${result.error.message}`)
    return {
        messages: [
            createCompactionSummaryMessage(
                result.value.summary,
                result.value.tokensBefore,
                new Date().toISOString()
            ),
            ...(result.value.retainedTail ?? [])
        ],
        summarised: preparation.value.messagesToSummarize.length
    }
}

function modelFor(connection, providerId = LOCAL_PROVIDER_ID) {
    return piModel(connection, {
        providerId,
        sessionAffinity: providerId === LOCAL_PROVIDER_ID
    })
}

function connectionProfile(settings, connectionType) {
    return settings.connections?.[connectionType]
}

function providerIdOf(driver) {
    const id = PROVIDER_IDS[driver]
    if (id) return id
    throw new Error(
        `No pi-ai provider is registered for the '${driver}' connection. `
            + `This build knows ${DRIVERS.join(', ')}.`
    )
}

function subagentModelFor(settings, models, parent) {
    const chosen = settings.subagent?.connection
    if (!chosen) return {model: parent, thinkingLevel: parentThinkingLevel(settings)}
    const thinkingLevel = piThinkingLevel(chosen.model?.thinkingLevel, chosen.model)
    if (chosen.connectionType === 'openai-codex') {
        const model = models.getModel('openai-codex', chosen.model?.id)
        if (!model)
            throw new Error(`The sub-agent's model '${chosen.model?.id}' is unavailable on ChatGPT`)
        return {model, thinkingLevel}
    }
    const driver = chosen.connectionType
    const providerId = providerIdOf(driver)
    const profile = connectionProfile(settings, driver)
    if (!profile) {
        const named = DRIVER_NAMES[driver]
        throw new Error(
            `The sub-agent is set to the ${named} connection, but no ${named} connection is configured`
        )
    }
    return {
        model: modelFor({...profile, model: chosen.model}, providerId),
        thinkingLevel
    }
}

function parentThinkingLevel(settings) {
    const model = connectionProfile(settings, settings.connectionType)?.model
    return piThinkingLevel(model?.thinkingLevel, model)
}

function imageBlocks(images) {
    return images.map(image => ({type: 'image', data: image.data, mimeType: image.mimeType}))
}

function askedAbout(messages) {
    const asking = messages.at(-1)
    if (asking?.sender !== 'user' || !Array.isArray(asking.images)) return []
    return imageBlocks(asking.images)
}

function contextMessage(message, model) {
    if (message.sender === 'user') {
        const images = Array.isArray(message.images) ? message.images : []
        const content = [
            ...(message.text ? [{type: 'text', text: message.text}] : []),
            ...imageBlocks(images)
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

export function createAgentTools(workspacePath, domains, host, extra = [], model, frozen = []) {
    const env = createToolEnv(workspacePath)
    const confined = [
        withoutPackedLiterals(createReadTool()),
        createWriteTool(),
        createEditTool(),
        createBashTool()
    ].map(tool => confineTool(tool, workspacePath, frozen))
    return {
        env,
        tools: decorateTools({
            env,
            tools: [...confined, ...(host ? createGodotTools(domains, host) : []), ...extra],
            model
        })
    }
}

function storedPromptText(message) {
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

function retryEntry(messages, prompt) {
    let at = -1
    for (const [index, message] of messages.entries()) {
        if (message.role === 'user') at = index
    }
    const stored = at < 0 ? undefined : messages[at]
    if (
        !stored
        || stored.timestamp !== prompt.timestamp
        || storedPromptText(stored) !== prompt.text
    ) {
        return {messages, continues: false}
    }
    let end = messages.length
    while (end > at + 1 && messages[end - 1].role === 'assistant') end -= 1
    return {messages: messages.slice(0, end), continues: true}
}

export function createModelContext({
    settings,
    secrets = {},
    oauthCredential,
    credentialHost,
    sessionId,
    signal
}) {
    const isChatGpt = settings.connectionType === 'openai-codex'
    /** The key a driver sends, out of the slots this request carries. */
    const keyFor = driver => secrets[DRIVER_SECRETS[driver]]
    const drivers = new Set([
        settings.connectionType,
        settings.subagent?.connection?.connectionType
    ])
    const models = createModels({
        credentials:
            drivers.has('openai-codex') ?
                createCredentialStore(oauthCredential, credential =>
                    credential ?
                        credentialHost.call('store', {credential}, signal)
                    :   credentialHost.call('clear', {}, signal)
                )
            :   undefined
    })
    if (drivers.has('openai-codex')) models.setProvider(openaiCodexProvider())
    const localProfile = connectionProfile(settings, 'local')
    if (drivers.has('local') && localProfile) {
        models.setProvider(
            createProvider({
                id: LOCAL_PROVIDER_ID,
                name: localProfile.name,
                baseUrl: localProfile.baseUrl,
                auth: {
                    apiKey: {
                        name: localProfile.name,
                        // This provider's own slot, not the turn's driver: the local server is
                        // registered whenever either seat points at it, and keying on the turn
                        // sent a hosted key to whatever address the user typed.
                        resolve: async () => ({
                            auth: {apiKey: keyFor('local') || 'local'}
                        })
                    }
                },
                models: [modelFor(localProfile)],
                api: openAICompletionsApi()
            })
        )
    }
    for (const driver of HOSTED_DRIVERS) {
        const profile = connectionProfile(settings, driver)
        if (!drivers.has(driver) || !profile) continue
        if (!(driver in DRIVER_SECRETS))
            throw new Error(
                `No API key reaches the '${driver}' connection. It is declared in`
                    + ' protocol/drivers.json and nothing pairs it with a secret.'
            )
        const key = keyFor(driver)
        models.setProvider(
            createProvider({
                id: PROVIDER_IDS[driver],
                name: profile.name,
                baseUrl: profile.baseUrl,
                auth: {
                    apiKey: {
                        name: profile.name,
                        resolve: async () => ({auth: {apiKey: key ?? ''}})
                    }
                },
                models: [modelFor(profile, PROVIDER_IDS[driver])],
                api: openAICompletionsApi()
            })
        )
    }
    const parent = connectionProfile(settings, settings.connectionType)
    const model =
        isChatGpt ? models.getModel('openai-codex', parent?.model?.id)
        : !parent ? undefined
        : modelFor(parent, providerIdOf(settings.connectionType))
    if (!model) throw new Error(`The selected model '${parent?.model?.id}' is unavailable`)
    const subagent = subagentModelFor(settings, models, model)
    const streamOptions = {
        timeoutMs: settings.timeoutMs ?? TUNING_DEFAULTS.timeoutMs,
        maxRetries: settings.maxRetries ?? TUNING_DEFAULTS.maxRetries,
        maxRetryDelayMs: 15_000,
        sessionId
    }
    return {isChatGpt, models, model, subagent, streamOptions}
}

export const LIVE_WORLD = {createModelContext}

export async function runAgent({
    settings,
    systemPrompt = '',
    secrets = {},
    oauthCredential,
    messages,
    agentMessages,
    isRetry = false,
    sessionId,
    workspacePath,
    memoryContext,
    sessionContext,
    inventory,
    disabledSkills = [],
    tools: domains,
    host,
    credentialHost,
    emit,
    signal,
    steering,
    timers = realTimers,
    retry: retryOverride,
    world = LIVE_WORLD
}) {
    const {isChatGpt, models, model, subagent, streamOptions} = world.createModelContext({
        settings,
        secrets,
        oauthCredential,
        credentialHost,
        sessionId,
        signal
    })
    const {env, tools} = createAgentTools(
        workspacePath,
        domains,
        host,
        [
            createSubagentTool({
                workspacePath,
                models,
                model: subagent.model,
                thinkingLevel: subagent.thinkingLevel,
                streamOptions,
                settings: settings.subagent
            }),
            createWebSearchTool({
                provider: settings.web?.searchProvider ?? DEFAULT_SEARCH_PROVIDER,
                apiKey: secrets.brave
            }),
            createWebFetchTool({
                workspacePath,
                models,
                model: subagent.model,
                thinkingLevel: subagent.thinkingLevel,
                streamOptions,
                settings: settings.subagent
            }),
            ...(host ?
                [
                    createAskUserTool({
                        host,
                        delegate: createAskDelegate({
                            workspacePath,
                            models,
                            model: subagent.model,
                            thinkingLevel: subagent.thinkingLevel,
                            streamOptions,
                            settings: settings.subagent,
                            host,
                            images: askedAbout(messages)
                        })
                    })
                ]
            :   [])
        ],
        model,
        frozenPathsIn(messages)
    )
    try {
        await probeTools({tools, host, workspacePath, signal})
    } catch (error) {
        await env.cleanup()
        throw error
    }
    const promptMessage = messages.at(-1)
    if (!promptMessage || (!promptMessage.text && promptMessage.images.length === 0)) {
        throw new Error('The agent request does not contain a user prompt or image')
    }
    const stored = Array.isArray(agentMessages) ? agentMessages : []
    const entry = isRetry ? retryEntry(stored, promptMessage) : {messages: stored, continues: false}
    const rolledBack = entry.messages
    const isRebuilt = rolledBack.length === 0 && messages.length > 1
    const previousMessages =
        isRebuilt ?
            messages.slice(0, -1).map(message => contextMessage(message, model))
        :   rolledBack
    if (isRebuilt) emit(contextRebuilt(previousMessages.length))

    const retry = {...TURN_RETRY, ...retryOverride}

    const compaction = compactionSettings(
        settings.compactionPercent ?? TUNING_DEFAULTS.compactionPercent,
        model.contextWindow
    )
    const contextTokens = estimateContextTokens(previousMessages).tokens
    let contextMessages = previousMessages
    if (shouldCompact(contextTokens, model.contextWindow, compaction)) {
        emit(compactionStart(contextTokens, model.contextWindow))
        contextMessages = (
            await compactMessages(
                previousMessages,
                models,
                model,
                compaction,
                parentThinkingLevel(settings),
                signal
            )
        ).messages
        emit(compactionEnd())
    }

    const compactTranscript = async (tokens, transcript) => {
        emit(compactionStart(tokens, model.contextWindow))
        const compacted = await compactMessages(
            transcript,
            models,
            model,
            compaction,
            parentThinkingLevel(settings),
            signal
        )
        emit(compactionEnd())
        return compacted.messages
    }

    let transcript
    const turnText = turnContextText({memoryContext, sessionContext, inventory})
    const prompt = await promptWithSkills(env, workspacePath, systemPrompt, disabledSkills)
    const turnAnchor = {}
    const agent = new Agent({
        initialState: {
            systemPrompt: prompt,
            model,
            thinkingLevel: parentThinkingLevel(settings),
            tools,
            messages: contextMessages
        },
        prepareNextTurnWithContext: async ({message, context}) => {
            const used = message.usage ? calculateContextTokens(message.usage) : 0
            if (!shouldCompact(used, model.contextWindow, compaction)) return undefined
            const compacted = await compactTranscript(used, context.messages)
            return {context: {...context, messages: transcript.replaceWith(compacted)}}
        },
        convertToLlm,
        transformContext: async messages => withTurnContext(messages, turnText, turnAnchor),
        streamFn: (nextModel, context, options) =>
            models.streamSimple(nextModel, context, {...options, ...streamOptions}),
        sessionId,
        toolExecution: 'parallel'
    })

    transcript = createTranscript(agent, emit)

    if (signal?.aborted) agent.abort()
    else signal?.addEventListener('abort', () => agent.abort(), {once: true})

    const steeredIds = new Map()
    steering?.drainInto(asked => {
        const message = contextMessage({sender: 'user', ...asked}, model)
        steeredIds.set(message, asked.id)
        agent.steer(message)
    })

    const state = {
        finalMessage: undefined,
        attempt: 0,
        rateLimited: false,
        verifyAttempt: 0,
        verifyResults: undefined,
        recoveredOverflow: false,
        resume:
            entry.continues && !isRebuilt ?
                () => agent.continue()
            :   () => agent.prompt(contextMessage(promptMessage, model))
    }

    const unsubscribe = agent.subscribe(event => {
        // message_end is the edge the steered message enters the transcript on, so it is the only
        // point the renderer may stop calling it queued.
        if (event.type === 'message_end' && steeredIds.has(event.message)) {
            emit(steered(steeredIds.get(event.message)))
            steeredIds.delete(event.message)
            return
        }
        if (event.type === 'message_update') {
            const update = event.assistantMessageEvent
            if (update.type === 'text_delta') emit(textDelta(update.delta))
            if (update.type === 'thinking_delta') emit(thinkingDelta(update.delta))
            return
        }
        if (event.type === 'tool_execution_start') {
            emit(
                toolStart({
                    id: event.toolCallId,
                    name: event.toolName,
                    target: toolTarget(event.toolName, event.args),
                    startedAt: Date.now()
                })
            )
            return
        }
        if (event.type === 'tool_execution_update') {
            const step = event.partialResult?.details?.step
            emit(
                toolUpdate({
                    id: event.toolCallId,
                    output: textContent(event.partialResult.content ?? []),
                    step: typeof step === 'string' && step !== '' ? step : undefined
                })
            )
            return
        }
        if (event.type === 'tool_execution_end') {
            emit(
                toolEnd({
                    id: event.toolCallId,
                    output: textContent(event.result.content ?? []),
                    isError: event.isError,
                    endedAt: Date.now()
                })
            )
            return
        }
        if (event.type === 'turn_end' && event.message.role === 'assistant') {
            state.finalMessage = event.message
            emit(usageReport(event.message.usage, event.message.model))
            {
                const ids = (event.toolResults ?? []).map(result => result.toolCallId)
                const usage = event.message.usage
                if (ids.length > 0) emit(toolCost(ids, (usage?.input ?? 0) + (usage?.output ?? 0)))
            }
            transcript.checkpoint()
        }
    })

    const verifyPoints = verifyPointsIn(messages)

    const recoverOverflow = async attemptState => {
        if (
            !attemptState.finalMessage
            || attemptState.finalMessage.stopReason !== 'error'
            || !compaction.enabled
            || attemptState.recoveredOverflow
            || !isContextOverflow(attemptState.finalMessage, model.contextWindow)
        )
            return attemptState
        const withoutError = withoutTrailingAnswer(transcript.messages())
        transcript.replaceWith(
            await compactTranscript(estimateContextTokens(withoutError).tokens, withoutError)
        )
        attemptState.recoveredOverflow = true
        attemptState.finalMessage = undefined
        await agent.continue()
        return attemptState
    }

    const gateOnVerifyPoints = async (attemptState, steerPending) => {
        if (
            !attemptState.finalMessage
            || attemptState.finalMessage.stopReason === 'error'
            || answeredNothing(attemptState.finalMessage)
        )
            return 'nothing'
        // Verify points describe a finished turn, and a message waiting to be drained says it is
        // not finished. Running them here costs a whole suite per steer, and delays the steer by it.
        if (steerPending) return 'answered'
        if (!verifyPoints) return 'answered'
        attemptState.verifyResults = await runVerifyPoints({
            points: verifyPoints,
            env,
            emit,
            signal
        })
        const report = verifyReport(attemptState.verifyResults)
        if (report === undefined) return 'answered'
        if (attemptState.verifyAttempt >= 1) return 'answered'
        attemptState.verifyAttempt += 1
        attemptState.resume = () =>
            agent.prompt(contextMessage({sender: 'user', text: report}, model))
        attemptState.finalMessage = undefined
        return 'again'
    }

    const wasStopped = attemptState => {
        if (!signal?.aborted) return false
        attemptState.finalMessage = {
            content: [],
            usage: zeroUsage(),
            model: model.id,
            ...attemptState.finalMessage,
            stopReason: 'aborted'
        }
        return true
    }

    const classifyAndBackoff = async attemptState => {
        const failure = turnFailure(attemptState.finalMessage, agent)
        if (attemptState.attempt >= retry.attempts || !isWorthRetrying(failure, model))
            throw new Error(readableProviderError(failure.errorMessage))
        attemptState.attempt += 1
        attemptState.rateLimited ||= isRateLimited(failure.errorMessage)
        const delayMs = retryDelay(
            attemptState.attempt,
            attemptState.rateLimited ? rateLimitedBackoff(retry) : retry
        )
        emit(
            retryScheduled({
                attempt: attemptState.attempt,
                maxAttempts: retry.attempts,
                delayMs,
                errorMessage: readableProviderError(failure.errorMessage)
            })
        )
        await abortableWait(delayMs, signal, timers).catch(error => {
            if (!signal?.aborted) throw error
        })
        if (signal?.aborted) return attemptState
        emit(retryStart(attemptState.attempt, retry.attempts))
        transcript.dropTrailingAnswer()
        attemptState.finalMessage = undefined
        attemptState.resume = () => agent.continue()
        return attemptState
    }

    /**
     * How one attempt at the Turn ended, and therefore what happens next.
     *
     * Six things decide when a Turn ends — a steer to drain, a verify point to answer, a context
     * overflow to recover from, a provider failure to back off from, an abort, and an answer that
     * stands — and each of them is a closure over one shared record. The order they are asked in is
     * the whole contract, and it used to be stated nowhere but the shape of the loop's body. It is
     * one value with three names now, and the loop is the fold over it.
     */
    const nextStep = async () => {
        await recoverOverflow(state)
        const verdict = await gateOnVerifyPoints(
            state,
            agent.hasQueuedMessages() && !signal?.aborted
        )
        if (verdict === 'again') return 'again'
        if (verdict === 'answered') {
            if (!agent.hasQueuedMessages() || signal?.aborted) return 'answered'
            // Typed while the last turn was ending, so the loop's own drain point had gone.
            state.resume = () => agent.continue()
            return 'again'
        }
        if (wasStopped(state)) return 'stopped'
        await classifyAndBackoff(state)
        return wasStopped(state) ? 'stopped' : 'again'
    }

    try {
        for (;;) {
            await state.resume()
            const step = await nextStep()
            if (step === 'answered' || step === 'stopped') break
        }
        const {finalMessage, verifyResults} = state
        if (finalMessage.stopReason === 'length') throw new Error(outOfRoom(finalMessage, model))
        const verifyFailure = verifySummary(verifyResults)
        const answered = textContent(finalMessage.content)
        const completion = turnDone({
            text: verifyFailure === undefined ? answered : `${answered}\n\n${verifyFailure}`,
            verify:
                verifyResults === undefined ? undefined : (
                    {
                        failed: verifyResults.filter(result => !result.passed).length,
                        points: verifyResults.map(result => ({
                            name: result.name,
                            passed: result.passed
                        }))
                    }
                ),
            thinking: finalMessage.content
                .filter(part => part.type === 'thinking')
                .map(part => part.thinking)
                .join(''),
            stopReason: finalMessage.stopReason,
            usage: finalMessage.usage,
            model: finalMessage.model,
            agentMessages: transcript.messages()
        })
        emit(completion)
        return completion
    } catch (error) {
        transcript.checkpoint()
        throw error
    } finally {
        unsubscribe()
        await env.cleanup()
    }
}

/**
 * One summarisation, with no turn around it. What the Compact button runs.
 *
 * No tools, no probes, no skills, no system prompt: a summary is one completion against the
 * transcript, and none of those reach the summariser. No `shouldCompact` gate either —
 * `prepareCompaction` has no threshold, and declines only what compacting on demand should decline.
 */
export async function runCompaction({
    settings,
    secrets = {},
    oauthCredential,
    agentMessages,
    sessionId,
    credentialHost,
    emit,
    signal,
    world = LIVE_WORLD
}) {
    const {models, model} = world.createModelContext({
        settings,
        secrets,
        oauthCredential,
        credentialHost,
        sessionId,
        signal
    })
    const stored = Array.isArray(agentMessages) ? agentMessages : []
    const tokensBefore = estimateContextTokens(stored).tokens
    emit(compactionStart(tokensBefore, model.contextWindow))
    let compacted
    try {
        compacted = await compactMessages(
            stored,
            models,
            model,
            manualCompactionSettings(
                settings.compactionPercent ?? TUNING_DEFAULTS.compactionPercent,
                model.contextWindow
            ),
            parentThinkingLevel(settings),
            signal
        )
    } finally {
        emit(compactionEnd())
    }
    const completion = compactDone({
        agentMessages: compacted.messages,
        summarised: compacted.summarised,
        tokensBefore,
        // Summed, not estimated: estimateContextTokens trusts the newest assistant usage it finds,
        // and the retained tail still reports the count from before the cut.
        tokensAfter: compacted.messages.reduce(
            (total, message) => total + estimateTokens(message),
            0
        )
    })
    emit(completion)
    return completion
}
