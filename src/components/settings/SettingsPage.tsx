import {useEffect, useReducer, useRef} from 'react'
import type {ReactNode} from 'react'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {VStack} from '@astryxdesign/core/Stack'
import {
    AI_SETTINGS_TAB,
    GODOT_SETTINGS_TAB,
    MODELS_SETTINGS_TAB,
    PROMPT_SETTINGS_TAB,
    STORAGE_SETTINGS_TAB
} from '../tab-icons'
import {useCompactTabs} from '../../hooks/useCompactTabs'
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

export function SettingsPage({isOpen, onOpenChange, onCacheDeleted}: SettingsPageProps) {
    const [isCompact, onStrip] = useCompactTabs()
    const hasLoaded = useRef(false)
    const [state, dispatchAny] = useReducer(reduce, INITIAL_SETTINGS_DRAFT)
    const dispatch: (action: SettingsAction) => void = dispatchAny
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
    }, [dispatch])

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
                                    ref={onStrip}
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
                                        isLabelHidden={isCompact}
                                        {...AI_SETTINGS_TAB}
                                    />
                                    <Tab
                                        value='prompt'
                                        label='Agent prompt'
                                        isLabelHidden={isCompact}
                                        {...PROMPT_SETTINGS_TAB}
                                    />
                                    <Tab
                                        value='godot'
                                        label='Godot rules'
                                        isLabelHidden={isCompact}
                                        {...GODOT_SETTINGS_TAB}
                                    />
                                    <Tab
                                        value='models'
                                        label='Documentation models'
                                        isLabelHidden={isCompact}
                                        {...MODELS_SETTINGS_TAB}
                                    />
                                    <Tab
                                        value='storage'
                                        label='Project storage'
                                        isLabelHidden={isCompact}
                                        {...STORAGE_SETTINGS_TAB}
                                    />
                                </TabList>
                            </VStack>
                        </VStack>
                    }
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
