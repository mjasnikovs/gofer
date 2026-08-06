import {useCallback, useEffect, useState} from 'react'
import {invoke, isTauri} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {normalizeSettings} from '../models/settings'
import type {AiModelOption, GoferSettings, ThinkingLevel} from '../models/settings'

export type ConnectionState = 'connecting' | 'connected' | 'offline'

type AiConnectionOptions = Readonly<{
    onError: (message: string) => void
    onConnected: () => void
}>

/**
 * Owns the AI connection: settings, the available model list, and the selection commands.
 *
 * When the server offers exactly one model and it is not the configured one, that model is
 * adopted automatically — a llama.cpp host usually serves a single model whose id the user has
 * no reason to type by hand.
 */
export function useAiConnection({onError, onConnected}: AiConnectionOptions) {
    const [settings, setSettings] = useState<GoferSettings>()
    const [models, setModels] = useState<readonly AiModelOption[]>([])
    const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
        isTauri() ? 'connecting' : 'offline'
    )

    const saveSettings = useCallback(
        async (nextSettings: GoferSettings, failure: string) => {
            setSettings(nextSettings)
            try {
                await invoke('save_settings', {
                    request: {settings: nextSettings, apiKey: {action: 'keep'}}
                })
                onConnected()
            } catch (error) {
                onError(`${failure}: ${commandErrorMessage(error)}`)
            }
        },
        [onConnected, onError]
    )

    const applyModel = useCallback(
        async (model: AiModelOption, previous?: GoferSettings) => {
            if (!previous) return
            await saveSettings(
                {
                    ...previous,
                    ai: {
                        ...previous.ai,
                        model: model.id,
                        modelName: model.name,
                        contextWindow: model.contextWindow,
                        maxTokens: model.maxTokens,
                        reasoning: model.reasoning,
                        supportsReasoningEffort: model.supportsReasoningEffort,
                        input: model.input,
                        thinkingLevel: model.reasoning ? previous.ai.thinkingLevel : 'off'
                    }
                },
                'The model selection could not be saved'
            )
        },
        [saveSettings]
    )

    const applyThinkingLevel = useCallback(
        async (thinkingLevel: ThinkingLevel, previous?: GoferSettings) => {
            if (!previous) return
            await saveSettings(
                {...previous, ai: {...previous.ai, thinkingLevel}},
                'The reasoning level could not be saved'
            )
        },
        [saveSettings]
    )

    const connect = useCallback(async () => {
        if (!isTauri()) return
        await Promise.resolve()
        setConnectionState('connecting')
        onConnected()
        try {
            const response = await invoke('load_settings')
            const loadedSettings = normalizeSettings(response.settings)
            setSettings(loadedSettings)
            const available = await invoke('list_ai_models', {
                request: {settings: loadedSettings, apiKey: {action: 'keep'}}
            })
            setModels(available)
            setConnectionState('connected')
            if (
                available.length === 1
                && !available.some(model => model.id === loadedSettings.ai.model)
            ) {
                const onlyModel = available[0]
                if (onlyModel) await applyModel(onlyModel, loadedSettings)
            }
        } catch (error) {
            setConnectionState('offline')
            onError(`Local AI is unavailable: ${commandErrorMessage(error)}`)
        }
    }, [applyModel, onConnected, onError])

    useEffect(() => {
        const timeout = window.setTimeout(() => {
            void connect()
        }, 0)
        return () => {
            window.clearTimeout(timeout)
        }
    }, [connect])

    return {settings, models, connectionState, connect, applyModel, applyThinkingLevel}
}
