import {cleanup, renderHook, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {useAiConnection} from './useAiConnection'
import {activeConnection} from '../models/settings'
import type {AiModelOption, GoferSettings, ModelChoice, SettingsResponse} from '../models/settings'

vi.mock('../services/desktop', async () => {
    const actual =
        await vi.importActual<typeof import('../services/desktop')>('../services/desktop')
    return {
        ...actual,
        isTauri: () => true,
        invoke: (...call: unknown[]) => backend(...call),
        listen: () => Promise.resolve(() => undefined)
    }
})

/** What the fake backend answers, rebuilt per test. */
let backend: (...call: unknown[]) => Promise<unknown>

/** Every settings object the renderer asked the backend to store, oldest first. */
let saved: GoferSettings[]

/** A local connection whose stored model facts are the argument. */
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

/** The model the live connection is on, in whatever the hook is holding or last saved. */
function chosen(settings?: GoferSettings): ModelChoice | undefined {
    return settings && activeConnection(settings.ai)?.model
}

/** One model as the server's catalogue describes it. */
function catalogued(model: Partial<AiModelOption>): AiModelOption {
    return {
        id: 'qwen.gguf',
        name: 'Qwen',
        contextWindow: 120_064,
        maxTokens: 120_064,
        reasoning: true,
        supportsReasoningEffort: true,
        thinkingLevels: [],
        input: ['text'],
        ...model
    }
}

/** Wires the fake backend to one stored file and one catalogue. */
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
    })

    /*
     * Unmounted, not left standing. The hook defers its connection to after the render, so a hook
     * still mounted when the environment is torn down runs `setConnectionState` against a `window`
     * that no longer exists — an unhandled rejection, and one that reports against whichever test
     * file happened to be running. The effect's cleanup cancels the deferral; nothing calls it
     * unless the hook is unmounted.
     */
    afterEach(() => {
        cleanup()
    })

    /*
     * The regression: a local server names its model differently from the catalogue Gofer read the
     * model's facts out of, so the file was written with `reasoning: false`, and the reasoning menu
     * offered nothing but `off` forever. Nothing re-read those facts, because the configured model
     * was in the list — only a model that was *not* was ever adopted.
     */
    it('adopts a thinking level the configured model turns out to have', async () => {
        connectedTo(storedSettings({}), [catalogued({})])
        const {result} = connect()
        await waitFor(() => {
            expect(chosen(result.current.settings)?.reasoning).toBe(true)
        })
        expect(chosen(result.current.settings)?.supportsReasoningEffort).toBe(true)
        expect(chosen(saved.at(-1))?.reasoning).toBe(true)
    })

    /** And the other direction: a model that cannot reason keeps no level to be asked at. */
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

    /** A catalogue that agrees with the file is not a reason to write the file. */
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

    /** The rule that was already there, and has to survive: one model, and it is not the one. */
    it('adopts the only model a server has when it is not the configured one', async () => {
        connectedTo(storedSettings({}), [catalogued({id: 'other.gguf', name: 'Other'})])
        const {result} = connect()
        await waitFor(() => {
            expect(chosen(result.current.settings)?.id).toBe('other.gguf')
        })
        expect(chosen(saved.at(-1))?.name).toBe('Other')
    })
})
