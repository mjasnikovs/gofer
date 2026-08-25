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

/**
 * Owns the AI connection: settings, the available model list, and the selection commands.
 *
 * When the server offers exactly one model and it is not the configured one, that model is
 * adopted automatically — a llama.cpp host usually serves a single model whose id the user has
 * no reason to type by hand. When it *is* the configured one, what the catalogue says it can think
 * is adopted instead. See `adoptModelReasoning` for why only that.
 */
export function useAiConnection({onError, onConnected}: AiConnectionOptions) {
    const [settings, setSettings] = useState<GoferSettings>()
    const [models, setModels] = useState<readonly AiModelOption[]>([])
    const [connectionState, setConnectionState] = useState<ConnectionState>(() =>
        isTauri() ? 'connecting' : 'offline'
    )
    /** Which server the listed models came from, so a save that changed nothing costs nothing. */
    const listedFor = useRef<string | undefined>(undefined)
    /**
     * Which connection attempt is the current one.
     *
     * `connect` is a control — the header offers it by name while the connection is offline — and
     * nothing stopped a second press starting a second attempt over the first. A `load_settings`
     * that is timing out settles *after* the retry that worked, and every write in its tail landed
     * last: the state went back to `offline`, the banner said Local AI was unavailable, and the
     * models the working attempt had listed were painted over by the failed one's. So each attempt
     * takes a number and writes nothing once a later one has started.
     */
    const attempt = useRef(0)

    const listModels = useCallback(async (of: GoferSettings) => {
        const available = await invoke('list_ai_models', {
            request: {
                settings: of,
                apiKey: {action: 'keep'},
                braveApiKey: {action: 'keep'},
                openrouterApiKey: {action: 'keep'}
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
                        openrouterApiKey: {action: 'keep'}
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

    /**
     * Brings the saved settings up to date with the catalogue the server just answered with.
     *
     * Two cases, and the second is the one that was missing. A configured model the server does not
     * serve is replaced, when there is exactly one to replace it with. A configured model the
     * server *does* serve has its facts re-read, because those facts came from a catalogue that may
     * not have been readable the first time — or may not have named this model at all.
     */
    const reconcileModel = useCallback(
        async (available: readonly AiModelOption[], loaded: GoferSettings) => {
            const chosen = activeConnection(loaded.ai)
            const configured = available.find(model => model.id === chosen?.model.id)
            // The sub-agent's model first, and on both paths. It is stored beside the connections
            // rather than inside one, so `withActiveConnection` cannot reach it and the parent's
            // own outcome says nothing about whether it needs re-reading — a parent whose model
            // the catalogue no longer names still has a child whose model it does. Written first
            // so the two changes are one save. See `adoptSubagentReasoning`.
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
    return `${ai.connectionType} ${activeConnection(ai)?.baseUrl ?? ''}`
}
