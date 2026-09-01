import {useEffect, useEffectEvent, useRef} from 'react'
import {invoke} from '../../services/desktop'
import {commandErrorMessage} from '../../utils/command-error'
import {activeConnection} from '../../models/settings'
import type {AiModelOption} from '../../models/settings'
import {catalogueAsk} from '../../services/ai-catalogue'
import type {SettingsView} from './settings-view'

/** Which of a project's two model choices a catalogue is being read for. */
export type ModelSeat = 'main' | 'subagent'

/**
 * Keeps one seat's model list in step with the driver it is pointed at.
 *
 * It was written twice, and the two copies asked different questions: the page's own list was keyed
 * on the driver and its address, the sub-agent's on the driver alone, so editing the Base URL
 * re-listed one seat and never the other. The seat is an argument now, which is the only thing the
 * two ever differed by.
 */
export function useModelCatalogue(view: SettingsView, seat: ModelSeat): void {
    const {state, dispatch} = view
    const draft = state.settings
    const subagent = draft?.ai.subagent.connection
    const chosen = seat === 'main' ? draft && activeConnection(draft.ai) : subagent
    const driver = seat === 'main' ? draft?.ai.connectionType : subagent?.connectionType
    const askedFor = useRef<string | undefined>(undefined)
    const asking = useRef(0)

    const ask = driver ? catalogueAsk(state, driver) : undefined
    const key = ask?.key

    const adopt = (models: readonly AiModelOption[]) => {
        const configured = models.find(model => model.id === chosen?.model.id)
        if (configured) {
            dispatch(
                seat === 'main' ?
                    {type: 'model-reconciled', model: configured}
                :   {type: 'subagent-model-reconciled', model: configured}
            )
            return
        }
        // Only ChatGPT, and only the page's own seat. The composer adopts a sole model for any
        // driver because it is about to save one; this page is filling in a draft the user is
        // still editing, and changing a stored model under them is not the same act.
        const sole = models[0]
        if (seat === 'main' && driver === 'openai-codex' && sole)
            dispatch({type: 'model-chosen', model: sole})
    }

    const load = useEffectEvent(() => {
        if (!ask || askedFor.current === ask.key) return
        const attempt = asking.current + 1
        asking.current = attempt
        askedFor.current = ask.key
        void invoke('list_ai_models', {request: ask.request})
            .then(models => {
                if (asking.current !== attempt) return
                dispatch(
                    seat === 'main' ?
                        {type: 'models-listed', models}
                    :   {type: 'subagent-models-listed', models}
                )
                adopt(models)
            })
            .catch((error: unknown) => {
                if (asking.current !== attempt) return
                askedFor.current = undefined
                // The page's own seat says nothing for a local server that is simply not up; the
                // connection banner already does. ChatGPT and the sub-agent have no such banner.
                if (seat === 'main' && driver !== 'openai-codex') return
                dispatch({
                    type: 'noticed',
                    tab: 'ai',
                    notice: {
                        status: 'error',
                        title:
                            seat === 'main' ?
                                'ChatGPT models could not be loaded'
                            :   "The sub-agent's models could not be loaded",
                        description: commandErrorMessage(error)
                    }
                })
            })
    })

    useEffect(() => {
        if (key) load()
    }, [key])
}
