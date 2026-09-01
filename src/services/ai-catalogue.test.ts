import {describe, expect, it} from 'vitest'
import {catalogueKey, reconciled} from './ai-catalogue'
import {SETTINGS} from '../test/backend'
import type {AiConnectionProfile, AiModelOption, GoferSettings} from '../models/settings'

const STORED: GoferSettings = SETTINGS.settings

/** The local connection the fixture settings are built around. */
function local(of: GoferSettings): AiConnectionProfile {
    const connection = of.ai.connections['openai-compatible']
    if (!connection) throw new Error('the fixture settings have a local connection')
    return connection
}

function model(id: string, overrides: Partial<AiModelOption> = {}): AiModelOption {
    return {
        id,
        name: id,
        contextWindow: 8192,
        maxTokens: 4096,
        reasoning: false,
        supportsReasoningEffort: false,
        reasoningMandatory: false,
        thinkingLevels: [],
        input: ['text'],
        ...overrides
    }
}

describe('catalogueKey', () => {
    it('is the driver and the address, because one without the other is a different question', () => {
        const elsewhere: GoferSettings = {
            ...STORED,
            ai: {
                ...STORED.ai,
                connections: {
                    ...STORED.ai.connections,
                    'openai-compatible': {...local(STORED), baseUrl: 'http://elsewhere:8080/v1'}
                }
            }
        }
        expect(catalogueKey(STORED.ai)).not.toBe(catalogueKey(elsewhere.ai))
        expect(catalogueKey(STORED.ai)).toBe(catalogueKey(STORED.ai))
    })
})

describe('reconciled', () => {
    it('changes nothing when the catalogue already holds the chosen model unchanged', () => {
        const chosen = local(STORED).model
        expect(reconciled([model(chosen.id)], STORED)).toBeUndefined()
    })

    it('adopts a sole model when the chosen one is not served', () => {
        const next = reconciled([model('only-one')], STORED)
        expect(next?.ai.connections['openai-compatible']?.model.id).toBe('only-one')
    })

    it('leaves a choice alone when the server offers several and none is the chosen one', () => {
        expect(reconciled([model('a'), model('b')], STORED)).toBeUndefined()
    })
})
