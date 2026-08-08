import {describe, expect, it} from 'vitest'
import {
    INITIAL_SETTINGS_DRAFT,
    canDeleteCache,
    cacheIsBusy,
    reduce,
    settingsRequest
} from './settings-draft'
import type {SettingsAction, SettingsDraft} from './settings-draft'
import type {AiModelOption, CacheStatus, GoferSettings, SettingsResponse} from './settings'

const SETTINGS: GoferSettings = {
    version: 1,
    ai: {
        connectionType: 'openai-compatible',
        name: 'Local',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'qwen',
        api: 'openai-completions',
        modelName: 'qwen',
        contextWindow: 32_768,
        maxTokens: 4096,
        reasoning: true,
        supportsReasoningEffort: true,
        input: ['text'],
        thinkingLevel: 'high',
        maxRetries: 2,
        timeoutMs: 120_000,
        compactionPercent: 86,
        systemPrompt: ''
    }
}

const CACHE: CacheStatus = {path: '/cache', sizeBytes: 1024, state: 'installed'}

const RESPONSE: SettingsResponse = {settings: SETTINGS, hasApiKey: false}

/** Applies a run of actions in order, which is the only way the page ever reaches a state. */
function apply(...actions: readonly SettingsAction[]): SettingsDraft {
    return actions.reduce(reduce, INITIAL_SETTINGS_DRAFT)
}

const loaded = apply({type: 'loaded', response: RESPONSE, cache: CACHE})

describe('loading', () => {
    it('starts with nothing loaded and nothing running', () => {
        expect(INITIAL_SETTINGS_DRAFT.settings).toBeUndefined()
        expect(INITIAL_SETTINGS_DRAFT.isLoading).toBe(true)
        expect(Object.values(INITIAL_SETTINGS_DRAFT.busy)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false
        ])
    })

    it('fills in the defaults a stored settings file may predate', () => {
        const sparse = {version: 1, ai: {model: 'gpt'}} as unknown as GoferSettings
        const state = apply({
            type: 'loaded',
            response: {settings: sparse, hasApiKey: false},
            cache: CACHE
        })
        expect(state.settings?.ai.compactionPercent).toBe(86)
        expect(state.settings?.ai.thinkingLevel).toBe('off')
        expect(state.isLoading).toBe(false)
    })

    it('warns when the credential store could not be reached', () => {
        const state = apply({
            type: 'loaded',
            response: {...RESPONSE, credentialStoreError: 'no keyring'},
            cache: CACHE
        })
        expect(state.notice).toEqual({
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
        expect(state.notice).toBe(notice)
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
        const state = reduce(loaded, {type: 'api-key-typed', value: 'sk-1'})
        expect(settingsRequest(state)?.apiKey).toEqual({action: 'set', value: 'sk-1'})
    })

    it('keeps rather than clears when the typed key is erased again', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE},
            {type: 'api-key-typed', value: 'sk-1'},
            {type: 'api-key-typed', value: '   '}
        )
        expect(settingsRequest(state)?.apiKey).toEqual({action: 'keep'})
    })

    it('clears only when the removal button was pressed, and un-clears on a second press', () => {
        const cleared = reduce(loaded, {type: 'api-key-removal-toggled'})
        expect(settingsRequest(cleared)?.apiKey).toEqual({action: 'clear'})
        const kept = reduce(cleared, {type: 'api-key-removal-toggled'})
        expect(settingsRequest(kept)?.apiKey).toEqual({action: 'keep'})
    })

    it('discards a typed key when removal is chosen', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE},
            {type: 'api-key-typed', value: 'sk-1'},
            {type: 'api-key-removal-toggled'}
        )
        expect(state.apiKey).toBe('')
    })
})

describe('editing the connection', () => {
    it('changes one field and leaves the rest alone', () => {
        const state = reduce(loaded, {type: 'ai-changed', update: {maxRetries: 9}})
        expect(state.settings?.ai.maxRetries).toBe(9)
        expect(state.settings?.ai.baseUrl).toBe(SETTINGS.ai.baseUrl)
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
            input: ['text', 'image']
        }
        const state = reduce(loaded, {type: 'model-chosen', model})
        expect(state.settings?.ai).toMatchObject({
            model: 'llama',
            modelName: 'Llama',
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
            input: ['text']
        }
        expect(reduce(loaded, {type: 'model-chosen', model}).settings?.ai.thinkingLevel).toBe(
            'high'
        )
    })

    it('drops the thinking level on a model that cannot reason', () => {
        const model: AiModelOption = {
            id: 'plain',
            name: 'Plain',
            contextWindow: 8192,
            maxTokens: 2048,
            reasoning: false,
            supportsReasoningEffort: false,
            input: ['text']
        }
        expect(reduce(loaded, {type: 'model-chosen', model}).settings?.ai.thinkingLevel).toBe('off')
    })
})

describe('work in flight', () => {
    it('clears the previous notice when new work begins', () => {
        const state = apply(
            {
                type: 'loaded',
                response: {...RESPONSE, credentialStoreError: 'no keyring'},
                cache: CACHE
            },
            {type: 'began', task: 'saving'}
        )
        expect(state.notice).toBeUndefined()
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

    it('keeps the failure notice when the finally block also ends the task', () => {
        const notice = {status: 'error', title: 'Backup failed', description: 'disk full'} as const
        const state = apply(
            {type: 'began', task: 'backingUp'},
            {type: 'failed', task: 'backingUp', notice},
            {type: 'ended', task: 'backingUp'}
        )
        expect(state.notice).toBe(notice)
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
    it('adopts what the backend stored and forgets the typed key', () => {
        const state = apply(
            {type: 'loaded', response: RESPONSE, cache: CACHE},
            {type: 'api-key-typed', value: 'sk-1'},
            {type: 'began', task: 'saving'},
            {type: 'saved', response: {settings: SETTINGS, hasApiKey: true}}
        )
        expect(state.hasApiKey).toBe(true)
        expect(state.apiKey).toBe('')
        expect(state.apiKeyIntent).toBe('keep')
        expect(state.busy.saving).toBe(false)
        expect(state.notice?.status).toBe('success')
    })

    it('warns rather than celebrates when the key could not be stored', () => {
        const state = reduce(loaded, {
            type: 'saved',
            response: {settings: SETTINGS, hasApiKey: false, credentialStoreError: 'locked'}
        })
        expect(state.notice).toEqual({
            status: 'warning',
            title: 'Connection saved without API key access',
            description: 'locked'
        })
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
            {type: 'loaded', response: RESPONSE, cache: CACHE},
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
            {type: 'loaded', response: RESPONSE, cache: CACHE},
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
            {type: 'loaded', response: RESPONSE, cache: CACHE},
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
        const state = apply({type: 'noticed', notice}, {type: 'notice-dismissed'})
        expect(state.notice).toBeUndefined()
    })
})
