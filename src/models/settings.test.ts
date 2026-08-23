import {describe, expect, it} from 'vitest'
import {
    adoptModelReasoning,
    thinkingLevelsFor,
    adoptSubagentReasoning,
    apiKeyUpdate,
    applySubagentModel,
    cacheStateLabel,
    cacheStateVariant,
    compactionLabel,
    connectionNotice,
    formatBytes,
    normalizeSettings,
    progressLabel,
    progressValue,
    OPENROUTER_BASE_URL,
    driverOptions,
    selectAiDriver,
    startSubagentConnection
} from './settings'
import {DEFAULT_SUBAGENT_SETTINGS, DEFAULT_WEB_SETTINGS} from './settings'
import type {GoferSettings} from './settings'

/** What a ChatGPT connection is, as the backend sends it. Never invented in the renderer. */
const chatgptProfile = {
    name: 'ChatGPT subscription',
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-5.6-terra',
    api: 'openai-codex-responses',
    modelName: 'GPT-5.6 Terra',
    contextWindow: 272_000,
    maxTokens: 128_000,
    reasoning: true,
    supportsReasoningEffort: true,
    thinkingLevels: [],
    input: ['text', 'image'],
    thinkingLevel: 'high'
} as const

/** A settings file written before the connection fields existed: version and the four originals. */
const stored = {
    version: 1,
    ai: {
        connectionType: 'openai-compatible',
        name: 'Local AI',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'local-model',
        api: 'openai-completions',
        chatgpt: chatgptProfile
    }
} as unknown as GoferSettings

describe('normalizeSettings', () => {
    it('fills in the fields an older settings file never stored', () => {
        expect(normalizeSettings(stored).ai).toEqual({
            connectionType: 'openai-compatible',
            name: 'Local AI',
            baseUrl: 'http://127.0.0.1:8080/v1',
            model: 'local-model',
            api: 'openai-completions',
            modelName: 'local-model',
            contextWindow: 120_064,
            maxTokens: 120_064,
            reasoning: false,
            supportsReasoningEffort: false,
            chatTemplateThinking: false,
            thinkingLevels: [],
            input: ['text'],
            thinkingLevel: 'off',
            maxRetries: 2,
            timeoutMs: 120_000,
            compactionPercent: 86,
            subagent: DEFAULT_SUBAGENT_SETTINGS,
            web: DEFAULT_WEB_SETTINGS,
            local: {
                name: 'Local AI',
                baseUrl: 'http://127.0.0.1:8080/v1',
                model: 'local-model',
                api: 'openai-completions',
                modelName: 'local-model',
                contextWindow: 120_064,
                maxTokens: 120_064,
                reasoning: false,
                supportsReasoningEffort: false,
                chatTemplateThinking: false,
                thinkingLevels: [],
                input: ['text'],
                thinkingLevel: 'off'
            },
            chatgpt: chatgptProfile
        })
    })

    it('offers no ChatGPT driver when the backend sent no profile for one', () => {
        const {chatgpt: _sent, ...ai} = stored.ai
        const normalized = normalizeSettings({...stored, ai})

        expect(normalized.ai.chatgpt).toBeUndefined()
        expect(normalized.ai.local?.baseUrl).toBe('http://127.0.0.1:8080/v1')
    })

    it('fills in one missing sub-agent bound without losing the ones beside it', () => {
        // The sub-agent section is nested, and the merge above is shallow. A section stored with
        // one bound missing used to arrive with that bound undefined, and an undefined ceiling is
        // no ceiling: the sub-agent would have run with no answer limit at all.
        const normalized = normalizeSettings({
            ...stored,
            ai: {...stored.ai, subagent: {maxTurns: 3}}
        } as unknown as GoferSettings)

        expect(normalized.ai.subagent.maxTurns).toBe(3)
        expect(normalized.ai.subagent.maxAnswerChars).toBe(DEFAULT_SUBAGENT_SETTINGS.maxAnswerChars)
        expect(normalized.ai.subagent.commandTimeoutMinutes).toBe(
            DEFAULT_SUBAGENT_SETTINGS.commandTimeoutMinutes
        )
    })

    it('leaves a stored value alone rather than replacing it with the default', () => {
        const normalized = normalizeSettings({
            ...stored,
            ai: {...stored.ai, thinkingLevel: 'high', compactionPercent: 100, contextWindow: 8192}
        })

        expect(normalized.ai.thinkingLevel).toBe('high')
        expect(normalized.ai.compactionPercent).toBe(100)
        expect(normalized.ai.contextWindow).toBe(8192)
    })
})

describe('the sub-agent connection', () => {
    it('is absent for a settings file that predates it, which means "whatever the parent uses"', () => {
        expect(normalizeSettings(stored).ai.subagent.connection).toBeUndefined()
    })

    it('starts on the model the chosen driver is already configured with', () => {
        const ai = normalizeSettings(stored).ai

        expect(startSubagentConnection(ai, 'openai-codex')).toEqual({
            connectionType: 'openai-codex',
            model: 'gpt-5.6-terra',
            modelName: 'GPT-5.6 Terra',
            contextWindow: 272_000,
            maxTokens: 128_000,
            reasoning: true,
            supportsReasoningEffort: true,
            thinkingLevels: [],
            input: ['text', 'image'],
            thinkingLevel: 'high'
        })
    })

    it('offers no driver the settings file has never held a connection for', () => {
        const {chatgpt: _sent, ...ai} = stored.ai
        const withoutChatgpt = normalizeSettings({...stored, ai}).ai

        expect(startSubagentConnection(withoutChatgpt, 'openai-codex')).toBeUndefined()
        expect(startSubagentConnection(withoutChatgpt, 'openai-compatible')).toBeDefined()
    })

    it('carries the chosen model limits, and drops a level the model cannot be asked at', () => {
        const ai = normalizeSettings(stored).ai
        const connection = startSubagentConnection(ai, 'openai-codex')
        if (!connection) throw new Error('the ChatGPT connection')

        const smaller = applySubagentModel(connection, {
            id: 'gpt-5.4-mini',
            name: 'GPT-5.4 mini',
            contextWindow: 272_000,
            maxTokens: 128_000,
            reasoning: false,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text']
        })

        expect(smaller.model).toBe('gpt-5.4-mini')
        expect(smaller.maxTokens).toBe(128_000)
        expect(smaller.thinkingLevel).toBe('off')
        // And the connection it is served by is the child's own, untouched by the model.
        expect(smaller.connectionType).toBe('openai-codex')
    })
})

describe('thinkingLevelsFor', () => {
    /*
     * All four cases are real, and all four were measured against one machine running two Qwen
     * builds in turn. The Q3.6 template preserves reasoning and names no efforts. The Q3.8 one
     * names three — and answers HTTP 500 to the four Gofer knows that it does not.
     */
    it('offers exactly what the server named, and off', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: true,
                thinkingLevels: ['low', 'medium', 'xhigh']
            })
        ).toEqual(['off', 'low', 'medium', 'xhigh'])
    })

    it('offers on and off to a model that thinks without named efforts', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: false,
                thinkingLevels: []
            })
        ).toEqual(['off', 'on'])
    })

    it('offers every level to a model nobody has asked about', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: true,
                thinkingLevels: []
            })
        ).toHaveLength(7)
    })

    it('offers nothing but off to a model that does not think', () => {
        expect(
            thinkingLevelsFor({
                reasoning: false,
                supportsReasoningEffort: true,
                thinkingLevels: ['low']
            })
        ).toEqual(['off'])
    })
})

describe('adoptModelReasoning', () => {
    /*
     * The regression. A local server names its model after the file it was started with, which is
     * not the id Pi's catalogue names the same model by, so `reasoning: false` was written to the
     * settings file and the reasoning menu offered `off` and nothing else — forever, because
     * nothing ever re-read the model's facts once it was the chosen one.
     */
    it('turns a level on for a model that turns out to reason', () => {
        const ai = normalizeSettings(stored).ai
        expect(ai.reasoning).toBe(false)

        const adopted = adoptModelReasoning(ai, {
            id: 'local-model',
            name: 'Local model',
            contextWindow: 8_192,
            maxTokens: 4_096,
            reasoning: true,
            supportsReasoningEffort: true,
            thinkingLevels: [],
            input: ['text']
        })

        expect(adopted.reasoning).toBe(true)
        expect(adopted.supportsReasoningEffort).toBe(true)
        expect(adopted.local?.reasoning).toBe(true)
        // What the user typed is theirs. Only what the model decides is re-read.
        expect(adopted.contextWindow).toBe(ai.contextWindow)
        expect(adopted.model).toBe('local-model')
    })

    it('takes the level away from a model that turns out not to', () => {
        const ai = {
            ...normalizeSettings(stored).ai,
            reasoning: true,
            thinkingLevel: 'high'
        } as const
        const adopted = adoptModelReasoning(ai, {
            id: 'local-model',
            name: 'Local model',
            contextWindow: 8_192,
            maxTokens: 4_096,
            reasoning: false,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text']
        })

        expect(adopted.reasoning).toBe(false)
        expect(adopted.thinkingLevel).toBe('off')
        expect(adopted.local?.thinkingLevel).toBe('off')
    })

    /*
     * The second half of the same regression. A chat template can have a place for thinking and no
     * levels to be asked at — llama.cpp reports exactly that pair for a Qwen build. Keeping a level
     * because the model reasons left `Reasoning: medium` on screen for a model that has no medium.
     */
    it('keeps on for a model that thinks but cannot be told how hard', () => {
        const ai = {
            ...normalizeSettings(stored).ai,
            reasoning: true,
            supportsReasoningEffort: true,
            thinkingLevel: 'high'
        } as const
        const model = {
            id: 'local-model',
            name: 'Local model',
            contextWindow: 8_192,
            maxTokens: 4_096,
            reasoning: true,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text']
        } as const

        // `high` is not one of the two it offers, so it goes.
        const dropped = adoptModelReasoning(ai, model)
        expect(dropped.reasoning).toBe(true)
        expect(dropped.supportsReasoningEffort).toBe(false)
        expect(dropped.thinkingLevel).toBe('off')
        expect(dropped.local?.thinkingLevel).toBe('off')

        // `on` is, so it stays. Thinking is not taken away from a model that thinks.
        const kept = adoptModelReasoning({...ai, thinkingLevel: 'on'}, model)
        expect(kept.thinkingLevel).toBe('on')
        expect(kept.local?.thinkingLevel).toBe('on')
    })

    it('is the same object when the catalogue says what the settings already said', () => {
        const ai = normalizeSettings(stored).ai

        expect(
            adoptModelReasoning(ai, {
                id: 'local-model',
                name: 'Local model',
                contextWindow: 8_192,
                maxTokens: 4_096,
                reasoning: false,
                supportsReasoningEffort: false,
                thinkingLevels: [],
                input: ['text']
            })
        ).toBe(ai)
    })
})

describe('adoptSubagentReasoning', () => {
    /** The third copy, and the one that outlived the other two. Same rule, same reason. */
    it('turns a level on for a sub-agent model that turns out to reason', () => {
        const ai = normalizeSettings(stored).ai
        const connection = startSubagentConnection(ai, 'openai-compatible')
        if (!connection) throw new Error('the local connection')
        expect(connection.reasoning).toBe(false)

        const adopted = adoptSubagentReasoning(connection, {
            id: 'local-model',
            name: 'Local model',
            contextWindow: 8_192,
            maxTokens: 4_096,
            reasoning: true,
            supportsReasoningEffort: true,
            thinkingLevels: [],
            input: ['text']
        })

        expect(adopted.reasoning).toBe(true)
        expect(adopted.supportsReasoningEffort).toBe(true)
        // The connection it is served by is still the child's own, and its limits are untouched.
        expect(adopted.connectionType).toBe('openai-compatible')
        expect(adopted.contextWindow).toBe(connection.contextWindow)
    })

    it('takes the level away from a sub-agent model that turns out not to', () => {
        const ai = normalizeSettings(stored).ai
        const connection = startSubagentConnection(ai, 'openai-codex')
        if (!connection) throw new Error('the ChatGPT connection')
        expect(connection.thinkingLevel).toBe('high')

        const adopted = adoptSubagentReasoning(connection, {
            id: 'gpt-5.4-mini',
            name: 'GPT-5.4 mini',
            contextWindow: 272_000,
            maxTokens: 128_000,
            reasoning: false,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text']
        })

        expect(adopted.reasoning).toBe(false)
        expect(adopted.thinkingLevel).toBe('off')
    })

    it('is the same object when the catalogue says what the connection already said', () => {
        const ai = normalizeSettings(stored).ai
        const connection = startSubagentConnection(ai, 'openai-codex')
        if (!connection) throw new Error('the ChatGPT connection')

        expect(
            adoptSubagentReasoning(connection, {
                id: 'gpt-5.6-terra',
                name: 'GPT-5.6 Terra',
                contextWindow: 272_000,
                maxTokens: 128_000,
                reasoning: true,
                supportsReasoningEffort: true,
                thinkingLevels: [],
                input: ['text', 'image']
            })
        ).toBe(connection)
    })
})

describe('selectAiDriver', () => {
    it('preserves each driver model while switching between them', () => {
        const local = normalizeSettings(stored).ai
        const chatgpt = selectAiDriver(local, 'openai-codex')
        const selectedChatgpt = {...chatgpt, model: 'gpt-5.5', modelName: 'GPT-5.5'}
        const backToLocal = selectAiDriver(selectedChatgpt, 'openai-compatible')
        const backToChatgpt = selectAiDriver(backToLocal, 'openai-codex')

        expect(backToLocal.model).toBe('local-model')
        expect(backToChatgpt.model).toBe('gpt-5.5')
        expect(backToChatgpt.modelName).toBe('GPT-5.5')
    })
})

describe('selectAiDriver across three drivers', () => {
    it('keeps every driver its own model while moving between all of them', () => {
        const openrouterProfile = {
            ...chatgptProfile,
            chatTemplateThinking: false,
            name: 'OpenRouter',
            baseUrl: OPENROUTER_BASE_URL,
            model: 'nvidia/nemotron-3.5-lightning:free',
            modelName: 'Nemotron 3.5 Lightning',
            api: 'openai-completions'
        } as const
        const start = {...normalizeSettings(stored).ai, openrouter: openrouterProfile}

        const onOpenrouter = selectAiDriver(start, 'openrouter')
        const onChatgpt = selectAiDriver(onOpenrouter, 'openai-codex')
        const backToLocal = selectAiDriver(onChatgpt, 'openai-compatible')
        const backToOpenrouter = selectAiDriver(backToLocal, 'openrouter')

        expect(onOpenrouter.model).toBe('nvidia/nemotron-3.5-lightning:free')
        expect(onOpenrouter.baseUrl).toBe(OPENROUTER_BASE_URL)
        expect(backToLocal.model).toBe('local-model')
        expect(backToOpenrouter.model).toBe('nvidia/nemotron-3.5-lightning:free')
        // The two it passed through on the way are still there to go back to.
        expect(backToOpenrouter.local?.model).toBe('local-model')
        expect(backToOpenrouter.chatgpt?.model).toBe(chatgptProfile.model)
    })

    it('offers a configured OpenRouter connection in the picker', () => {
        const ai = {
            ...normalizeSettings(stored).ai,
            openrouter: {...chatgptProfile, chatTemplateThinking: false}
        }
        expect(driverOptions(ai).map(option => option.value)).toEqual([
            'openai-compatible',
            'openai-codex',
            'openrouter'
        ])
    })
})

describe('driverOptions', () => {
    it('offers only the drivers that have somewhere to run', () => {
        const both = normalizeSettings(stored).ai
        expect(driverOptions(both)).toEqual([
            {value: 'openai-compatible', label: 'Local model'},
            {value: 'openai-codex', label: 'ChatGPT subscription'}
        ])
    })

    it('leaves out a driver nobody has configured', () => {
        const localOnly = {...normalizeSettings(stored).ai, chatgpt: undefined}
        expect(driverOptions(localOnly)).toEqual([
            {value: 'openai-compatible', label: 'Local model'}
        ])
    })
})

describe('formatBytes', () => {
    it('names each size in the unit a reader can hold', () => {
        expect(formatBytes(0)).toBe('0 bytes')
        expect(formatBytes(2048)).toBe('2 KiB')
        expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MiB')
        expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GiB')
    })
})

describe('download progress', () => {
    it('prefers the reported percentage and holds it inside the bar', () => {
        expect(progressValue({model: 'bge', status: 'progress', progress: 42})).toBe(42)
        expect(progressValue({model: 'bge', status: 'progress', progress: 140})).toBe(100)
        expect(progressValue({model: 'bge', status: 'progress', progress: -5})).toBe(0)
    })

    it('works the percentage out from the bytes when none was reported', () => {
        expect(progressValue({model: 'bge', status: 'progress', loaded: 50, total: 200})).toBe(25)
    })

    it('reports no percentage when there is nothing to divide', () => {
        expect(progressValue()).toBeUndefined()
        expect(progressValue({model: 'bge', status: 'initiate'})).toBeUndefined()
        expect(
            progressValue({model: 'bge', status: 'progress', loaded: 50, total: 0})
        ).toBeUndefined()
    })

    it('says which model is downloading and how far it has got', () => {
        expect(progressLabel()).toBe('Preparing model download…')
        expect(
            progressLabel({model: 'bge-m3', status: 'progress', loaded: 2048, total: 4096})
        ).toBe('bge-m3: 2 KiB of 4 KiB')
        expect(progressLabel({model: 'bge-m3', status: 'initiate'})).toBe('bge-m3: initiate')
    })
})

describe('compactionLabel', () => {
    it('says where in this connection window the summarising starts', () => {
        expect(compactionLabel(120_064)(86)).toBe(`86% · ${(103_255).toLocaleString()} tokens`)
        expect(compactionLabel(8192)(50)).toBe(`50% · ${(4096).toLocaleString()} tokens`)
    })

    it('says the slider is off rather than naming a token count nothing uses', () => {
        expect(compactionLabel(120_064)(100)).toBe('Off · never summarise')
    })
})

describe('apiKeyUpdate', () => {
    it('sends the key only when the user typed one', () => {
        expect(apiKeyUpdate('set', ' secret ')).toEqual({action: 'set', value: ' secret '})
        expect(apiKeyUpdate('clear', 'secret')).toEqual({action: 'clear'})
        expect(apiKeyUpdate('keep', 'secret')).toEqual({action: 'keep'})
    })
})

describe('cache state', () => {
    it('names every state and gives it the badge that reads right', () => {
        expect(cacheStateLabel('installed')).toBe('Installed')
        expect(cacheStateLabel('incomplete')).toBe('Incomplete')
        expect(cacheStateLabel('busy')).toBe('Busy')
        expect(cacheStateLabel('not-installed')).toBe('Not installed')
        expect(cacheStateVariant('installed')).toBe('success')
        expect(cacheStateVariant('incomplete')).toBe('warning')
        expect(cacheStateVariant('busy')).toBe('warning')
        expect(cacheStateVariant('not-installed')).toBe('neutral')
    })
})

describe('connectionNotice', () => {
    it('turns every test result into a notice that says what to do about it', () => {
        expect(connectionNotice({status: 'connected', message: 'Connected.'})).toEqual({
            status: 'success',
            title: 'AI connection works',
            description: 'Connected.'
        })
        expect(connectionNotice({status: 'model-unavailable', message: 'No such model.'})).toEqual({
            status: 'warning',
            title: 'Configured model is unavailable',
            description: 'No such model.'
        })
        expect(connectionNotice({status: 'unauthorized', message: 'Bad key.'})).toEqual({
            status: 'error',
            title: 'Authentication failed',
            description: 'Bad key.'
        })
        expect(connectionNotice({status: 'server-unreachable', message: 'No route.'})).toEqual({
            status: 'error',
            title: 'AI server is unreachable',
            description: 'No route.'
        })
        expect(connectionNotice({status: 'server-error', message: 'HTTP 500.'})).toEqual({
            status: 'error',
            title: 'AI server returned an error',
            description: 'HTTP 500.'
        })
    })
})
