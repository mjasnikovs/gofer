import {piThinkingLevelMap} from './thinking-level.mjs'

export const DEFAULT_CONTEXT_WINDOW = 120_064

const FREE = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}

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
        ...(thinkingLevelMap ? {thinkingLevelMap} : {}),
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: chosen.supportsReasoningEffort ?? false,
            ...(connection.chatTemplateThinking ?
                {
                    thinkingFormat: 'chat-template',
                    chatTemplateKwargs: {
                        enable_thinking: {$var: 'thinking.enabled'},
                        preserve_thinking: true,
                        ...(chosen.supportsReasoningEffort ?
                            {reasoning_effort: {$var: 'thinking.effort', omitWhenOff: true}}
                        :   {})
                    }
                }
            :   {}),
            sendSessionAffinityHeaders: sessionAffinity
        }
    }
}
