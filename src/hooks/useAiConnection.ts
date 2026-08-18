import {useCallback, useEffect, useRef, useState} from 'react'
import {defer} from '../services/clock'
import {invoke, isTauri, listen} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {applyModelSelection, normalizeSettings} from '../models/settings'
import type {AiModelOption, AiSettings, GoferSettings, ThinkingLevel} from '../models/settings'

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
    /** Which server the listed models came from, so a save that changed nothing costs nothing. */
    const listedFor = useRef<string | undefined>(undefined)

    const listModels = useCallback(async (of: GoferSettings) => {
        const available = await invoke('list_ai_models', {
            request: {settings: of, apiKey: {action: 'keep'}, braveApiKey: {action: 'keep'}}
        })
        listedFor.current = catalogueOf(of.ai)
        setModels(available)
        return available
    }, [])

    const saveSettings = useCallback(
        async (nextSettings: GoferSettings, failure: string) => {
            setSettings(nextSettings)
            try {
                await invoke('save_settings', {
                    request: {
                        settings: nextSettings,
                        apiKey: {action: 'keep'},
                        braveApiKey: {action: 'keep'}
                    }
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
                {...previous, ai: applyModelSelection(previous.ai, model)},
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
            const available = await listModels(loadedSettings)
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
    }, [applyModel, listModels, onConnected, onError])

    // Deferred to after the render rather than run inside it, so a mount and its StrictMode double
    // collapse into one connection attempt instead of two.
    useEffect(
        () =>
            defer(() => {
                void connect()
            }),
        [connect]
    )

    /*
     * The saved file is the one source of truth, so every screen reads the same model.
     *
     * The composer used to keep whatever it read at mount, which meant the settings page could
     * change the model and the composer would go on offering the old one until the app restarted.
     * The catalogue is refetched only when the driver or its address changed: picking a different
     * model from the same server does not make that server's list any different.
     */
    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let dispose: (() => void) | undefined
        void listen('settings-saved', event => {
            if (isCancelled) return
            const saved = normalizeSettings(event.payload.settings)
            setSettings(saved)
            if (listedFor.current === catalogueOf(saved.ai)) return
            void listModels(saved).catch((error: unknown) => {
                onError(`The model list could not be read: ${commandErrorMessage(error)}`)
            })
        }).then(unlisten => {
            if (isCancelled) unlisten()
            else dispose = unlisten
        })
        return () => {
            isCancelled = true
            dispose?.()
        }
    }, [listModels, onError])

    return {settings, models, connectionState, connect, applyModel, applyThinkingLevel}
}

/** What decides which models exist: the driver, and where it is. Not which one is selected. */
function catalogueOf(ai: AiSettings) {
    return `${ai.connectionType} ${ai.baseUrl}`
}
