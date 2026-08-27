import {describe, expect, it} from 'vitest'
import {
    INITIAL_SETTINGS_DRAFT,
    agentPromptIsDefault,
    agentPromptIsUnsaved,
    canDeleteCache,
    cacheIsBusy,
    reduce,
    runSettingsTask,
    settingsRequest
} from './settings-draft'
import type {SettingsAction, SettingsDraft, SettingsTaskAction} from './settings-draft'
import {
    DEFAULT_GODOT_SETTINGS,
    DEFAULT_SUBAGENT_SETTINGS,
    DEFAULT_WEB_SETTINGS,
    activeConnection
} from './settings'
import type {
    AgentPrompt,
    AiModelOption,
    CacheStatus,
    GoferSettings,
    ModelChoice,
    SettingsResponse
} from './settings'

const SETTINGS: GoferSettings = {
    version: 1,
    ai: {
        connectionType: 'openai-compatible',
        connections: {
            'openai-compatible': {
                name: 'Local',
                baseUrl: 'http://127.0.0.1:8080/v1',
                api: 'openai-completions',
                chatTemplateThinking: false,
                model: {
                    id: 'qwen',
                    name: 'qwen',
                    contextWindow: 32_768,
                    maxTokens: 4096,
                    reasoning: true,
                    supportsReasoningEffort: true,
                    reasoningMandatory: false,
                    thinkingLevels: [],
                    input: ['text'],
                    thinkingLevel: 'high'
                }
            }
        },
        maxRetries: 2,
        timeoutMs: 120_000,
        compactionPercent: 86,
        subagent: DEFAULT_SUBAGENT_SETTINGS,
        web: DEFAULT_WEB_SETTINGS
    },
    godot: DEFAULT_GODOT_SETTINGS
}

/** The live connection's model, which is what the AI tab's fields are about. */
function chosen(state: {settings?: GoferSettings | undefined}): ModelChoice | undefined {
    return state.settings && activeConnection(state.settings.ai)?.model
}

const CACHE: CacheStatus = {path: '/cache', sizeBytes: 1024, state: 'installed'}

const SHIPPED_PROMPT = 'You are Gofer.'
const PROMPT: AgentPrompt = {prompt: SHIPPED_PROMPT, defaultPrompt: SHIPPED_PROMPT}

const RESPONSE: SettingsResponse = {settings: SETTINGS, hasApiKey: false}

/** Applies a run of actions in order, which is the only way the page ever reaches a state. */
function apply(...actions: readonly (SettingsAction | SettingsTaskAction)[]): SettingsDraft {
    return actions.reduce(reduce, INITIAL_SETTINGS_DRAFT)
}

const loaded = apply({type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT})

describe('loading', () => {
    it('starts with nothing loaded and nothing running', () => {
        expect(INITIAL_SETTINGS_DRAFT.settings).toBeUndefined()
        expect(INITIAL_SETTINGS_DRAFT.isLoading).toBe(true)
        expect(Object.values(INITIAL_SETTINGS_DRAFT.busy)).not.toContain(true)
        expect(INITIAL_SETTINGS_DRAFT.notices).toEqual({})
        expect(INITIAL_SETTINGS_DRAFT.tab).toBe('ai')
    })

    it('fills in the defaults a stored settings file may predate', () => {
        const sparse = {version: 1, ai: {model: 'gpt'}} as unknown as GoferSettings
        const state = apply({
            type: 'loaded',
            prompt: PROMPT,
            response: {settings: sparse, hasApiKey: false},
            cache: CACHE
        })
        expect(state.settings?.ai.compactionPercent).toBe(86)
        expect(state.settings?.ai.subagent).toEqual(DEFAULT_SUBAGENT_SETTINGS)
        expect(state.isLoading).toBe(false)
    })

    // A file written before the Godot tab existed says nothing about the rules. Reading that
    // silence as "off" would quietly stop enforcing what the user never turned off.
    it('enforces both Godot rules for a file that predates them', () => {
        const sparse = {version: 1, ai: {model: 'gpt'}} as unknown as GoferSettings
        const state = apply({
            type: 'loaded',
            prompt: PROMPT,
            response: {settings: sparse, hasApiKey: false},
            cache: CACHE
        })
        expect(state.settings?.godot).toEqual({strictTyping: true, embedGameWindow: true})
    })

    it('warns when the credential store could not be reached', () => {
        const state = apply({
            type: 'loaded',
            prompt: PROMPT,
            response: {...RESPONSE, credentialStoreError: 'no keyring'},
            cache: CACHE
        })
        expect(state.notices.ai).toEqual({
            status: 'warning',
            title: 'API key storage is unavailable',
            description: 'no keyring'
        })
    })

    it('stops loading without settings when there is no backend', () => {
        const notice = {status: 'warning', title: 'Desktop app required', description: 'x'} as const
        const state = apply({type: 'unavailable', notice})
        expect(state.isLoading).toBe(false)
        expect(state.settings).toBeUndefined()
        expect(state.notices.ai).toBe(notice)
    })
})

describe('the request the page would send', () => {
    it('is nothing at all until settings have loaded', () => {
        expect(settingsRequest(INITIAL_SETTINGS_DRAFT)).toBeUndefined()
    })

    it('keeps the stored key when the field was left empty', () => {
        expect(settingsRequest(loaded)?.apiKey).toEqual({action: 'keep'})
    })

    it('sets the key the user typed', () => {
        const state = reduce(loaded, {type: 'key-typed', secret: 'ai-default', value: 'sk-1'})
        expect(settingsRequest(state)?.apiKey).toEqual({action: 'set', value: 'sk-1'})
    })

    it('keeps rather than clears when the typed key is erased again', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'key-typed', secret: 'ai-default', value: 'sk-1'},
            {type: 'key-typed', secret: 'ai-default', value: '   '}
        )
        expect(settingsRequest(state)?.apiKey).toEqual({action: 'keep'})
    })

    it('clears only when the removal button was pressed, and un-clears on a second press', () => {
        const cleared = reduce(loaded, {type: 'key-removal-toggled', secret: 'ai-default'})
        expect(settingsRequest(cleared)?.apiKey).toEqual({action: 'clear'})
        const kept = reduce(cleared, {type: 'key-removal-toggled', secret: 'ai-default'})
        expect(settingsRequest(kept)?.apiKey).toEqual({action: 'keep'})
    })

    it('holds every secret by the same three rules, in its own field of the request', () => {
        // Every one of these matters because the page never reads a stored secret back. An empty
        // field is "leave it alone"; only the removal button is "take it off the machine". One rule
        // now, so this asserts it holds for each secret rather than that three copies agree.
        const fields = [
            {secret: 'brave', field: 'braveApiKey'},
            {secret: 'openrouter', field: 'openrouterApiKey'},
            {secret: 'cerebras', field: 'cerebrasApiKey'}
        ] as const
        for (const {secret, field} of fields) {
            expect(settingsRequest(loaded)?.[field]).toEqual({action: 'keep'})

            const typed = reduce(loaded, {type: 'key-typed', secret, value: `${secret}-1`})
            expect(settingsRequest(typed)?.[field]).toEqual({
                action: 'set',
                value: `${secret}-1`
            })

            const erased = reduce(typed, {type: 'key-typed', secret, value: '   '})
            expect(settingsRequest(erased)?.[field]).toEqual({action: 'keep'})

            const cleared = reduce(loaded, {type: 'key-removal-toggled', secret})
            expect(settingsRequest(cleared)?.[field]).toEqual({action: 'clear'})
            expect(
                settingsRequest(reduce(cleared, {type: 'key-removal-toggled', secret}))?.[field]
            ).toEqual({action: 'keep'})
        }
    })

    it('changes one key without disturbing the other', () => {
        // Three separate credentials sharing one save. Typing a Brave key must not send the AI key,
        // and clearing one must not clear the others.
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'key-typed', secret: 'brave', value: 'brave-1'}
        )
        expect(settingsRequest(state)?.apiKey).toEqual({action: 'keep'})
        expect(settingsRequest(state)?.openrouterApiKey).toEqual({action: 'keep'})
        expect(settingsRequest(state)?.braveApiKey).toEqual({action: 'set', value: 'brave-1'})

        const removed = reduce(state, {type: 'key-removal-toggled', secret: 'ai-default'})
        expect(settingsRequest(removed)?.apiKey).toEqual({action: 'clear'})
        expect(settingsRequest(removed)?.openrouterApiKey).toEqual({action: 'keep'})
        expect(settingsRequest(removed)?.braveApiKey).toEqual({action: 'set', value: 'brave-1'})
    })

    it('discards a typed key when removal is chosen', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'key-typed', secret: 'ai-default', value: 'sk-1'},
            {type: 'key-removal-toggled', secret: 'ai-default'}
        )
        expect(state.keys['ai-default'].typed).toBe('')
    })

    it('reports every stored secret the backend named, including the one with no field', () => {
        const state = reduce(INITIAL_SETTINGS_DRAFT, {
            type: 'loaded',
            response: {
                settings: SETTINGS,
                hasApiKey: true,
                hasBraveApiKey: true,
                hasOpenrouterApiKey: false,
                hasChatGptCredential: true
            },
            cache: CACHE,
            prompt: PROMPT
        })
        expect(state.keys['ai-default'].isStored).toBe(true)
        expect(state.keys.brave.isStored).toBe(true)
        expect(state.keys.openrouter.isStored).toBe(false)
        expect(state.keys['chat-gpt'].isStored).toBe(true)

        // Signing out is the only thing that removes the one secret with no box.
        const out = reduce(state, {type: 'chatgpt-auth-changed', isAuthenticated: false})
        expect(out.keys['chat-gpt'].isStored).toBe(false)
        expect(out.keys['ai-default'].isStored).toBe(true)
    })
})

describe('editing the connection', () => {
    it('changes one field and leaves the rest alone', () => {
        const state = reduce(loaded, {type: 'ai-changed', update: {maxRetries: 9}})
        expect(state.settings?.ai.maxRetries).toBe(9)
        expect(state.settings && activeConnection(state.settings.ai)?.baseUrl).toBe(
            'http://127.0.0.1:8080/v1'
        )
    })

    it('ignores edits arriving before anything has loaded', () => {
        expect(reduce(INITIAL_SETTINGS_DRAFT, {type: 'ai-changed', update: {maxRetries: 9}})).toBe(
            INITIAL_SETTINGS_DRAFT
        )
    })

    it('takes the whole model when one is chosen from the server list', () => {
        const model: AiModelOption = {
            id: 'llama',
            name: 'Llama',
            contextWindow: 8192,
            maxTokens: 2048,
            reasoning: true,
            supportsReasoningEffort: false,
            reasoningMandatory: false,
            thinkingLevels: [],
            input: ['text', 'image']
        }
        const state = reduce(loaded, {type: 'model-chosen', model})
        expect(chosen(state)).toMatchObject({
            id: 'llama',
            name: 'Llama',
            contextWindow: 8192,
            maxTokens: 2048,
            input: ['text', 'image']
        })
    })

    it('keeps the chosen thinking level on a model that can reason', () => {
        const model: AiModelOption = {
            id: 'r1',
            name: 'R1',
            contextWindow: 8192,
            maxTokens: 2048,
            reasoning: true,
            supportsReasoningEffort: true,
            reasoningMandatory: false,
            thinkingLevels: [],
            input: ['text']
        }
        expect(chosen(reduce(loaded, {type: 'model-chosen', model}))?.thinkingLevel).toBe('high')
    })

    it('drops the thinking level on a model that cannot reason', () => {
        const model: AiModelOption = {
            id: 'plain',
            name: 'Plain',
            contextWindow: 8192,
            maxTokens: 2048,
            reasoning: false,
            supportsReasoningEffort: false,
            reasoningMandatory: false,
            thinkingLevels: [],
            input: ['text']
        }
        expect(chosen(reduce(loaded, {type: 'model-chosen', model}))?.thinkingLevel).toBe('off')
    })

    /*
     * The catalogue answering about the model the page already has chosen.
     *
     * The page used to list models for ChatGPT only, so a local connection opened with whatever the
     * file said — including a `reasoning: false` written before any catalogue had been read — and
     * its reasoning menu offered `off` and nothing else.
     */
    it('re-reads what the chosen model can think without touching what was typed', () => {
        const model: AiModelOption = {
            id: 'local-model',
            name: 'Local model',
            contextWindow: 4_096,
            maxTokens: 1_024,
            reasoning: true,
            supportsReasoningEffort: true,
            reasoningMandatory: false,
            thinkingLevels: [],
            input: ['text']
        }
        const stale = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {
                type: 'model-changed',
                update: {
                    reasoning: false,
                    supportsReasoningEffort: false,
                    reasoningMandatory: false,
                    thinkingLevel: 'off',
                    contextWindow: 999_999
                }
            }
        )
        const state = reduce(stale, {type: 'model-reconciled', model})

        expect(chosen(state)?.reasoning).toBe(true)
        expect(chosen(state)?.supportsReasoningEffort).toBe(true)
        expect(chosen(state)?.contextWindow).toBe(999_999)
    })

    it('leaves the draft alone when the catalogue agrees with it', () => {
        const model: AiModelOption = {
            id: 'local-model',
            name: 'Local model',
            contextWindow: 4_096,
            maxTokens: 1_024,
            reasoning: chosen(loaded)?.reasoning ?? false,
            thinkingLevels: [],
            supportsReasoningEffort: chosen(loaded)?.supportsReasoningEffort ?? false,
            reasoningMandatory: false,
            input: ['text']
        }

        expect(reduce(loaded, {type: 'model-reconciled', model})).toBe(loaded)
    })
})

describe('choosing the model the sub-agent answers with', () => {
    const smaller: AiModelOption = {
        id: 'small',
        name: 'Small',
        contextWindow: 8192,
        maxTokens: 2048,
        reasoning: false,
        supportsReasoningEffort: false,
        reasoningMandatory: false,
        thinkingLevels: [],
        input: ['text']
    }

    it('borrows the parent connection until a driver is chosen', () => {
        expect(loaded.settings?.ai.subagent.connection).toBeUndefined()
        expect(loaded.subagentModels).toEqual([])
    })

    it('starts the child on the chosen connection own model', () => {
        const state = reduce(loaded, {
            type: 'subagent-driver-chosen',
            connectionType: 'openai-compatible'
        })

        expect(state.settings?.ai.subagent.connection).toMatchObject({
            connectionType: 'openai-compatible',
            model: {id: 'qwen', contextWindow: 32_768}
        })
        // And the parent is untouched, which is the whole point of the child having its own.
        expect(chosen(state)?.id).toBe('qwen')
    })

    it('gives the child a model and a level of its own', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'subagent-driver-chosen', connectionType: 'openai-compatible'},
            {type: 'subagent-model-chosen', model: smaller}
        )

        expect(state.settings?.ai.subagent.connection).toMatchObject({
            model: {
                id: 'small',
                contextWindow: 8192,
                // A model that cannot reason has no level to keep.
                thinkingLevel: 'off'
            }
        })
        expect(chosen(state)?.thinkingLevel).toBe('high')
    })

    it('empties the model list when the driver changes, so nothing stale can be picked', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'subagent-driver-chosen', connectionType: 'openai-compatible'},
            {type: 'subagent-models-listed', models: [smaller]},
            {type: 'subagent-driver-chosen', connectionType: undefined}
        )

        expect(state.subagentModels).toEqual([])
        expect(state.settings?.ai.subagent.connection).toBeUndefined()
    })

    it('leaves the child borrowing when the chosen driver has no stored connection', () => {
        // This fixture has never been configured for ChatGPT, so there is no connection to name.
        const state = reduce(loaded, {
            type: 'subagent-driver-chosen',
            connectionType: 'openai-codex'
        })

        expect(state.settings?.ai.subagent.connection).toBeUndefined()
    })

    it('ignores a model or a level arriving while the child is borrowing', () => {
        expect(reduce(loaded, {type: 'subagent-model-chosen', model: smaller})).toBe(loaded)
        expect(reduce(loaded, {type: 'subagent-thinking-chosen', thinkingLevel: 'low'})).toBe(
            loaded
        )
    })

    it('sets the level the child is asked at', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'subagent-driver-chosen', connectionType: 'openai-compatible'},
            {type: 'subagent-thinking-chosen', thinkingLevel: 'low'}
        )

        expect(state.settings?.ai.subagent.connection?.model.thinkingLevel).toBe('low')
    })
})

describe('work in flight', () => {
    it('clears the previous notice when new work begins', () => {
        const state = apply(
            {
                type: 'loaded',
                prompt: PROMPT,
                response: {...RESPONSE, credentialStoreError: 'no keyring'},
                cache: CACHE
            },
            {type: 'began', task: 'saving'}
        )
        expect(state.notices.ai).toBeUndefined()
        expect(state.busy.saving).toBe(true)
    })

    it('lets a download and a backup run at the same time', () => {
        const state = apply(
            {type: 'began', task: 'downloading'},
            {type: 'began', task: 'backingUp'},
            {type: 'ended', task: 'backingUp'}
        )
        expect(state.busy.downloading).toBe(true)
        expect(state.busy.backingUp).toBe(false)
    })

    it('keeps the failure notice when ending the task clears the same busy flag', () => {
        const notice = {status: 'error', title: 'Backup failed', description: 'disk full'} as const
        const state = apply(
            {type: 'began', task: 'backingUp'},
            {type: 'failed', task: 'backingUp', notice},
            {type: 'ended', task: 'backingUp'}
        )
        expect(state.notices.storage).toBe(notice)
        expect(state.busy.backingUp).toBe(false)
    })

    it('forgets download progress once the download ends', () => {
        const state = apply(
            {type: 'began', task: 'downloading'},
            {type: 'progress', progress: {model: 'bge', status: 'downloading'}},
            {type: 'ended', task: 'downloading'}
        )
        expect(state.progress).toBeUndefined()
    })
})

describe('saving', () => {
    it('adopts what the backend stored and forgets every typed key', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'key-typed', secret: 'ai-default', value: 'sk-1'},
            {type: 'key-typed', secret: 'brave', value: 'brave-1'},
            {type: 'key-removal-toggled', secret: 'openrouter'},
            {type: 'began', task: 'saving'},
            {type: 'saved', response: {settings: SETTINGS, hasApiKey: true, hasBraveApiKey: true}}
        )
        expect(state.keys['ai-default'].isStored).toBe(true)
        expect(state.keys.brave.isStored).toBe(true)
        // The save wrote all three, so all three boxes are empty and back to "leave it alone".
        // Text left in one would be sent a second time by the next save.
        for (const key of Object.values(state.keys)) {
            expect(key.typed).toBe('')
            expect(key.intent).toBe('keep')
        }
        expect(state.busy.saving).toBe(false)
        expect(state.notices.ai?.status).toBe('success')
    })

    it('warns rather than celebrates when the key could not be stored', () => {
        const state = reduce(loaded, {
            type: 'saved',
            response: {settings: SETTINGS, hasApiKey: false, credentialStoreError: 'locked'}
        })
        expect(state.notices.ai).toEqual({
            status: 'warning',
            title: 'Connection saved without API key access',
            description: 'locked'
        })
    })
})

describe('the Godot rules', () => {
    it('moves the box before the backend answers', () => {
        const state = reduce(loaded, {type: 'godot-changed', update: {strictTyping: false}})
        expect(state.settings?.godot.strictTyping).toBe(false)
        // The other rule is untouched: one checkbox writes one rule.
        expect(state.settings?.godot.embedGameWindow).toBe(true)
    })

    it('changes nothing before settings have loaded', () => {
        const state = reduce(INITIAL_SETTINGS_DRAFT, {
            type: 'godot-changed',
            update: {strictTyping: false}
        })
        expect(state.settings).toBeUndefined()
    })

    it('adopts what the backend stored and says when it applies', () => {
        const stored = {...SETTINGS, godot: {strictTyping: false, embedGameWindow: true}}
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'godot-changed', update: {strictTyping: false}},
            {type: 'began', task: 'savingGodot'},
            {type: 'godot-saved', response: {settings: stored, hasApiKey: false}}
        )
        expect(state.settings?.godot).toEqual({strictTyping: false, embedGameWindow: true})
        expect(state.busy.savingGodot).toBe(false)
        expect(state.notices.godot).toEqual({
            status: 'success',
            title: 'Godot rules saved',
            description: 'They are applied the next time a Godot session starts.'
        })
    })

    // The page puts the tick back itself, by dispatching the previous value. What this pins is that
    // a failure lands on the Godot tab rather than over the connection form on another one.
    it('reports a failed write on its own tab', () => {
        const notice = {
            status: 'error',
            title: 'Godot rules could not be saved',
            description: 'x'
        } as const
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'godot-changed', update: {strictTyping: false}},
            {type: 'failed', task: 'savingGodot', notice},
            {type: 'godot-changed', update: {strictTyping: true}}
        )
        expect(state.notices.godot).toEqual(notice)
        expect(state.notices.ai).toBeUndefined()
        expect(state.settings?.godot.strictTyping).toBe(true)
    })
})

describe('the model cache', () => {
    it('cannot be deleted before it has been read', () => {
        expect(canDeleteCache(INITIAL_SETTINGS_DRAFT)).toBe(false)
    })

    it('cannot be deleted while it is empty', () => {
        const state = reduce(loaded, {type: 'cache-read', cache: {...CACHE, sizeBytes: 0}})
        expect(canDeleteCache(state)).toBe(false)
    })

    it('cannot be deleted while this page is downloading into it', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'began', task: 'downloading'},
            {type: 'cache-downloading'}
        )
        expect(cacheIsBusy(state)).toBe(true)
        expect(canDeleteCache(state)).toBe(false)
    })

    it('cannot be deleted while the backend reports it busy', () => {
        const state = reduce(loaded, {type: 'cache-read', cache: {...CACHE, state: 'busy'}})
        expect(canDeleteCache(state)).toBe(false)
    })

    it('can be deleted once it holds bytes and nothing is touching it', () => {
        expect(canDeleteCache(loaded)).toBe(true)
    })

    it('closes its confirmation dialog when the delete succeeds', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'delete-dialog', isOpen: true},
            {type: 'began', task: 'deleting'},
            {type: 'cache-read', cache: {...CACHE, sizeBytes: 0, state: 'not-installed'}},
            {type: 'delete-dialog', isOpen: false},
            {type: 'ended', task: 'deleting'}
        )
        expect(state.isDeleteOpen).toBe(false)
        expect(state.cache?.state).toBe('not-installed')
    })

    it('leaves its confirmation dialog open when the delete fails', () => {
        const notice = {
            status: 'error',
            title: 'Model cache could not be deleted',
            description: 'x'
        } as const
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'delete-dialog', isOpen: true},
            {type: 'began', task: 'deleting'},
            {type: 'failed', task: 'deleting', notice},
            {type: 'ended', task: 'deleting'}
        )
        expect(state.isDeleteOpen).toBe(true)
    })
})

describe('notices', () => {
    it('are dismissable', () => {
        const notice = {status: 'success', title: 'Saved', description: 'x'} as const
        const state = apply(
            {type: 'noticed', tab: 'ai', notice},
            {type: 'notice-dismissed', tab: 'ai'}
        )
        expect(state.notices.ai).toBeUndefined()
    })
})

describe('the agent prompt', () => {
    it('arrives as the text the box shows and the text Restore puts back', () => {
        expect(loaded.agentPrompt).toBe(SHIPPED_PROMPT)
        expect(agentPromptIsUnsaved(loaded)).toBe(false)
        expect(agentPromptIsDefault(loaded)).toBe(true)
    })

    it('is unsaved from the first keystroke, and restoring it is a change of its own', () => {
        const edited = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'prompt-typed', value: 'Answer in Latvian.'}
        )
        expect(agentPromptIsUnsaved(edited)).toBe(true)
        expect(agentPromptIsDefault(edited)).toBe(false)

        const restored = reduce(edited, {type: 'prompt-restored'})
        expect(restored.agentPrompt).toBe(SHIPPED_PROMPT)
        // Restoring only fills the box. The backend is told when the page is saved, like everything
        // else on it, so until then the shipped text is still an unsaved change.
        expect(agentPromptIsUnsaved(restored)).toBe(false)
        expect(agentPromptIsDefault(restored)).toBe(true)
    })

    /*
     * The backend answers a save with what it will actually send, which is the shipped prompt
     * whenever the stored text was the shipped one. Taking its word is what keeps the box from
     * claiming an edit the project does not have.
     */
    it('takes the saved prompt from the backend rather than from the box', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE, prompt: PROMPT},
            {type: 'prompt-typed', value: `  ${SHIPPED_PROMPT}  `},
            {type: 'prompt-saved', prompt: PROMPT}
        )
        expect(state.agentPrompt).toBe(SHIPPED_PROMPT)
        expect(agentPromptIsUnsaved(state)).toBe(false)
    })
})

/*
 * The protocol itself, rather than eight copies of it.
 *
 * `began` before the work, `failed` with the caller's title if it throws, `ended` either way — an
 * order that used to live in eight try/catch/finally blocks on the page, agreeing with each other
 * only by hand. These are the tests that could not be written while it did.
 */
describe('runSettingsTask', () => {
    /**
     * What a backend command rejects with: a coded failure carrying a sentence, which is what
     * `commandErrorMessage` reads. An `Error` alone would print as "Error: …", which is the shape
     * this repo stopped rejecting with once every command started answering with a code.
     */
    class CommandFailure extends Error {
        readonly code = 'io_error'
        readonly retryable = false
        readonly details = {}
    }

    /** Records what the runner dispatched, in order. */
    function recorder() {
        const taken: (SettingsAction | SettingsTaskAction)[] = []
        return {
            taken,
            dispatch: (action: SettingsTaskAction) => {
                taken.push(action)
            }
        }
    }

    it('begins and ends a task that succeeds, and says nothing about failure', async () => {
        const {taken, dispatch} = recorder()
        await runSettingsTask(dispatch, 'saving', 'Settings could not be saved', async () =>
            Promise.resolve()
        )
        expect(taken).toEqual([
            {type: 'began', task: 'saving'},
            {type: 'ended', task: 'saving'}
        ])
    })

    it("reports a failure under the caller's title and still ends the task", async () => {
        const {taken, dispatch} = recorder()
        await runSettingsTask(dispatch, 'backingUp', 'Backup failed', () =>
            Promise.reject(new CommandFailure('disk full'))
        )
        expect(taken).toEqual([
            {type: 'began', task: 'backingUp'},
            {
                type: 'failed',
                task: 'backingUp',
                notice: {status: 'error', title: 'Backup failed', description: 'disk full'}
            },
            {type: 'ended', task: 'backingUp'}
        ])
    })

    it('does not reject, so a caller never has to catch what the runner already reported', async () => {
        const {dispatch} = recorder()
        await expect(
            runSettingsTask(dispatch, 'deleting', 'Model cache could not be deleted', () =>
                Promise.reject(new CommandFailure('nope'))
            )
        ).resolves.toBeUndefined()
    })

    it('leaves two overlapping tasks each holding their own flag', async () => {
        const state = apply(
            {type: 'began', task: 'downloading'},
            {type: 'began', task: 'backingUp'},
            {type: 'ended', task: 'backingUp'}
        )
        expect(state.busy.downloading).toBe(true)
        expect(state.busy.backingUp).toBe(false)
    })
})
