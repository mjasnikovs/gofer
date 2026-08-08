import {describe, expect, it} from 'vitest'
import {
    apiKeyUpdate,
    cacheStateLabel,
    cacheStateVariant,
    compactionLabel,
    connectionNotice,
    formatBytes,
    normalizeSettings,
    progressLabel,
    progressValue
} from './settings'
import type {GoferSettings} from './settings'

/** A settings file written before the connection fields existed: version and the four originals. */
const stored = {
    version: 1,
    ai: {
        connectionType: 'openai-compatible',
        name: 'Local AI',
        baseUrl: 'http://127.0.0.1:8080/v1',
        model: 'local-model',
        api: 'openai-completions'
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
            input: ['text'],
            thinkingLevel: 'off',
            maxRetries: 2,
            timeoutMs: 120_000,
            compactionPercent: 86
        })
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
