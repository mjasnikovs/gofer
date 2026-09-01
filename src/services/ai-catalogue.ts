import {activeConnection, adoptModelReasoning, adoptSubagentReasoning} from '../models/settings'
import {AI_CONNECTION_SECRETS, connectionProfile} from '../models/settings'
import {applyModelSelection, selectAiDriver, withActiveConnection} from '../models/settings'
import type {
    AiConnectionType,
    AiModelOption,
    AiSettings,
    GoferSettings,
    SettingsRequest
} from '../models/settings'
import {settingsRequest} from '../models/settings-draft'
import type {SettingsDraft} from '../models/settings-draft'

/**
 * The question a model catalogue answers, which is what a cached answer is cached against.
 *
 * The driver alone is not the question: OpenRouter and Cerebras are fixed addresses, but the local
 * driver's is typed by the user, and a catalogue read for one address says nothing about another.
 * Keyed on the driver alone in one hook and on the driver and the address in another, the settings
 * page did not re-list when the Base URL was edited and the composer did — the same question with
 * two answers in one running window.
 */
export function catalogueKey(ai: AiSettings): string {
    return `${ai.connectionType} ${activeConnection(ai)?.baseUrl ?? ''}`
}

export type CatalogueAsk = Readonly<{key: string; request: SettingsRequest}>

/**
 * What to ask a catalogue, and the key its answer is filed under, from one settings object.
 *
 * They were built from two: the key from the confirmed settings and the request from the draft. A
 * driver switched away and back re-asked the question, sent the address the user had just typed,
 * and filed what came back under the address it replaced. Both come from the confirmed settings
 * now, which is what `savedSettings` says the question is about.
 *
 * A typed key travels only while the draft still points at the saved address. A key is typed
 * against the address in the box above it, and this asks the *saved* one — so on a driver whose
 * address the user types, editing both and letting a listing fire would hand the new host's key
 * to the old host. The saved key is what the saved address is entitled to.
 */
export function catalogueAsk(
    state: SettingsDraft,
    driver: AiConnectionType
): CatalogueAsk | undefined {
    const request = settingsRequest(state)
    const saved = state.savedSettings
    if (!request || !saved) return undefined
    const ai = selectAiDriver(saved.ai, driver)
    const secret = AI_CONNECTION_SECRETS[driver]
    const moved =
        connectionProfile(state.settings?.ai ?? ai, driver)?.baseUrl
        !== connectionProfile(saved.ai, driver)?.baseUrl
    const secrets =
        moved ? {...request.secrets, [secret]: {action: 'keep'} as const} : request.secrets
    return {key: catalogueKey(ai), request: {...request, secrets, settings: {...saved, ai}}}
}

/**
 * What a catalogue's answer changes about the settings, or nothing when it changes nothing.
 *
 * One rule, because there were two and neither knew about the other: the composer silently adopted
 * a server's sole model for any driver, and the settings page silently adopted the first listed
 * model for ChatGPT alone. Whichever wrote last won, and what it wrote depended on which of the two
 * the user had open.
 */
export function reconciled(
    available: readonly AiModelOption[],
    loaded: GoferSettings
): GoferSettings | undefined {
    const chosen = activeConnection(loaded.ai)
    const configured = available.find(model => model.id === chosen?.model.id)
    const withChild = adoptSubagentReasoning(loaded.ai, loaded.ai.connectionType, available)
    if (!configured || !chosen) {
        const onlyModel = available.length === 1 ? available[0] : undefined
        if (onlyModel) {
            return {
                ...loaded,
                ai: withActiveConnection(withChild, connection => ({
                    ...connection,
                    model: applyModelSelection(connection.model, onlyModel)
                }))
            }
        }
        return withChild === loaded.ai ? undefined : {...loaded, ai: withChild}
    }
    const model = adoptModelReasoning(chosen.model, configured)
    const ai =
        model === chosen.model ?
            withChild
        :   withActiveConnection(withChild, connection => ({...connection, model}))
    return ai === loaded.ai ? undefined : {...loaded, ai}
}
