import {describe, expect, it} from 'vitest'
import corpus from '../../fixtures/thinking-levels.json'
import {
    adoptModelReasoning,
    adoptSubagentReasoning,
    keepThinkingLevel,
    thinkingLevelsFor,
    activeConnection,
    apiKeyUpdate,
    applyModelSelection,
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
import {
    AI_CONNECTION_LABELS,
    AI_CONNECTION_TYPES,
    DEFAULT_SUBAGENT_SETTINGS,
    DEFAULT_WEB_SETTINGS
} from './settings'
import type {AiConnectionProfile, AiModelOption, GoferSettings, ThinkingLevel} from './settings'

const chatgptConnection: AiConnectionProfile = {
    name: 'ChatGPT subscription',
    baseUrl: 'https://chatgpt.com/backend-api',
    api: 'openai-codex-responses',
    chatTemplateThinking: false,
    model: {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        contextWindow: 272_000,
        maxTokens: 128_000,
        reasoning: true,
        supportsReasoningEffort: true,
        reasoningMandatory: false,
        thinkingLevels: [],
        input: ['text', 'image'],
        thinkingLevel: 'high'
    }
}

const localConnection: AiConnectionProfile = {
    name: 'Local AI',
    baseUrl: 'http://127.0.0.1:8080/v1',
    api: 'openai-completions',
    chatTemplateThinking: false,
    model: {
        id: 'local-model',
        name: 'local-model',
        contextWindow: 120_064,
        maxTokens: 120_064,
        reasoning: false,
        supportsReasoningEffort: false,
        reasoningMandatory: false,
        thinkingLevels: [],
        input: ['text'],
        thinkingLevel: 'off'
    }
}

const stored = {
    version: 2,
    ai: {
        connectionType: 'local',
        connections: {local: localConnection, 'openai-codex': chatgptConnection},
        maxRetries: 2,
        timeoutMs: 120_000,
        compactionPercent: 86
    }
} as unknown as GoferSettings

function option(facts: Partial<AiModelOption> = {}): AiModelOption {
    return {
        id: 'local-model',
        name: 'Local model',
        contextWindow: 8_192,
        maxTokens: 4_096,
        reasoning: false,
        supportsReasoningEffort: false,
        reasoningMandatory: false,
        thinkingLevels: [],
        input: ['text'],
        ...facts
    }
}

describe('normalizeSettings', () => {
    it('fills in the sections an older settings file never stored', () => {
        const normalized = normalizeSettings(stored).ai

        expect(normalized.subagent).toEqual(DEFAULT_SUBAGENT_SETTINGS)
        expect(normalized.web).toEqual(DEFAULT_WEB_SETTINGS)
        expect(normalized.connections).toEqual({
            local: localConnection,
            'openai-codex': chatgptConnection
        })
    })

    it('offers no ChatGPT driver when the backend sent no connection for one', () => {
        const normalized = normalizeSettings({
            ...stored,
            ai: {...stored.ai, connections: {local: localConnection}}
        }).ai

        expect(normalized.connections['openai-codex']).toBeUndefined()
        expect(activeConnection(normalized)?.baseUrl).toBe('http://127.0.0.1:8080/v1')
    })

    it('fills in one missing sub-agent bound without losing the ones beside it', () => {
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
            ai: {...stored.ai, compactionPercent: 100}
        })

        expect(normalized.ai.compactionPercent).toBe(100)
        expect(activeConnection(normalized.ai)?.model.contextWindow).toBe(120_064)
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
            model: chatgptConnection.model
        })
    })

    it('offers no driver the settings file has never held a connection for', () => {
        const withoutChatgpt = normalizeSettings({
            ...stored,
            ai: {...stored.ai, connections: {local: localConnection}}
        }).ai

        expect(startSubagentConnection(withoutChatgpt, 'openai-codex')).toBeUndefined()
        expect(startSubagentConnection(withoutChatgpt, 'local')).toBeDefined()
    })

    it('carries the chosen model limits, and drops a level the model cannot be asked at', () => {
        const ai = normalizeSettings(stored).ai
        const connection = startSubagentConnection(ai, 'openai-codex')
        if (!connection) throw new Error('the ChatGPT connection')

        const smaller = applyModelSelection(
            connection.model,
            option({id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', maxTokens: 128_000})
        )

        expect(smaller.id).toBe('gpt-5.4-mini')
        expect(smaller.maxTokens).toBe(128_000)
        expect(smaller.thinkingLevel).toBe('off')
        expect(connection.connectionType).toBe('openai-codex')
    })
})

describe('adoptSubagentReasoning', () => {
    const listed = {
        id: 'stealth/ox-alpha',
        name: 'Ox Alpha',
        contextWindow: 1048576,
        maxTokens: 131072,
        reasoning: true,
        supportsReasoningEffort: true,
        reasoningMandatory: true,
        thinkingLevels: ['max' as const, 'high' as const, 'low' as const],
        input: ['text']
    }
    const base = {
        connectionType: 'openrouter' as const,
        connections: {},
        maxRetries: 2,
        timeoutMs: 120_000,
        compactionPercent: 85,
        subagent: DEFAULT_SUBAGENT_SETTINGS,
        web: DEFAULT_WEB_SETTINGS
    }
    const withChild = (overrides: Partial<typeof listed>, level: ThinkingLevel) => ({
        ...base,
        subagent: {
            ...DEFAULT_SUBAGENT_SETTINGS,
            connection: {
                connectionType: 'openrouter' as const,
                model: {...listed, ...overrides, thinkingLevel: level}
            }
        }
    })

    it('re-reads the sub-agent model and moves it off a level it cannot use', () => {
        const ai = withChild({reasoningMandatory: false}, 'off')
        const adopted = adoptSubagentReasoning(ai, 'openrouter', [listed])
        expect(adopted.subagent.connection?.model.reasoningMandatory).toBe(true)
        expect(adopted.subagent.connection?.model.thinkingLevel).toBe('low')
    })

    it('leaves the sub-agent alone when it is on another connection', () => {
        const ai = {
            ...withChild({reasoningMandatory: false}, 'off'),
            subagent: {
                ...DEFAULT_SUBAGENT_SETTINGS,
                connection: {
                    connectionType: 'local' as const,
                    model: {...listed, reasoningMandatory: false, thinkingLevel: 'off' as const}
                }
            }
        }
        expect(adoptSubagentReasoning(ai, 'openrouter', [listed])).toBe(ai)
    })

    it('costs no write when the catalogue says what the file already said', () => {
        const ai = withChild({}, 'low')
        expect(adoptSubagentReasoning(ai, 'openrouter', [listed])).toBe(ai)
    })

    it('leaves a model the catalogue did not name alone', () => {
        const ai = withChild({reasoningMandatory: false}, 'off')
        expect(adoptSubagentReasoning(ai, 'openrouter', [{...listed, id: 'someone/else'}])).toBe(ai)
    })
})

/** One model's thinking facts, as `fixtures/thinking-levels.json` writes them down. */
type ThinkingLevelModel = Readonly<{
    reasoning: boolean
    supportsReasoningEffort: boolean
    reasoningMandatory: boolean
    thinkingLevels: readonly ThinkingLevel[]
}>

type ThinkingLevelRow = Readonly<{
    name: string
    model: ThinkingLevelModel
    offered: readonly ThinkingLevel[]
    kept: readonly Readonly<{stored: ThinkingLevel; is: ThinkingLevel}>[]
}>

const THINKING_LEVEL_ROWS = corpus.rows as readonly ThinkingLevelRow[]

describe('thinkingLevelsFor', () => {
    /**
     * One rule in two languages, held to the corpus both of them read.
     *
     * `keep_level` and `thinking_levels` in `src-tauri/src/settings/mod.rs` are the Rust copies,
     * and the two used to be held together by a prose comment in each saying the other agreed.
     * Rust asserts every row of this file too, so a divergence fails a test rather than quietly
     * downgrading a stored setting on the next save.
     */
    it('answers every row of the corpus Rust reads', () => {
        expect(THINKING_LEVEL_ROWS.length).toBeGreaterThan(5)
        for (const row of THINKING_LEVEL_ROWS) {
            expect(thinkingLevelsFor(row.model), row.name).toEqual(row.offered)
            for (const kept of row.kept)
                expect(
                    keepThinkingLevel(row.model, kept.stored),
                    `${row.name}: ${kept.stored}`
                ).toBe(kept.is)
        }
    })

    it('offers exactly what the server named, and off', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: true,
                reasoningMandatory: false,
                thinkingLevels: ['low', 'medium', 'xhigh']
            })
        ).toEqual(['off', 'low', 'medium', 'xhigh'])
    })

    it('does not offer off to a model that refuses to stop thinking', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: true,
                reasoningMandatory: true,
                thinkingLevels: ['max', 'high', 'low']
            })
        ).toEqual(['max', 'high', 'low'])
    })

    it('does not offer off to a mandatory model that named no efforts either', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: true,
                reasoningMandatory: true,
                thinkingLevels: []
            })
        ).not.toContain('off')
    })

    it('falls back to a level the model has, not to off', () => {
        const mandatory = {
            reasoning: true,
            supportsReasoningEffort: true,
            reasoningMandatory: true,
            thinkingLevels: ['max' as const, 'high' as const, 'low' as const]
        }
        expect(keepThinkingLevel(mandatory, 'off')).toBe('low')
        expect(keepThinkingLevel(mandatory, 'medium')).toBe('low')
        expect(keepThinkingLevel(mandatory, 'low')).toBe('low')
    })

    it('still falls back to off wherever off is a level', () => {
        expect(
            keepThinkingLevel(
                {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    reasoningMandatory: false,
                    thinkingLevels: ['low', 'medium']
                },
                'max'
            )
        ).toBe('off')
    })

    it('offers on and off to a model that thinks without named efforts', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: false,
                reasoningMandatory: false,
                thinkingLevels: []
            })
        ).toEqual(['off', 'on'])
    })

    it('offers every level to a model nobody has asked about', () => {
        expect(
            thinkingLevelsFor({
                reasoning: true,
                supportsReasoningEffort: true,
                reasoningMandatory: false,
                thinkingLevels: []
            })
        ).toHaveLength(7)
    })

    it('offers nothing but off to a model that does not think', () => {
        expect(
            thinkingLevelsFor({
                reasoning: false,
                supportsReasoningEffort: true,
                reasoningMandatory: false,
                thinkingLevels: ['low']
            })
        ).toEqual(['off'])
    })
})

describe('a listing that only names its models', () => {
    // The OpenAI-compatible driver's facts are typed, and its listing carries the saved copy back.
    // Adopting that copy reverts whatever was typed while the listing was on the wire.
    const typed = {
        ...localConnection.model,
        reasoning: true,
        supportsReasoningEffort: true,
        contextWindow: 262_144,
        thinkingLevel: 'medium'
    } as const
    const named = option({id: 'qwen3.8-flash', name: 'qwen3.8-flash', namesOnly: true})

    it('changes nothing at all when it is adopted', () => {
        expect(adoptModelReasoning(typed, named)).toBe(typed)
    })

    it('changes only which model is chosen when one is picked from it', () => {
        const picked = applyModelSelection(typed, named)

        expect(picked.id).toBe('qwen3.8-flash')
        expect(picked.contextWindow).toBe(262_144)
        expect(picked.reasoning).toBe(true)
        expect(picked.supportsReasoningEffort).toBe(true)
        expect(picked.thinkingLevel).toBe('medium')
    })
})

describe('adoptModelReasoning', () => {
    it('turns a level on for a model that turns out to reason', () => {
        const chosen = localConnection.model
        expect(chosen.reasoning).toBe(false)

        const adopted = adoptModelReasoning(
            chosen,
            option({reasoning: true, supportsReasoningEffort: true})
        )

        expect(adopted.reasoning).toBe(true)
        expect(adopted.supportsReasoningEffort).toBe(true)
        expect(adopted.contextWindow).toBe(chosen.contextWindow)
        expect(adopted.id).toBe('local-model')
    })

    it('takes the level away from a model that turns out not to', () => {
        const chosen = {...localConnection.model, reasoning: true, thinkingLevel: 'high'} as const

        const adopted = adoptModelReasoning(chosen, option())

        expect(adopted.reasoning).toBe(false)
        expect(adopted.thinkingLevel).toBe('off')
    })

    it('keeps on for a model that thinks but cannot be told how hard', () => {
        const chosen = {
            ...localConnection.model,
            reasoning: true,
            supportsReasoningEffort: true,
            reasoningMandatory: false,
            thinkingLevel: 'high'
        } as const
        const model = option({reasoning: true, supportsReasoningEffort: false})

        const dropped = adoptModelReasoning(chosen, model)
        expect(dropped.reasoning).toBe(true)
        expect(dropped.supportsReasoningEffort).toBe(false)
        expect(dropped.thinkingLevel).toBe('off')

        const kept = adoptModelReasoning({...chosen, thinkingLevel: 'on'}, model)
        expect(kept.thinkingLevel).toBe('on')
    })

    it('is the same object when the catalogue says what the settings already said', () => {
        const chosen = localConnection.model

        expect(adoptModelReasoning(chosen, option())).toBe(chosen)
    })

    it("corrects the sub-agent's model with no second copy of the rule", () => {
        const connection = startSubagentConnection(normalizeSettings(stored).ai, 'openai-codex')
        if (!connection) throw new Error('the ChatGPT connection')
        expect(connection.model.thinkingLevel).toBe('high')

        const adopted = adoptModelReasoning(
            connection.model,
            option({id: 'gpt-5.4-mini', name: 'GPT-5.4 mini'})
        )

        expect(adopted.reasoning).toBe(false)
        expect(adopted.thinkingLevel).toBe('off')
        expect(adopted.contextWindow).toBe(connection.model.contextWindow)
    })
})

describe('selectAiDriver', () => {
    it('preserves each driver model while switching between them', () => {
        const local = normalizeSettings(stored).ai
        const chatgpt = selectAiDriver(local, 'openai-codex')
        const backToLocal = selectAiDriver(chatgpt, 'local')
        const backToChatgpt = selectAiDriver(backToLocal, 'openai-codex')

        expect(activeConnection(backToLocal)?.model.id).toBe('local-model')
        expect(activeConnection(backToChatgpt)?.model.id).toBe('gpt-5.6-terra')
        expect(activeConnection(backToChatgpt)?.model.name).toBe('GPT-5.6 Terra')
    })

    it('does not switch to a driver that has nowhere to run', () => {
        const localOnly = normalizeSettings({
            ...stored,
            ai: {...stored.ai, connections: {local: localConnection}}
        }).ai

        expect(selectAiDriver(localOnly, 'openai-codex')).toBe(localOnly)
    })
})

describe('selectAiDriver across three drivers', () => {
    it('keeps every driver its own model while moving between all of them', () => {
        const openrouterConnection: AiConnectionProfile = {
            ...chatgptConnection,
            name: 'OpenRouter',
            baseUrl: OPENROUTER_BASE_URL,
            api: 'openai-completions',
            model: {
                ...chatgptConnection.model,
                id: 'nvidia/nemotron-3.5-lightning:free',
                name: 'Nemotron 3.5 Lightning'
            }
        }
        const start = {
            ...normalizeSettings(stored).ai,
            connections: {
                ...normalizeSettings(stored).ai.connections,
                openrouter: openrouterConnection
            }
        }

        const onOpenrouter = selectAiDriver(start, 'openrouter')
        const onChatgpt = selectAiDriver(onOpenrouter, 'openai-codex')
        const backToLocal = selectAiDriver(onChatgpt, 'local')
        const backToOpenrouter = selectAiDriver(backToLocal, 'openrouter')

        expect(activeConnection(onOpenrouter)?.model.id).toBe('nvidia/nemotron-3.5-lightning:free')
        expect(activeConnection(onOpenrouter)?.baseUrl).toBe(OPENROUTER_BASE_URL)
        expect(activeConnection(backToLocal)?.model.id).toBe('local-model')
        expect(activeConnection(backToOpenrouter)?.model.id).toBe(
            'nvidia/nemotron-3.5-lightning:free'
        )
        expect(backToOpenrouter.connections.local).toEqual(localConnection)
        expect(backToOpenrouter.connections['openai-codex']).toEqual(chatgptConnection)
    })

    it('offers a configured OpenRouter connection in the picker', () => {
        const ai = normalizeSettings({
            ...stored,
            ai: {
                ...stored.ai,
                connections: {...stored.ai.connections, openrouter: chatgptConnection}
            }
        }).ai
        expect(driverOptions(ai).map(offered => offered.value)).toEqual([
            'local',
            'openai-codex',
            'openrouter'
        ])
    })
})

describe('driverOptions', () => {
    it('offers only the drivers that have somewhere to run', () => {
        const both = normalizeSettings(stored).ai
        expect(driverOptions(both)).toEqual([
            {value: 'local', label: 'Local model'},
            {value: 'openai-codex', label: 'ChatGPT subscription'}
        ])
    })

    it('leaves out a driver nobody has configured', () => {
        const localOnly = normalizeSettings({
            ...stored,
            ai: {...stored.ai, connections: {local: localConnection}}
        }).ai
        expect(driverOptions(localOnly)).toEqual([{value: 'local', label: 'Local model'}])
    })

    it('names every driver this build knows, in the order the picker offers them', () => {
        expect(AI_CONNECTION_TYPES).toEqual([
            'local',
            'openai-compatible',
            'openai-codex',
            'openrouter',
            'qwen',
            'cerebras'
        ])
        for (const driver of AI_CONNECTION_TYPES) {
            expect(AI_CONNECTION_LABELS[driver]).toBeTruthy()
        }
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
