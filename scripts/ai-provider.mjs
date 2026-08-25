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
import {isContextOverflow} from '@earendil-works/pi-ai/compat'
import {openAICompletionsApi} from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex'
import {createGodotTools} from './godot-tools.mjs'
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
import {piThinkingLevel, piThinkingLevelMap} from './thinking-level.mjs'

const PROVIDER_ID = 'local'
/**
 * OpenRouter's own provider id, so both key-based connections can be registered at once.
 *
 * Required, not tidiness: a `Models` is keyed by provider id, and a parent on a local server with
 * a sub-agent on OpenRouter needs two live registrations with two different addresses and two
 * different credentials.
 */
const OPENROUTER_PROVIDER_ID = 'openrouter'
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

/*
 * The first wait for a refusal that is about this second rather than this machine.
 *
 * Five seconds is the right patience for a model server that died: it is being restarted, and
 * asking again before it is back is asking a socket that is not listening. A shared-pool rate
 * limit is the opposite failure. Nothing is down, the request was turned away because someone
 * else's was being served, and the provider's own body says so — measured against OpenRouter's
 * free pool on 2026-08-25, which answers `limit_source: upstream_provider_shared_pool` and
 * `remedy_hint: "Retry shortly"`, sends no `Retry-After`, and clears within about a second.
 *
 * Sampled thirty times back to back in that state, 11 requests were refused and the longest run of
 * consecutive refusals was three. So ten attempts are ten samples of a coin, and what decides
 * whether a turn survives is how quickly they are taken, not how patiently. On the five-second
 * curve the first five attempts land across 155 seconds and four live turns spent their whole
 * budget — about nine minutes each — being refused and died. From one second they land across 31
 * seconds, and the same ten attempts still stretch to five and a half minutes, so a genuine
 * outage is waited out exactly as before.
 *
 * `Math.min` against the configured base, never a replacement for it: a user who asked for a
 * shorter wait than this is not overruled.
 */
const RATE_LIMIT_BASE_DELAY_MS = 1_000

/** `base * 2^(attempt-1)`, held at the cap. Pi's curve, with a ceiling Pi does not need. */
export function retryDelay(attempt, {baseDelayMs, maxDelayMs}) {
    return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
}

/**
 * Whether the provider turned this request away for the moment.
 *
 * Read off the wording, because that is all a failure carries by the time it reaches the loop. It
 * is only ever asked about failures the classifier has already called worth retrying, so a spent
 * quota — which is also a 429, and which Pi refuses to retry by name — never reaches it.
 */
export function isRateLimited(errorMessage) {
    return typeof errorMessage === 'string' && /(?:^|[^\w])429(?:[^\w]|$)/u.test(errorMessage)
}

/** The configured backoff with the rate-limit base, which is never longer than the configured one. */
function rateLimitedBackoff(retry) {
    return {...retry, baseDelayMs: Math.min(retry.baseDelayMs, RATE_LIMIT_BASE_DELAY_MS)}
}

/**
 * A provider's refusal as a sentence, rather than as the JSON body it arrived in.
 *
 * Pi hands over `"<status>: <body>"` whenever the SDK error carries both, so what the user was
 * shown for a rate-limited turn was 400 characters of JSON with the one actionable line —
 * OpenRouter's `remedy_hint` — buried in the middle of it. The body is the right thing to have
 * kept; it is the wrong thing to have shown.
 *
 * Every part is optional because no two providers fill the same fields: OpenRouter states the real
 * cause in `metadata.raw` and the fix in `metadata.remedy_hint`, llama.cpp and OpenAI state both in
 * `error.message`, and anything this cannot read is handed back exactly as it came. The status is
 * kept in the sentence so a bug report still names it.
 */
export function readableProviderError(errorMessage) {
    if (typeof errorMessage !== 'string') return errorMessage
    const framed = /^(?<status>\d{3}): (?<body>[[{].*)$/su.exec(errorMessage)
    if (!framed?.groups) return errorMessage
    let body
    try {
        body = JSON.parse(framed.groups.body)
    } catch {
        return errorMessage
    }
    const error = body?.error ?? body
    const metadata = error?.metadata ?? {}
    const detail = metadata.raw ?? error?.message ?? body?.message
    if (typeof detail !== 'string' || detail === '') return errorMessage
    const remedy = typeof metadata.remedy_hint === 'string' ? ` ${metadata.remedy_hint}` : ''
    const stop = /[.!?]$/u.test(detail.trim()) ? '' : '.'
    return `The provider refused this request (${framed.groups.status}): ${detail.trim()}${stop}${remedy}`
}

/**
 * Whether a finished turn actually said anything.
 *
 * A gateway whose upstream dies mid-request answers HTTP 200, `finish_reason: "stop"`, and an empty
 * message — measured against OpenRouter, which reports the real cause in `native_finish_reason`, a
 * field the completions dialect does not carry. Every layer above then records a complete assistant
 * turn whose text is nothing at all, and the user gets a blank bubble with no way to ask again.
 *
 * Only `stop` is judged. An aborted turn is empty too — Pi builds its own failure message with a
 * single empty text part — and that one is already an ending the loop knows how to end.
 *
 * Thinking does not count. A reasoning model whose gateway dies after the reasoning block and
 * before any answer comes back holding thinking and nothing else, and thinking is not something the
 * user was told: counting it leaves exactly the blank bubble this check exists to prevent.
 */
function answeredNothing(message) {
    if (message.stopReason !== 'stop') return false
    return !message.content.some(
        part => (part.type === 'text' && part.text.trim() !== '') || part.type === 'toolCall'
    )
}

/**
 * Why a turn did not produce an answer, in the one shape both endings can be judged by.
 *
 * A turn fails three ways: the model answered with an error, it reported success and said nothing,
 * or it never answered at all and the agent recorded why. Only the first carries a message the
 * classifier can read, so the other two are given the same shape rather than a separate branch at
 * every call site. The empty turn is restated as an error on the way through, because it arrives
 * claiming to have stopped normally and every reader below here would believe it.
 */
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
 *
 * Built by hand rather than through a `Session`. An entry is a plain object and `prepareCompaction`
 * takes an array of them, so the storage, the ids and the write-back were all paid for and thrown
 * away. The session API this used to go through was removed under it; a shape it only reads is not
 * something a release can take away.
 */
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
                // Empty, because what this compaction retained is the entries that follow it here.
                retainedTail: [],
                tokensBefore: message.tokensBefore ?? 0
            }
        }
        return {...base, type: 'message', message}
    })
}

/**
 * Summarise the part of a conversation that no longer leaves room for an answer, and return what to
 * send in its place: the summary, then the recent messages.
 *
 * The cut point comes from the library rather than from a slice of our own, because the only safe
 * cut is one that never leaves a tool result without the assistant message that asked for it.
 */
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

/**
 * One connection and the model on it, as pi-ai describes a model.
 *
 * Two halves, and which half a field comes from is the whole of the split: the address, the dialect
 * and how thinking is turned on belong to the connection, and everything the model carries with it
 * belongs to the model. A sub-agent is that same pair with the second half replaced.
 */
function modelFor(connection, providerId = PROVIDER_ID) {
    const chosen = connection.model ?? {}
    const thinkingLevelMap = piThinkingLevelMap(chosen.thinkingLevels)
    // Only a local server holds a KV cache a session header could route back to. See the field.
    const isLocal = providerId === PROVIDER_ID
    return {
        id: chosen.id,
        name: chosen.name || chosen.id,
        api: 'openai-completions',
        provider: providerId,
        baseUrl: connection.baseUrl,
        reasoning: chosen.reasoning ?? false,
        input: chosen.input ?? ['text'],
        cost: chosen.cost ?? {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        contextWindow: chosen.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: chosen.maxTokens ?? chosen.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        // The efforts this server named, so pi-ai asks at the one that was picked rather than at the
        // nearest one it believes in. See `piThinkingLevelMap`.
        ...(thinkingLevelMap ? {thinkingLevelMap} : {}),
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: chosen.supportsReasoningEffort ?? false,
            // A llama.cpp host turns thinking on with a chat-template argument and ignores
            // `reasoning_effort` without a word. Sending only the effort field is why the reasoning
            // level did nothing at all for a local model: the server accepted the request, the
            // template never saw the switch, and the model thought or did not think according to
            // whatever the server was started with.
            ...(connection.chatTemplateThinking ?
                {
                    thinkingFormat: 'chat-template',
                    chatTemplateKwargs: {
                        enable_thinking: {$var: 'thinking.enabled'},
                        // So a turn that thought still shows what it thought when it is replayed as
                        // context. Without it the template drops the reasoning of every prior turn.
                        preserve_thinking: true,
                        // Only where the template has efforts to name. Passing one it does not know
                        // puts an unknown key in the kwargs of every single request.
                        ...(chosen.supportsReasoningEffort ?
                            {reasoning_effort: {$var: 'thinking.effort', omitWhenOff: true}}
                        :   {})
                    }
                }
            :   {}),
            // The same story, told to a local server. `prompt_cache_key` is an OpenAI field and a
            // local endpoint never sees one, so the session travels as headers instead: anything
            // holding a KV cache per session — a proxy, a second worker — can route the ask back to
            // the machine that already has this task's prefix rather than recomputing it.
            //
            // Off for OpenRouter. The header exists to reach a machine that already holds this
            // prefix, and behind that address there is no such machine to reach.
            sendSessionAffinityHeaders: isLocal
        }
    }
}

/**
 * Which stored connection serves a driver: one lookup in the map the settings hold.
 *
 * It used to be a rule instead of a lookup, because the live connection was written down twice —
 * flattened onto the settings and mirrored into a slot beside them — so every reader had to know
 * which copy to trust. The rule was written out in three languages and the three had drifted: Rust
 * matched the driver exactly, and this file read anything that was not ChatGPT or OpenRouter as the
 * local one. One question, two answers.
 */
function connectionProfile(settings, connectionType) {
    return settings.connections?.[connectionType]
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
    if (!chosen) return {model: parent, thinkingLevel: parentThinkingLevel(settings)}
    const thinkingLevel = piThinkingLevel(chosen.model?.thinkingLevel, chosen.model)
    if (chosen.connectionType === 'openai-codex') {
        const model = models.getModel('openai-codex', chosen.model?.id)
        if (!model)
            throw new Error(`The sub-agent's model '${chosen.model?.id}' is unavailable on ChatGPT`)
        return {model, thinkingLevel}
    }
    const openrouter = chosen.connectionType === 'openrouter'
    const driver = openrouter ? 'openrouter' : 'openai-compatible'
    const profile = connectionProfile(settings, driver)
    if (!profile) {
        const named = openrouter ? 'OpenRouter' : 'local'
        throw new Error(
            `The sub-agent is set to the ${named} connection, but no ${named} connection is configured`
        )
    }
    // The address, the dialect and the name are the connection's; the model half is the child's.
    // One field, because the two halves are two types — `chatTemplateThinking` stays the
    // connection's without having to be left out by hand, since it never was the model's.
    return {
        model: modelFor(
            {...profile, model: chosen.model},
            openrouter ? OPENROUTER_PROVIDER_ID : PROVIDER_ID
        ),
        thinkingLevel
    }
}

/** The level the parent is asked at, which is the live connection's model's. */
function parentThinkingLevel(settings) {
    const model = connectionProfile(settings, settings.connectionType)?.model
    return piThinkingLevel(model?.thinkingLevel, model)
}

function imageBlocks(images) {
    return images.map(image => ({type: 'image', data: image.data, mimeType: image.mimeType}))
}

/**
 * The pictures the ask came with, as content blocks.
 *
 * The last user message only, and that is a decision rather than a shortcut. A design is asked for
 * in the same breath as the screenshot it is about, so that message is where the picture is; an
 * older one is a screenshot of something else, and a brief carrying it silently is worse than one
 * carrying nothing. Empty is the ordinary case.
 */
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

/**
 * The tools one turn may use: the confined file and shell tools, plus the Godot domain tools the
 * backend offered. The domain tools are forwarded to Rust rather than implemented here, so the
 * agent and the desktop UI drive one implementation of every operation.
 *
 * `extra` is for tools that are neither: a tool built in Node because it needs a model, which Rust
 * cannot give it. It is passed in rather than built here because it needs the provider, and the
 * provider is not made until a turn starts.
 */
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
    openrouterApiKey,
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
    const drivers = new Set([
        settings.connectionType,
        settings.subagent?.connection?.connectionType
    ])
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
    // Registered on the same `Models` and under its own id, so a parent on a local server and a
    // child on OpenRouter each reach their own address with their own key. The two credentials are
    // never interchangeable: `apiKey` is the local server's and never leaves this machine.
    const openrouterProfile = connectionProfile(settings, 'openrouter')
    if (drivers.has('openrouter') && openrouterProfile) {
        models.setProvider(
            createProvider({
                id: OPENROUTER_PROVIDER_ID,
                name: openrouterProfile.name,
                baseUrl: openrouterProfile.baseUrl,
                auth: {
                    apiKey: {
                        name: openrouterProfile.name,
                        // No `|| 'local'` fallback. OpenRouter refuses an unknown key by name,
                        // which is a better failure than a turn that looks configured and is not.
                        resolve: async () => ({auth: {apiKey: openrouterApiKey ?? ''}})
                    }
                },
                models: [modelFor(openrouterProfile, OPENROUTER_PROVIDER_ID)],
                api: openAICompletionsApi()
            })
        )
    }
    const parent = connectionProfile(settings, settings.connectionType)
    const model =
        isChatGpt ? models.getModel('openai-codex', parent?.model?.id)
        : !parent ? undefined
        : settings.connectionType === 'openrouter' ? modelFor(parent, OPENROUTER_PROVIDER_ID)
        : modelFor(parent)
    if (!model) throw new Error(`The selected model '${parent?.model?.id}' is unavailable`)
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
    openrouterApiKey,
    braveApiKey,
    oauthCredential,
    messages,
    agentMessages,
    isRetry = false,
    sessionId,
    workspacePath,
    memoryContext,
    sessionContext,
    tools: domains,
    host,
    credentialHost,
    emit,
    signal,
    /**
     * The clock the retry backoff waits on.
     *
     * Injectable for the same reason the delegation's is: a policy of ten waits doubling from five
     * seconds cannot be proved by sitting through it, and a test that instead shortens the delays is
     * proving a different policy from the one that ships. Nothing in the application passes this.
     */
    timers = realTimers
}) {
    const {isChatGpt, models, model, subagent, streamOptions} = createModelContext({
        settings,
        apiKey,
        openrouterApiKey,
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
            //
            // One tool, and the delegate is the half of it that agrees a layout over several rounds
            // inside a child. It borrows the sub-agent's model and ceilings for the reason the page
            // reader does: a second set of sliders would be a second thing to keep in step with the
            // first. The pictures are the ones on the message that started this turn, and they are
            // not optional — a design is asked for in the same breath as the screenshot it is about.
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
        // The parent's own model, so a tool answering with a picture it cannot see costs it a sentence
        // rather than the whole request.
        model,
        // Read before the model is offered a single tool, so a frozen path is refused by the tool that
        // would have written it rather than noticed after the commit.
        frozenPathsIn(messages)
    )
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
    if (isRebuilt) emit(contextRebuilt(previousMessages.length))

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

    // The summary request announced, run, and withdrawn — shared by the three moments that can
    // need it: before the turn, between two of the turn's own requests, and after an overflow.
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
            systemPrompt: `${systemPrompt}${memoryContext ? `\n\nRelevant persistent project memory:\n${memoryContext}` : ''}${sessionContext ? `\n\n${sessionContext}` : ''}`,
            model,
            thinkingLevel: parentThinkingLevel(settings),
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

    // Asked before it is listened to, because a listener added to a signal that has already fired
    // never runs. The compaction above is a full model request and can take a minute; a Stop in that
    // window aborted the signal before this line existed, so the agent was never told. The loop then
    // made one complete, uninterrupted request to the model and only noticed at `wasStopped`.
    if (signal?.aborted) agent.abort()
    else signal?.addEventListener('abort', () => agent.abort(), {once: true})

    /**
     * What one pass through the loop below has come to, and the only thing its steps share.
     *
     * These were six mutable locals inside the `for(;;)`, and they were the whole of what held its
     * five separate jobs together — so none of the five could be read, moved or tested on its own.
     *
     * Mutated rather than copied, and that is forced rather than chosen: `finalMessage` is written
     * by the subscriber below, which has no step to return from. A step that answered with a fresh
     * record would be answering with a stale message the moment the next request settled.
     */
    const state = {
        /** The last assistant message this turn produced, whatever it stopped for. */
        finalMessage: undefined,
        /** How many transient failures have been waited out. */
        attempt: 0,
        /**
         * Whether this turn has been rate-limited yet, which decides how long it waits.
         *
         * The turn, not the failure. OpenRouter reports the same refusal two ways — HTTP 429 with
         * its body, and an in-band stream error whose text is the four words `Provider returned
         * error` with the code stripped — and one live turn alternated between them. Read per
         * failure, the base flipped between 1 s and 5 s while the exponent went on climbing, and
         * the waits came out 4 s, 40 s, 16 s. Being rate-limited is a state the turn is in.
         */
        rateLimited: false,
        /** How many times the model has been handed its own red verify report. Once, at most. */
        verifyAttempt: 0,
        verifyResults: undefined,
        recoveredOverflow: false,
        // A retry that carries on says nothing new: the prompt is already the last thing the model
        // was asked, and `prompt` would put it in a second time.
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
            // A tool that has one — today only a delegation — says what it is doing right now, and
            // it rides `details` rather than the content because content is only read when the row
            // is opened. The row is closed by default, which is how a sub-agent's live report spent
            // its whole life invisible.
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
                if (ids.length > 0) emit(toolCost(ids, (usage?.input ?? 0) + (usage?.output ?? 0)))
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

    // Read once, before the model runs: the specification is already on the transcript when the
    // turn starts, and a model that writes a VERIFY block into its own answer is describing
    // what it did rather than agreeing to be held to it.
    const verifyPoints = verifyPointsIn(messages)

    /**
     * A context overflow is recovered from once, not surfaced: the error is taken back off the
     * transcript, the transcript is compacted, and the turn carries on. Surfacing it hands the user
     * a Retry button, and a retry of a task's only prompt rolls back everything. A second overflow
     * after compacting is surfaced, because compacting is the one repair on offer.
     */
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
        // The error message reports no usage, so the size of what remains is estimated.
        transcript.replaceWith(
            await compactTranscript(estimateContextTokens(withoutError).tokens, withoutError)
        )
        attemptState.recoveredOverflow = true
        attemptState.finalMessage = undefined
        await agent.continue()
        return attemptState
    }

    /**
     * What the turn's own checks make of the answer it just produced.
     *
     * Run here rather than after the loop, and that is what makes the points a gate: the executor is
     * already rooted in the worktree, the composer has not been released, and the model is still
     * there to be asked again. After `done` it is none of those things.
     *
     * Three answers, because the loop can do three things with one:
     *
     *   answered  the turn is finished — no points to run, or none of them went red.
     *   again     the model has been handed its own red report and is being asked once more.
     *   nothing   there was no answer to gate, so the endings below it get their turn.
     */
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
        // Told once, then let go. A model that cannot make its own checks pass on a second attempt
        // is spending turns to write the same answer, and the red points are on the transcript
        // either way — which is the thing that was missing.
        if (attemptState.verifyAttempt >= 1) return 'answered'
        attemptState.verifyAttempt += 1
        attemptState.resume = () =>
            agent.prompt(contextMessage({sender: 'user', text: report}, model))
        attemptState.finalMessage = undefined
        return 'again'
    }

    /**
     * Whether the user stopped this turn, and the ending that says so if they did.
     *
     * A stopped turn is the user's decision, not a failure, and it is read from the signal rather
     * than from the message. Pi reports the two cancellations differently: a stop during the request
     * comes back as `aborted`, and a stop while a tool call is in flight comes back as an ordinary
     * error carrying the runtime's own wording. Only the signal knows both are the same event, so it
     * is asked before anything is classified, retried, or thrown — a turn the user stopped must
     * never wait five seconds and ask again.
     */
    const wasStopped = attemptState => {
        if (!signal?.aborted) return false
        // Every field the `done` event is built from is defaulted, because a turn can be stopped
        // before the model produced a message at all. `isAiStreamEvent` rejects a completion whose
        // usage or model is missing, and a rejected completion is dropped in silence — the stopped
        // turn would then never be recorded as having ended.
        attemptState.finalMessage = {
            content: [],
            usage: zeroUsage(),
            model: model.id,
            ...attemptState.finalMessage,
            stopReason: 'aborted'
        }
        return true
    }

    /**
     * The failure this attempt ended on, and what to do about it.
     *
     * Throws when there is nothing left to try — the budget is spent, or the failure is not one that
     * fixes itself — which is how the turn reaches the user. Otherwise it waits out the backoff and
     * leaves the record pointing at the next attempt.
     */
    const classifyAndBackoff = async attemptState => {
        const failure = turnFailure(attemptState.finalMessage, agent)
        // Classified on the wording the provider sent, and only then made readable. The classifier
        // is Pi's list of provider markers, and several of them — `GoUsageLimitError`,
        // `insufficient_quota` in `error.type` — live in fields the readable sentence drops. Read
        // in the other order, a spent quota stops being a spent quota: it keeps its `429`, matches
        // the retryable pattern, and burns all ten attempts against an account that has none left.
        if (attemptState.attempt >= retry.attempts || !isWorthRetrying(failure, model))
            throw new Error(readableProviderError(failure.errorMessage))
        attemptState.attempt += 1
        attemptState.rateLimited ||= isRateLimited(failure.errorMessage)
        const delayMs = retryDelay(
            attemptState.attempt,
            attemptState.rateLimited ? rateLimitedBackoff(retry) : retry
        )
        // Two events, not one, because the wait is the part the user is watching: the first says how
        // long and why, the second says the wait is over and the model is being asked again. A
        // single event would leave the countdown reading "in 60s" while the retry ran.
        emit(
            retryScheduled({
                attempt: attemptState.attempt,
                maxAttempts: retry.attempts,
                delayMs,
                errorMessage: readableProviderError(failure.errorMessage)
            })
        )
        // A stop landing in the countdown is the same stop as one landing in the request, and only
        // the signal knows that: `abortableWait` rejects with its own wording, which threw straight
        // past the loop's stopped ending and out as a failed turn. This is the widest stop window a
        // turn has — `retryScheduled` puts a countdown on screen and invites the user to use it.
        await abortableWait(delayMs, signal, timers).catch(error => {
            if (!signal?.aborted) throw error
        })
        // Handed back untouched for the loop to end on. Nothing below this line belongs to a turn
        // that is over: a `retryStart` event, a dropped answer, and a resume that asks the provider
        // again are all preparation for an attempt that must not happen.
        if (signal?.aborted) return attemptState
        emit(retryStart(attemptState.attempt, retry.attempts))
        // The failed answer is taken back off first. Left on, it teaches the model that its own last
        // word was the provider's error text, and the next answer is written to match it.
        transcript.dropTrailingAnswer()
        attemptState.finalMessage = undefined
        // `continue`, not `prompt`: the prompt is already on the transcript, and asking it again
        // would put the same question in twice.
        attemptState.resume = () => agent.continue()
        return attemptState
    }

    try {
        // The order the five jobs happen in, and nothing else. Each step reads the record, decides
        // its own part, and hands it back; what the loop owns is which one goes next.
        for (;;) {
            await state.resume()
            await recoverOverflow(state)
            const verdict = await gateOnVerifyPoints(state)
            if (verdict === 'answered') break
            if (verdict === 'again') continue
            if (wasStopped(state)) break
            await classifyAndBackoff(state)
            // Asked again after the backoff as well as before it. The wait is the longest the loop
            // ever pauses, so it is where a stop most often lands.
            if (wasStopped(state)) break
        }
        const {finalMessage, verifyResults} = state
        if (finalMessage.stopReason === 'length') throw new Error(outOfRoom(finalMessage, model))
        // The answer carries its own verdict. A turn whose points went red used to end with
        // `stopReason: 'stop'` and whatever the model chose to say — measured live, that was "The
        // verification passes" four seconds after the second failure. The transcript held the truth
        // and the bubble held the opposite.
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
        // The last word on what the agent remembers, for a turn that is ending badly. The events
        // above cover the steps that finished; this covers the one that was still running.
        transcript.checkpoint()
        throw error
    } finally {
        unsubscribe()
        await env.cleanup()
    }
}
