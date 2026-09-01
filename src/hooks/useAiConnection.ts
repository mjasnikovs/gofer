import {useCallback, useEffect, useRef, useState} from 'react'
import {defer} from '../services/clock'
import {invoke, isTauri, listen} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {applyModelSelection, normalizeSettings, withActiveConnection} from '../models/settings'
import type {AiModelOption, GoferSettings, ThinkingLevel} from '../models/settings'
import {catalogueKey, reconciled} from '../services/ai-catalogue'

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
            request: {settings: of, secrets: {}}
        })
        listedFor.current = catalogueKey(of.ai)
        setModels(available)
        return available
    }, [])

    const saveSettings = useCallback(
        async (nextSettings: GoferSettings, failure: string) => {
            setSettings(nextSettings)
            try {
                await invoke('save_settings', {
                    request: {settings: nextSettings, secrets: {}}
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
            const next = reconciled(available, loaded)
            if (!next) return
            await saveSettings(next, "The model's reasoning support could not be saved")
        },
        [saveSettings]
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
            if (listedFor.current === catalogueKey(saved.ai)) return
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
