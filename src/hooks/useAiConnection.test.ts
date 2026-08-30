import {cleanup, renderHook, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {useAiConnection} from './useAiConnection'
import {activeConnection} from '../models/settings'
import {createDesktopFake, installDesktopFake, removeDesktopFake} from '../test/desktop-driver'
import type {AiModelOption, GoferSettings, ModelChoice, SettingsResponse} from '../models/settings'

const tauri = createDesktopFake()

let backend: (...call: unknown[]) => Promise<unknown>

let saved: GoferSettings[]

function storedSettings(model: Partial<ModelChoice>): GoferSettings {
    return {
        version: 1,
        ai: {
            connectionType: 'openai-compatible',
            connections: {
                'openai-compatible': {
                    name: 'Local AI',
                    baseUrl: 'http://127.0.0.1:8080/v1',
                    api: 'openai-completions',
                    chatTemplateThinking: false,
                    model: {
                        id: 'qwen.gguf',
                        name: 'qwen.gguf',
                        contextWindow: 120_064,
                        maxTokens: 120_064,
                        reasoning: false,
                        supportsReasoningEffort: false,
                        reasoningMandatory: false,
                        thinkingLevels: [],
                        input: ['text'],
                        thinkingLevel: 'off',
                        ...model
                    }
                }
            }
        }
    } as unknown as GoferSettings
}

function chosen(settings?: GoferSettings): ModelChoice | undefined {
    return settings && activeConnection(settings.ai)?.model
}

function catalogued(model: Partial<AiModelOption>): AiModelOption {
    return {
        id: 'qwen.gguf',
        name: 'Qwen',
        contextWindow: 120_064,
        maxTokens: 120_064,
        reasoning: true,
        supportsReasoningEffort: true,
        reasoningMandatory: false,
        thinkingLevels: [],
        input: ['text'],
        ...model
    }
}

function connectedTo(settings: GoferSettings, models: readonly AiModelOption[]) {
    backend = (command, args) => {
        if (command === 'load_settings') {
            return Promise.resolve({settings, hasApiKey: false} as SettingsResponse)
        }
        if (command === 'list_ai_models') return Promise.resolve(models)
        if (command === 'save_settings') {
            saved.push((args as {request: {settings: GoferSettings}}).request.settings)
            return Promise.resolve({settings: saved.at(-1), hasApiKey: false})
        }
        return Promise.resolve(undefined)
    }
}

function connect() {
    return renderHook(() =>
        useAiConnection({onError: () => undefined, onConnected: () => undefined})
    )
}

describe('useAiConnection', () => {
    beforeEach(() => {
        saved = []
        backend = () => Promise.resolve(undefined)
        installDesktopFake(tauri)
        tauri.invoke.mockImplementation((command, arguments_) => backend(command, arguments_))
    })

    afterEach(() => {
        cleanup()
        removeDesktopFake()
    })

    it('adopts a thinking level the configured model turns out to have', async () => {
        connectedTo(storedSettings({}), [catalogued({})])
        const {result} = connect()
        await waitFor(() => {
            expect(chosen(result.current.settings)?.reasoning).toBe(true)
        })
        expect(chosen(result.current.settings)?.supportsReasoningEffort).toBe(true)
        expect(chosen(saved.at(-1))?.reasoning).toBe(true)
    })

    it('drops a thinking level the configured model turns out not to have', async () => {
        connectedTo(
            storedSettings({reasoning: true, supportsReasoningEffort: true, thinkingLevel: 'high'}),
            [catalogued({reasoning: false, supportsReasoningEffort: false})]
        )
        const {result} = connect()
        await waitFor(() => {
            expect(chosen(result.current.settings)?.reasoning).toBe(false)
        })
        expect(chosen(result.current.settings)?.thinkingLevel).toBe('off')
        expect(chosen(saved.at(-1))?.thinkingLevel).toBe('off')
    })

    it('saves nothing when the catalogue tells it what it already knew', async () => {
        connectedTo(
            storedSettings({reasoning: true, supportsReasoningEffort: true, thinkingLevel: 'high'}),
            [catalogued({})]
        )
        const {result} = connect()
        await waitFor(() => {
            expect(result.current.connectionState).toBe('connected')
        })
        expect(saved).toEqual([])
        expect(chosen(result.current.settings)?.thinkingLevel).toBe('high')
    })

    it('adopts the only model a server has when it is not the configured one', async () => {
        connectedTo(storedSettings({}), [catalogued({id: 'other.gguf', name: 'Other'})])
        const {result} = connect()
        await waitFor(() => {
            expect(chosen(result.current.settings)?.id).toBe('other.gguf')
        })
        expect(chosen(saved.at(-1))?.name).toBe('Other')
    })
})
