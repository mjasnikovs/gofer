/**
 * One connection and the model on it, as pi-ai describes a model.
 *
 * Two halves, and which half a field comes from is the whole of the split: the address, the dialect
 * and how thinking is turned on belong to the connection, and everything the model carries with it
 * belongs to the model. A sub-agent is that same pair with the second half replaced.
 *
 * Both callers that reach a model server build this, and until now both built it themselves.
 * `rag-expand.mjs` carried a copy field for field — the same `thinkingFormat: 'chat-template'`, the
 * same three kwargs, the same reason written out twice — and `rag.rs` says *"this is a second copy
 * of the worker's model builder"* three separate times, once each for `reasoning_mandatory`,
 * `thinking_levels` and `off_effort`. Three facts is what it took to notice; the fourth would have
 * been found in a live run.
 *
 * What actually differed between the two is three values, so those are the options: which provider
 * the model is registered under, whether the session travels as headers, and the token ceiling.
 * Everything else was the same sentence spelled twice.
 */

import {piThinkingLevelMap} from './thinking-level.mjs'

/** What a server that named no window is assumed to hold. */
export const DEFAULT_CONTEXT_WINDOW = 120_064

/** Costs are not modelled: every connection here is a local server or a flat subscription. */
const FREE = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}

/**
 * @param connection the stored connection: `baseUrl`, `chatTemplateThinking`, and a `model`.
 * @param providerId which pi-ai provider the model is registered under.
 * @param sessionAffinity whether the session travels as request headers. Only a local server holds
 *   a KV cache one could route back to; behind a hosted address there is no such machine to reach.
 * @param maxTokens the ceiling for this call, when it is the caller's rather than the model's.
 *   Expansion wants a hundred tokens and an answer wants the window, so it is per request.
 */
export function piModel(connection, {providerId, sessionAffinity, maxTokens}) {
    const chosen = connection.model ?? {}
    const thinkingLevelMap = piThinkingLevelMap(chosen.thinkingLevels, chosen.offEffort)
    return {
        id: chosen.id,
        name: chosen.name || chosen.id,
        api: 'openai-completions',
        provider: providerId,
        baseUrl: connection.baseUrl,
        reasoning: chosen.reasoning ?? false,
        input: chosen.input ?? ['text'],
        cost: chosen.cost ?? FREE,
        contextWindow: chosen.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: maxTokens ?? chosen.maxTokens ?? chosen.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
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
            sendSessionAffinityHeaders: sessionAffinity
        }
    }
}
