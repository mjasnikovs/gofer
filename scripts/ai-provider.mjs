import {
    Agent,
    InMemorySessionStorage,
    NodeExecutionEnv,
    Session,
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
import {createModels, createProvider, isRetryableAssistantError} from '@earendil-works/pi-ai'
import {runVerifyPoints, verifyPointsIn, verifyReport} from './verify-points.mjs'
import {isContextOverflow} from '@earendil-works/pi-ai/compat'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex'
import {createGodotTools} from './ai-host.mjs'
import {createCredentialStore} from './ai-credentials.mjs'
import {probeTools} from './ai-reachability.mjs'
import {createAskUserTool} from './ai-ask.mjs'
import {createSubagentTool} from './ai-subagent.mjs'
import {createWebFetchTool} from './ai-fetch.mjs'
import {createWebSearchTool} from './ai-search.mjs'
import {createTranscript, withoutTrailingAnswer} from './ai-transcript.mjs'
import {toolTarget} from './tool-target.mjs'
import {withoutPackedLiterals} from './scene-text.mjs'
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

/*
 * How hard a turn tries again by itself before it hands the failure to the user.
 *
 * A local model is not a service: it is killed by the machine it shares, it is restarted while a
 * turn is in flight, and its socket is dropped part-way through a stream. Every one of those is
 * over in seconds and none of them is the user's to fix, so the turn waits and asks again rather
 * than ending with a button. Ten tries doubling from five seconds is about seven minutes of
 * patience, which outlasts a model restart without leaving a dead turn on screen for an hour.
 *
 * The delay is capped because doubling ten times ends at forty-three minutes for the last wait
 * alone — long enough that the user has closed the window before it fires.
 */
const DEFAULT_RETRY_ATTEMPTS = 10
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000

/** `base * 2^(attempt-1)`, held at the cap. Pi's curve, with a ceiling Pi does not need. */
export function retryDelay(attempt, {baseDelayMs, maxDelayMs}) {
    return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
}

/** A wait that a cancelled turn does not have to sit through. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('The turn was stopped'))
            return
        }
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer)
                reject(new Error('The turn was stopped'))
            },
            {once: true}
        )
    })
}

/**
 * Why a turn did not produce an answer, in the one shape both endings can be judged by.
 *
 * A turn fails two ways: the model answered with an error, or it never answered at all and the
 * agent recorded why. Only the first carries a message the classifier can read, so the second is
 * given the same shape rather than a separate branch at every call site.
 */
function turnFailure(finalMessage, agent) {
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

/**
 * Whether waiting and asking again is worth anything.
 *
 * Context overflow is asked first and always answered no: it is deterministic, it fails identically
 * every time, and compaction — not patience — is its repair. Everything else is Pi's classifier,
 * which is a list of provider and transport wording earned from real failures. Copying the list
 * here would have meant maintaining it here.
 */
function isTransientFailure(failure, model) {
    if (isContextOverflow(failure, model.contextWindow)) return false
    return isRetryableAssistantError(failure)
}

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
            supportsReasoningEffort: settings.supportsReasoningEffort ?? false,
            // The same story, told to a local server. `prompt_cache_key` is an OpenAI field and a
            // local endpoint never sees one, so the session travels as headers instead: anything
            // holding a KV cache per session — a proxy, a second worker — can route the ask back to
            // the machine that already has this task's prefix rather than recomputing it.
            sendSessionAffinityHeaders: true
        }
    }
}

/**
 * Which stored connection serves a driver, as the flat settings and the saved pair hold it between
 * them.
 *
 * The driver the parent is on lives in the flat fields; the other one lives in the pair. Both are
 * read here rather than only the pair, because the flat fields are what the settings page validated
 * and the pair is what it mirrored — reading the mirror for the active driver would be trusting a
 * copy over the original.
 */
function connectionProfile(settings, connectionType) {
    if (parentDriver(settings) === connectionType) return settings
    return connectionType === 'openai-codex' ? settings.chatgpt : settings.local
}

/**
 * Which connection the parent is on.
 *
 * Anything that is not ChatGPT is the local one, rather than only the exact word for it. That is
 * how every other test of the driver in this file already reads, and a settings blob that predates
 * the field has to keep meaning what it has always meant.
 */
function parentDriver(settings) {
    return settings.connectionType === 'openai-codex' ? 'openai-codex' : 'openai-compatible'
}

/**
 * The model one delegation is answered by, and the level it is asked at.
 *
 * Absent settings mean the child borrows the parent's, which is what every settings file written
 * before the field says. A child pointed at a connection or a model that is not there stops the turn
 * by name: falling back to the parent would spend the large model on the small model's work and say
 * nothing about having done so.
 */
function subagentModelFor(settings, models, parent) {
    const chosen = settings.subagent?.connection
    if (!chosen) return {model: parent, thinkingLevel: settings.thinkingLevel || 'off'}
    const thinkingLevel = chosen.thinkingLevel || 'off'
    if (chosen.connectionType === 'openai-codex') {
        const model = models.getModel('openai-codex', chosen.model)
        if (!model)
            throw new Error(`The sub-agent's model '${chosen.model}' is unavailable on ChatGPT`)
        return {model, thinkingLevel}
    }
    const profile = connectionProfile(settings, 'openai-compatible')
    if (!profile)
        throw new Error(
            'The sub-agent is set to the local connection, but no local connection is configured'
        )
    // The address, the dialect and the name are the connection's. Everything the model carries with
    // it — the id, its window, what it accepts — is the child's own.
    return {
        model: modelFor({
            ...profile,
            model: chosen.model,
            modelName: chosen.modelName,
            contextWindow: chosen.contextWindow,
            maxTokens: chosen.maxTokens,
            reasoning: chosen.reasoning,
            supportsReasoningEffort: chosen.supportsReasoningEffort,
            input: chosen.input
        }),
        thinkingLevel
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
 *
 * `extra` is for tools that are neither: a tool built in Node because it needs a model, which Rust
 * cannot give it. It is passed in rather than built here because it needs the provider, and the
 * provider is not made until a turn starts.
 */
export function createAgentTools(workspacePath, domains, host, extra = []) {
    const env = new NodeExecutionEnv({cwd: workspacePath})
    const context = {env}
    const confined = [
        withoutPackedLiterals(createReadTool()),
        createWriteTool(),
        createEditTool(),
        createBashTool()
    ]
        .map(tool => confineTool(tool, workspacePath))
        .map(tool => bindTool(tool, context))
    return {
        env,
        tools: [...confined, ...(host ? createGodotTools(domains, host) : []), ...extra]
    }
}

/** The words of a stored user message, whose content is a string until an image makes it a list. */
function storedPromptText(message) {
    if (typeof message.content === 'string') return message.content
    if (!Array.isArray(message.content)) return ''
    return message.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('')
}

/**
 * How a retry gets back into a transcript: by carrying on from it, or by asking it again.
 *
 * A retry used to roll the transcript back to just before the prompt, on the reasoning that the
 * failed turn "did not happen". It did happen. A turn that ran for ten minutes and was then stopped
 * or force-quit leaves the prompt plus every tool call and every tool result it got through — one
 * real conversation of six bubbles on screen was two hundred and thirty five messages underneath —
 * and rolling back deleted every one of them from the model's memory, permanently, the moment the
 * user pressed Retry. The screen still showed the work. The files on disk still had the edits. Only
 * the model was made to forget, and there was no way back.
 *
 * So the prompt is not re-asked when the transcript already holds it. The turn continues from where
 * it stopped, exactly as Pi's own retry does, with only the trailing answer taken off — an error or
 * an abandoned reply left in place teaches the model that its last word was that, and the next
 * answer is written to match. What remains ends at the prompt or at a tool result, which is what
 * `Agent.continue` requires.
 *
 * Re-asking is kept for the one case that needs it: a turn that failed before it stored anything —
 * the worker never started, the process was killed, the tool probe refused. The transcript then
 * still ends at the last turn that *succeeded*, and neither continuing from it nor rolling it back
 * is right; the prompt has to be asked. That case is told apart by matching the stored prompt
 * against the one being retried, by both its words and its timestamp.
 */
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

/**
 * Everything a model call needs before there is anything to say: the registered providers, the model
 * the parent runs on, the model a delegate runs on, and the clocks both share.
 *
 * Extracted from `runAgent` rather than left inside it because a turn is no longer the only thing
 * that talks to a model. A host-driven pipeline runs its phases as delegations without ever building
 * a parent agent, and every one of them needs this same setup — which was, until this function
 * existed, reachable only by starting a turn.
 *
 * It builds no tools and holds no conversation. Those are the caller's, and they are what the callers
 * differ in.
 */
export function createModelContext({
    settings,
    apiKey,
    oauthCredential,
    credentialHost,
    sessionId,
    signal
}) {
    const isChatGpt = settings.connectionType === 'openai-codex'
    /*
     * Which connections this needs, which is the parent's and the sub-agent's — and they are
     * allowed to differ. A large model plans while a small one reads is the whole reason the child
     * may name a connection of its own, and the two halves of that are often not on one server.
     *
     * Both are registered on one `Models`, keyed by provider id, so a model carries which connection
     * answers it. The credential store is keyed by provider id too: it hands the ChatGPT credential
     * to the ChatGPT provider and nothing to the local one, which falls back to the API key below.
     */
    const drivers = new Set([parentDriver(settings), settings.subagent?.connection?.connectionType])
    const models = createModels({
        credentials:
            drivers.has('openai-codex') ?
                // Two operations rather than one with an empty argument: a refresh token Pi has
                // given up on has to leave the keyring, and "store nothing" is not something Rust
                // can act on.
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
    const model = isChatGpt ? models.getModel('openai-codex', settings.model) : modelFor(settings)
    if (!model) throw new Error(`The selected model '${settings.model}' is unavailable`)
    const subagent = subagentModelFor(settings, models, model)
    // Shared by the caller's own requests and by the sub-agent's, so a child never waits on a
    // different clock or gives up after a different number of tries than the thing that asked for it.
    const streamOptions = {
        timeoutMs: settings.timeoutMs ?? 120_000,
        maxRetries: settings.maxRetries ?? 2,
        maxRetryDelayMs: 15_000,
        // The sub-agent builds its own `Agent`, so the key the turn's agent carries never reaches
        // it. It goes here instead, where both already share one object: a child's asks are the
        // same fixed child prompt and child tools every time, which is a prefix worth keeping warm.
        sessionId
    }
    return {isChatGpt, models, model, subagent, streamOptions}
}

export async function runAgent({
    settings,
    systemPrompt = '',
    apiKey,
    braveApiKey,
    oauthCredential,
    messages,
    agentMessages,
    isRetry = false,
    sessionId,
    workspacePath,
    memoryContext,
    tools: domains,
    host,
    credentialHost,
    emit,
    signal
}) {
    const {isChatGpt, models, model, subagent, streamOptions} = createModelContext({
        settings,
        apiKey,
        oauthCredential,
        credentialHost,
        sessionId,
        signal
    })
    const {env, tools} = createAgentTools(workspacePath, domains, host, [
        createSubagentTool({
            workspacePath,
            models,
            model: subagent.model,
            thinkingLevel: subagent.thinkingLevel,
            streamOptions,
            settings: settings.subagent
        }),
        createWebSearchTool({
            provider: settings.web?.searchProvider ?? 'exa',
            apiKey: braveApiKey
        }),
        // The page reader borrows the sub-agent's model and its ceilings. Reading one page is the
        // same size of job as answering one question about the checkout, and a second set of
        // sliders for it would be a second thing to keep in step with the first.
        createWebFetchTool({
            workspacePath,
            models,
            model: subagent.model,
            thinkingLevel: subagent.thinkingLevel,
            streamOptions,
            settings: settings.subagent
        }),
        // Answered in Rust, where the window is. Built here because this is where the turn's tools
        // are built, not because a model is involved — nothing about a question needs one.
        //
        // Offered only when there is a backend to answer it, the same rule the domain tools follow:
        // a question with no channel behind it cannot be asked, and a tool that cannot answer would
        // stop the turn at the probe rather than never being offered.
        ...(host ? [createAskUserTool({host})] : [])
    ])
    // Before the model is told anything: a tool that cannot answer stops the turn here, where the
    // reason can be read, rather than becoming a tool the model is offered and never calls.
    try {
        await probeTools({tools, host, workspacePath, signal})
    } catch (error) {
        await env.cleanup()
        throw error
    }
    // Read before the transcript is touched, because the rollback below needs to know which prompt
    // is being asked again before it can decide whether the transcript already holds it.
    const promptMessage = messages.at(-1)
    if (!promptMessage || (!promptMessage.text && promptMessage.images.length === 0)) {
        throw new Error('The agent request does not contain a user prompt or image')
    }
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
    const entry = isRetry ? retryEntry(stored, promptMessage) : {messages: stored, continues: false}
    const rolledBack = entry.messages
    const isRebuilt = rolledBack.length === 0 && messages.length > 1
    const previousMessages =
        isRebuilt ?
            messages.slice(0, -1).map(message => contextMessage(message, model))
        :   rolledBack
    // Said out loud, because a rebuilt context is a conversation the model is seeing for the first
    // time: the tool calls it made are gone, and only what it wrote about them survives.
    if (isRebuilt) emit({type: 'context-rebuilt', messages: previousMessages.length})

    // Settable so a test can drive ten attempts without waiting seven minutes for them. Nothing in
    // the application sends these; the defaults are the policy.
    const retry = {
        attempts: settings.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
        baseDelayMs: settings.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
        maxDelayMs: settings.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS
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

    // The summary request announced, run, and withdrawn — shared by the three moments that can
    // need it: before the turn, between two of the turn's own requests, and after an overflow.
    const compactTranscript = async (tokens, transcript) => {
        emit({type: 'compaction-start', tokens, contextWindow: model.contextWindow})
        const compacted = await compactMessages(
            transcript,
            models,
            model,
            compaction,
            settings.thinkingLevel || 'off',
            signal
        )
        emit({type: 'compaction-end'})
        return compacted
    }

    /**
     * Everything that changes what the model remembers goes through this.
     *
     * Declared before the agent so the subscriber below closes over it; it reads
     * `agent.state.messages` lazily, so the agent existing by the time anything calls it is enough.
     */
    let transcript
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
        // Pi's policy, not only Pi's helpers: the line is checked again after every assistant
        // message, on the count the server reported rather than an estimate. A single agentic turn
        // grows between its own requests, and the pre-turn check has already come and gone.
        prepareNextTurnWithContext: async ({message, context}) => {
            const used = message.usage ? calculateContextTokens(message.usage) : 0
            if (!shouldCompact(used, model.contextWindow, compaction)) return undefined
            const compacted = await compactTranscript(used, context.messages)
            return {context: {...context, messages: transcript.replaceWith(compacted)}}
        },
        // The Agent's own default drops every message that is not user, assistant or tool result,
        // which silently includes the compaction summary. Without this the summary is written, is
        // stored, is counted — and never reaches the model.
        convertToLlm,
        streamFn: (nextModel, context, options) =>
            models.streamSimple(nextModel, context, {...options, ...streamOptions}),
        // The prompt cache key, and it was `settings.sessionId` — a field the settings file has
        // never carried, so it read `undefined` and the request went out without one. The provider
        // sends it as `prompt_cache_key`, which is how the server routes an ask back to the machine
        // that already holds this story's prefix; without it the hit is luck. A measured 24-ask turn
        // paid 8k to 27k for most asks and 875 for one, which is that luck, once.
        //
        // Keyed by task, because the prefix a turn re-sends — the system prompt, the tool catalog,
        // the transcript — is the task's, not the turn's. A turn with no task sends no key, which
        // is what every turn did before.
        sessionId,
        toolExecution: 'parallel'
    })

    transcript = createTranscript(agent, emit)

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
            // A tool that has one — today only a delegation — says what it is doing right now, and
            // it rides `details` rather than the content because content is only read when the row
            // is opened. The row is closed by default, which is how a sub-agent's live report spent
            // its whole life invisible.
            const step = event.partialResult?.details?.step
            emit({
                type: 'tool-update',
                id: event.toolCallId,
                output: textContent(event.partialResult.content ?? []),
                ...(typeof step === 'string' && step !== '' && {step})
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
            // What this one ask cost, addressed to the calls it issued.
            //
            // `input + output` and not `totalTokens`: `cacheRead` is the same story re-sent to the
            // model on every ask of the turn, so summing it across asks counts one prompt hundreds
            // of times. `input` already excludes the cached prefix, so `in + out` is the new work.
            //
            // The ids come out of `toolResults`, which pi hands over with the usage. Nothing is
            // matched by time.
            {
                const ids = (event.toolResults ?? []).map(result => result.toolCallId)
                const usage = event.message.usage
                if (ids.length > 0)
                    emit({
                        type: 'tool-cost',
                        ids,
                        tokens: (usage?.input ?? 0) + (usage?.output ?? 0)
                    })
            }
            // The transcript is checkpointed at every step, not only at the end.
            //
            // It is the model's whole memory of this task, and it used to be reported once, in the
            // completion. A turn that crashed, was stopped, or whose worker was killed never got
            // that far, so everything it had done — every tool call, every file it edited — was
            // dropped from the memory while staying on screen and on disk. The next turn was then
            // answered against a conversation that had never happened.
            transcript.checkpoint()
        }
    })

    try {
        // A retry that carries on says nothing new: the prompt is already the last thing the model
        // was asked, and `prompt` would put it in a second time.
        let resume =
            entry.continues && !isRebuilt ?
                () => agent.continue()
            :   () => agent.prompt(contextMessage(promptMessage, model))
        let recoveredOverflow = false
        let attempt = 0
        let verifyAttempt = 0
        // Read once, before the model runs: the specification is already on the transcript when the
        // turn starts, and a model that writes a VERIFY block into its own answer is describing
        // what it did rather than agreeing to be held to it.
        const verifyPoints = verifyPointsIn(messages)
        for (;;) {
            await resume()
            // A context overflow is recovered from once, not surfaced: the error is taken back off
            // the transcript, the transcript is compacted, and the turn carries on. Surfacing it
            // hands the user a Retry button, and a retry of a task's only prompt rolls back
            // everything. A second overflow after compacting is surfaced, because compacting is the
            // one repair on offer.
            if (
                finalMessage
                && finalMessage.stopReason === 'error'
                && compaction.enabled
                && !recoveredOverflow
                && isContextOverflow(finalMessage, model.contextWindow)
            ) {
                const withoutError = withoutTrailingAnswer(transcript.messages())
                // The error message reports no usage, so the size of what remains is estimated.
                transcript.replaceWith(
                    await compactTranscript(
                        estimateContextTokens(withoutError).tokens,
                        withoutError
                    )
                )
                recoveredOverflow = true
                finalMessage = undefined
                await agent.continue()
            }
            if (finalMessage && finalMessage.stopReason !== 'error') {
                // The turn is over as far as the model is concerned, and this is the last moment
                // before `done` says so out loud. Running the points here rather than after the
                // loop is what makes them a gate: the executor is already rooted in the worktree,
                // the composer has not been released, and the model is still there to be asked
                // again. After `done` it is none of those things.
                if (!verifyPoints) break
                const report = verifyReport(
                    await runVerifyPoints({points: verifyPoints, env, emit, signal})
                )
                if (report === undefined) break
                // Told once, then let go. A model that cannot make its own checks pass on a second
                // attempt is spending turns to write the same answer, and the red points are on the
                // transcript either way — which is the thing that was missing.
                if (verifyAttempt >= 1) break
                verifyAttempt += 1
                resume = () => agent.prompt(contextMessage({sender: 'user', text: report}, model))
                finalMessage = undefined
                continue
            }
            const failure = turnFailure(finalMessage, agent)
            if (attempt >= retry.attempts || !isTransientFailure(failure, model)) {
                throw new Error(failure.errorMessage)
            }
            attempt += 1
            const delayMs = retryDelay(attempt, retry)
            // Two events, not one, because the wait is the part the user is watching: the first
            // says how long and why, the second says the wait is over and the model is being asked
            // again. A single event would leave the countdown reading "in 60s" while the retry ran.
            emit({
                type: 'retry-scheduled',
                attempt,
                maxAttempts: retry.attempts,
                delayMs,
                errorMessage: failure.errorMessage
            })
            await sleep(delayMs, signal)
            emit({type: 'retry-start', attempt, maxAttempts: retry.attempts})
            // The failed answer is taken back off first. Left on, it teaches the model that its own
            // last word was the provider's error text, and the next answer is written to match it.
            transcript.dropTrailingAnswer()
            finalMessage = undefined
            // `continue`, not `prompt`: the prompt is already on the transcript, and asking it
            // again would put the same question in twice.
            resume = () => agent.continue()
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
            agentMessages: transcript.messages()
        }
        emit(completion)
        return completion
    } catch (error) {
        // The last word on what the agent remembers, for a turn that is ending badly. The events
        // above cover the steps that finished; this covers the one that was still running.
        transcript.checkpoint()
        throw error
    } finally {
        unsubscribe()
        await env.cleanup()
    }
}
