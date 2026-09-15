import {useCallback, useEffect, useState} from 'react'
import {invoke, isTauri, listen} from '../services/desktop'
import {normalizeSettings} from '../models/settings'
import {commandErrorMessage} from '../utils/command-error'

type GodotHeadless = Readonly<{
    headless: boolean
    isSaving: boolean
    setHeadless: (headless: boolean) => Promise<void>
}>

/** The headless rule the next editor start reads, kept in step with every other writer of it. */
export function useGodotHeadless({
    onError
}: Readonly<{onError: (message: string) => void}>): GodotHeadless {
    const [headless, setLocal] = useState(false)
    const [isSaving, setIsSaving] = useState(false)

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        let dispose: (() => void) | undefined
        void invoke('load_settings').then(
            response => {
                if (!isCancelled) setLocal(normalizeSettings(response.settings).godot.headless)
            },
            (error: unknown) => {
                if (!isCancelled)
                    onError(`The headless setting could not be read: ${commandErrorMessage(error)}`)
            }
        )
        void listen('settings-saved', event => {
            if (!isCancelled) setLocal(normalizeSettings(event.payload.settings).godot.headless)
        }).then(unlisten => {
            if (isCancelled) unlisten()
            else dispose = unlisten
        })
        return () => {
            isCancelled = true
            dispose?.()
        }
    }, [onError])

    // Re-read before writing: the file holds the other Godot rules too, and the settings page
    // may have changed one since this copy was taken.
    const setHeadless = useCallback(
        async (next: boolean) => {
            setIsSaving(true)
            try {
                const current = await invoke('load_settings')
                const response = await invoke('save_godot_settings', {
                    godot: {...normalizeSettings(current.settings).godot, headless: next}
                })
                setLocal(normalizeSettings(response.settings).godot.headless)
            } catch (error) {
                onError(`The headless setting could not be saved: ${commandErrorMessage(error)}`)
            } finally {
                setIsSaving(false)
            }
        },
        [onError]
    )

    return {headless, isSaving, setHeadless}
}
