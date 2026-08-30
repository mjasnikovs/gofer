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
    compactionEnd,
    compactionStart,
    contextRebuilt,
    retryScheduled,
    retryStart,
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

// GENERATED-BEGIN drivers sha256:91516ff3c944f6c4
/** Every driver a build knows, in the order the pickers offer them. */
export const DRIVERS = ['openai-compatible', 'openai-codex', 'openrouter', 'cerebras']

/** Which pi-ai provider answers each driver. ChatGPT has none: pi-ai ships its own. */
const PROVIDER_IDS = {
    'openai-compatible': 'local',
    openrouter: 'openrouter',
    cerebras: 'cerebras'
}

/** What each driver is called in the one sentence a user reads about its connection. */
const DRIVER_NAMES = {
    'openai-compatible': 'local',
    'openai-codex': 'ChatGPT',
    openrouter: 'OpenRouter',
    cerebras: 'Cerebras'
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
const HOSTED_DRIVERS = ['openrouter', 'cerebras']
// GENERATED-END drivers

const PROVIDER_ID = PROVIDER_IDS['openai-compatible']

const KEEP_RECENT_TOKENS = 20_000

const DEFAULT_RETRY_ATTEMPTS = 10
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000

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

async function compactMessages(messages, models, model, settings, thinkingLevel, signal) {
    const preparation = prepareCompaction(compactionEntries(messages), settings)
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

function modelFor(connection, providerId = PROVIDER_ID) {
    return piModel(connection, {
        providerId,
        sessionAffinity: providerId === PROVIDER_ID
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
    apiKey,
    openrouterApiKey,
    cerebrasApiKey,
    oauthCredential,
    credentialHost,
    sessionId,
    signal
}) {
    const isChatGpt = settings.connectionType === 'openai-codex'
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
    const localProfile = connectionProfile(settings, 'openai-compatible')
    if (drivers.has('openai-compatible') && localProfile) {
        models.setProvider(
            createProvider({
                id: PROVIDER_ID,
                name: localProfile.name,
                baseUrl: localProfile.baseUrl,
                auth: {
                    apiKey: {
                        name: localProfile.name,
                        resolve: async () => ({auth: {apiKey: apiKey || 'local'}})
                    }
                },
                models: [modelFor(localProfile)],
                api: openAICompletionsApi()
            })
        )
    }
    const keySlots = {openrouter: openrouterApiKey, cerebras: cerebrasApiKey}
    for (const driver of HOSTED_DRIVERS) {
        const profile = connectionProfile(settings, driver)
        if (!drivers.has(driver) || !profile) continue
        if (!(driver in keySlots))
            throw new Error(
                `No API key reaches the '${driver}' connection. It is declared in`
                    + ' protocol/drivers.json and nothing passes its key to createModelContext.'
            )
        const key = keySlots[driver]
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
    apiKey,
    openrouterApiKey,
    cerebrasApiKey,
    braveApiKey,
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
    timers = realTimers,
    world = LIVE_WORLD
}) {
    const {isChatGpt, models, model, subagent, streamOptions} = world.createModelContext({
        settings,
        apiKey,
        openrouterApiKey,
        cerebrasApiKey,
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
                apiKey: braveApiKey
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

    const retry = {
        attempts: settings.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
        baseDelayMs: settings.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
        maxDelayMs: settings.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
    }

    const compaction = compactionSettings(
        settings.compactionPercent ?? TUNING_DEFAULTS.compactionPercent,
        model.contextWindow
    )
    const contextTokens = estimateContextTokens(previousMessages).tokens
    let contextMessages = previousMessages
    if (shouldCompact(contextTokens, model.contextWindow, compaction)) {
        emit(compactionStart(contextTokens, model.contextWindow))
        contextMessages = await compactMessages(
            previousMessages,
            models,
            model,
            compaction,
            parentThinkingLevel(settings),
            signal
        )
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
        return compacted
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

    const gateOnVerifyPoints = async attemptState => {
        if (
            !attemptState.finalMessage
            || attemptState.finalMessage.stopReason === 'error'
            || answeredNothing(attemptState.finalMessage)
        )
            return 'nothing'
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

    try {
        for (;;) {
            await state.resume()
            await recoverOverflow(state)
            const verdict = await gateOnVerifyPoints(state)
            if (verdict === 'answered') break
            if (verdict === 'again') continue
            if (wasStopped(state)) break
            await classifyAndBackoff(state)
            if (wasStopped(state)) break
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
