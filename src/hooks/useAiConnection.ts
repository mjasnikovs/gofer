import {useCallback, useEffect, useRef, useState} from 'react'
import {defer} from '../services/clock'
import {invoke, isTauri, listen} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {
    activeConnection,
    adoptModelReasoning,
    adoptSubagentReasoning,
    applyModelSelection,
    normalizeSettings,
    withActiveConnection
} from '../models/settings'
import type {AiModelOption, AiSettings, GoferSettings, ThinkingLevel} from '../models/settings'

export type ConnectionState = 'connecting' | 'connected' | 'offline'

type AiConnectionOptions = Readonly<{
    onError: (message: string) => void
    onConnected: () => void
}>

export function useAiConnection({onError, onConnected}: AiConnectionOptions) {
    const [settings, setSettings] = useState<GoferSettings>()
    const [models, setModels] = useState<readonly AiModelOption[]>([])
    const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
        isTauri() ? 'connecting' : 'offline'
    )
    const listedFor = useRef<string | undefined>(undefined)
    const attempt = useRef(0)

    const listModels = useCallback(async (of: GoferSettings) => {
        const available = await invoke('list_ai_models', {
            request: {
                settings: of,
                apiKey: {action: 'keep'},
                braveApiKey: {action: 'keep'},
                openrouterApiKey: {action: 'keep'},
                cerebrasApiKey: {action: 'keep'}
            }
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
                        braveApiKey: {action: 'keep'},
                        openrouterApiKey: {action: 'keep'},
                        cerebrasApiKey: {action: 'keep'}
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
            const ai = withActiveConnection(previous.ai, connection => ({
                ...connection,
                model: applyModelSelection(connection.model, model)
            }))
            await saveSettings({...previous, ai}, 'The model selection could not be saved')
        },
        [saveSettings]
    )

    const applyThinkingLevel = useCallback(
        async (thinkingLevel: ThinkingLevel, previous?: GoferSettings) => {
            if (!previous) return
            const ai = withActiveConnection(previous.ai, connection => ({
                ...connection,
                model: {...connection.model, thinkingLevel}
            }))
            await saveSettings({...previous, ai}, 'The reasoning level could not be saved')
        },
        [saveSettings]
    )

    const reconcileModel = useCallback(
        async (available: readonly AiModelOption[], loaded: GoferSettings) => {
            const chosen = activeConnection(loaded.ai)
            const configured = available.find(model => model.id === chosen?.model.id)
            const withChild = adoptSubagentReasoning(loaded.ai, loaded.ai.connectionType, available)
            if (!configured || !chosen) {
                const onlyModel = available.length === 1 ? available[0] : undefined
                if (onlyModel) {
                    await applyModel(onlyModel, {...loaded, ai: withChild})
                    return
                }
                if (withChild === loaded.ai) return
                await saveSettings(
                    {...loaded, ai: withChild},
                    "The model's reasoning support could not be saved"
                )
                return
            }
            const model = adoptModelReasoning(chosen.model, configured)
            const ai =
                model === chosen.model ?
                    withChild
                :   withActiveConnection(withChild, connection => ({...connection, model}))
            if (ai === loaded.ai) return
            await saveSettings({...loaded, ai}, "The model's reasoning support could not be saved")
        },
        [applyModel, saveSettings]
    )

    const connect = useCallback(async () => {
        if (!isTauri()) return
        const mine = ++attempt.current
        const isCurrent = () => attempt.current === mine
        await Promise.resolve()
        setConnectionState('connecting')
        onConnected()
        try {
            const response = await invoke('load_settings')
            if (!isCurrent()) return
            const loadedSettings = normalizeSettings(response.settings)
            setSettings(loadedSettings)
            const available = await listModels(loadedSettings)
            if (!isCurrent()) return
            setConnectionState('connected')
            await reconcileModel(available, loadedSettings)
        } catch (error) {
            if (!isCurrent()) return
            setConnectionState('offline')
            onError(`Local AI is unavailable: ${commandErrorMessage(error)}`)
        }
    }, [listModels, onConnected, onError, reconcileModel])

    useEffect(
        () =>
            defer(() => {
                void connect()
            }),
        [connect]
    )

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

function catalogueOf(ai: AiSettings) {
    return `${ai.connectionType} ${activeConnection(ai)?.baseUrl ?? ''}`
}
