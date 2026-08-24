import {useEffect, useReducer, useRef} from 'react'
import type {ReactNode} from 'react'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {VStack} from '@astryxdesign/core/Stack'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {invoke, isTauri} from '../../services/desktop'
import {commandErrorMessage} from '../../utils/command-error'
import {INITIAL_SETTINGS_DRAFT, reduce, runSettingsTask} from '../../models/settings-draft'
import type {SettingsAction, SettingsTab, SettingsTask} from '../../models/settings-draft'
import {useAiTab} from './AiTab'
import {useGodotTab} from './GodotTab'
import {useModelsTab} from './ModelsTab'
import {usePromptTab} from './PromptTab'
import {useStorageTab} from './StorageTab'
import type {SettingsView} from './settings-view'

type SettingsPageProps = Readonly<{
    isOpen: boolean
    onOpenChange: (isOpen: boolean) => void
    onCacheDeleted: () => void
}>

/**
 * The settings dialog: the draft every tab edits, the tab strip, and the body and footer of
 * whichever tab is showing.
 *
 * The five tabs were five `const`s inside this function, which was 1,458 lines long and the only
 * way to reach any of them. Each is a module now, and what it is given is `SettingsView` — the
 * draft, the dispatch, and the task runner. Everything else a tab needs it derives for itself.
 *
 * All five are called on every render rather than only the one on screen, which is what the five
 * `const`s did too: the model lists and the sign-in state belong to a tab that is still there when
 * the user clicks away from it and back.
 */
export function SettingsPage({isOpen, onOpenChange, onCacheDeleted}: SettingsPageProps) {
    const hasLoaded = useRef(false)
    const [state, dispatchAny] = useReducer(reduce, INITIAL_SETTINGS_DRAFT)
    /*
     * Narrowed on purpose. `began`, `ended` and `failed` are one protocol in a fixed order, and
     * this page used to narrate it eight times; typing the page's dispatch to the other union is
     * what makes writing a ninth copy a compile error rather than a habit.
     */
    const dispatch: (action: SettingsAction) => void = dispatchAny
    /** Runs one task, and owns its began / failed / ended. See `runSettingsTask`. */
    const run = (task: SettingsTask, title: string, work: () => Promise<void>) =>
        runSettingsTask(dispatchAny, task, title, work)
    const view: SettingsView = {state, dispatch, run}
    const {tab} = state

    useEffect(() => {
        if (hasLoaded.current) return
        hasLoaded.current = true

        const load = async () => {
            if (!isTauri()) {
                dispatch({
                    type: 'unavailable',
                    notice: {
                        status: 'warning',
                        title: 'Desktop app required',
                        description:
                            'Local settings and model management are available in the Tauri desktop app.'
                    }
                })
                return
            }

            try {
                const [response, cacheResponse, prompt] = await Promise.all([
                    invoke('load_settings'),
                    invoke('get_rag_cache_status'),
                    invoke('read_agent_prompt')
                ])
                dispatch({type: 'loaded', response, cache: cacheResponse, prompt})
            } catch (error) {
                dispatch({
                    type: 'unavailable',
                    notice: {
                        status: 'error',
                        title: 'Settings could not be loaded',
                        description: commandErrorMessage(error)
                    }
                })
            }
        }

        void load()
    }, [])

    const ai = useAiTab(view)
    const prompt = usePromptTab(view)
    const godot = useGodotTab(view)
    const models = useModelsTab(view, onCacheDeleted)
    const storage = useStorageTab(view)

    const tabs: Readonly<Record<SettingsTab, {body: ReactNode; footer: ReactNode}>> = {
        ai,
        prompt,
        godot,
        models,
        storage
    }

    return (
        <>
            <Dialog
                isOpen={isOpen && !state.isDeleteOpen}
                onOpenChange={nextOpen => {
                    if (!nextOpen) ai.cancelPendingLogin()
                    onOpenChange(nextOpen)
                }}
                purpose='form'
                width={960}
                maxHeight='90vh'
            >
                <Layout
                    height='fill'
                    header={
                        <VStack gap={0}>
                            <DialogHeader
                                title='Settings'
                                subtitle='Configuration is owned by Gofer and stored only on this device.'
                                hasDivider={false}
                                onOpenChange={onOpenChange}
                            />
                            <VStack
                                gap={0}
                                paddingInline={6}
                            >
                                <TabList
                                    hasDivider
                                    aria-label='Settings sections'
                                    value={tab}
                                    onChange={chosen => {
                                        dispatch({
                                            type: 'tab-chosen',
                                            tab: chosen as SettingsTab
                                        })
                                    }}
                                >
                                    <Tab
                                        value='ai'
                                        label='AI connection'
                                    />
                                    <Tab
                                        value='prompt'
                                        label='Agent prompt'
                                    />
                                    <Tab
                                        value='godot'
                                        label='Godot rules'
                                    />
                                    <Tab
                                        value='models'
                                        label='Documentation models'
                                    />
                                    <Tab
                                        value='storage'
                                        label='Project storage'
                                    />
                                </TabList>
                            </VStack>
                        </VStack>
                    }
                    /*
                     * A floor under the body, because the tabs are wildly different heights: the
                     * connection form overflows a 1280x800 window while project storage is two
                     * lines. Without it the dialog collapsed from 780px to 280px on a tab click,
                     * and the footer buttons jumped most of the way up the screen. 520 is what
                     * fills the shortest window this dialog is designed for once its header and
                     * footer are taken out, so the taller tabs still scroll rather than stretch.
                     */
                    content={
                        <LayoutContent padding={6}>
                            <VStack
                                gap={0}
                                minHeight={520}
                            >
                                {tabs[tab].body}
                            </VStack>
                        </LayoutContent>
                    }
                    footer={tabs[tab].footer}
                />
            </Dialog>
            {models.confirmation}
        </>
    )
}

export default SettingsPage
