import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {Button} from '@astryxdesign/core/Button'
import {Grid} from '@astryxdesign/core/Grid'
import {Icon} from '@astryxdesign/core/Icon'
import {LayoutFooter} from '@astryxdesign/core/Layout'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import CloudArrowDownIcon from '@heroicons/react/24/outline/CloudArrowDownIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {invoke, listen} from '../../services/desktop'
import {
    cacheStateLabel,
    cacheStateVariant,
    formatBytes,
    progressLabel,
    progressValue
} from '../../models/settings'
import {canDeleteCache} from '../../models/settings-draft'
import {SETTINGS_GRID_COLUMNS, settingsBanner} from './settings-view'
import type {ReactNode} from 'react'
import type {SettingsTabView, SettingsView} from './settings-view'
/** The models tab, plus the confirmation the page draws outside the settings dialog. */
type ModelsTabView = SettingsTabView & Readonly<{confirmation: ReactNode}>

/**
 * The local documentation models: what is on disk, and the two buttons that change it.
 *
 * The confirmation is returned rather than rendered here. It stands in front of the settings dialog
 * — which closes while it is open — so a dialog drawn inside this tab's body would be a dialog
 * inside a body that is no longer on screen.
 */
export function useModelsTab(view: SettingsView, onCacheDeleted: () => void): ModelsTabView {
    const {state, dispatch, run} = view
    const {busy, cache, progress} = state
    const value = progressValue(progress)
    const isDeletable = canDeleteCache(state)

    const refreshCache = async () => {
        dispatch({type: 'cache-read', cache: await invoke('get_rag_cache_status')})
    }

    const downloadModels = () =>
        run('downloading', 'Models could not be installed', async () => {
            dispatch({type: 'cache-downloading'})
            let unlisten: (() => void) | undefined
            try {
                unlisten = await listen('rag-download-progress', event => {
                    dispatch({type: 'progress', progress: event.payload})
                })
                await invoke('initialize_rag')
                await refreshCache()
                dispatch({
                    type: 'noticed',
                    tab: 'models',
                    notice: {
                        status: 'success',
                        title: 'Documentation models installed',
                        description: 'Gofer can now search the local Godot 4.7 documentation.'
                    }
                })
            } catch (error) {
                // Read back either way: a download that failed part-way still moved the cache, and
                // the page must show what is on disk rather than what was hoped for.
                await refreshCache()
                throw error
            } finally {
                unlisten?.()
            }
        })

    const deleteCache = () =>
        run('deleting', 'Model cache could not be deleted', async () => {
            dispatch({type: 'cache-read', cache: await invoke('delete_rag_cache')})
            dispatch({type: 'delete-dialog', isOpen: false})
            onCacheDeleted()
        })

    return {
        body: (
            <VStack gap={8}>
                {settingsBanner(view, 'models')}

                <Grid
                    columns={SETTINGS_GRID_COLUMNS}
                    gap={10}
                >
                    <VStack gap={2}>
                        <HStack
                            gap={2}
                            vAlign='center'
                        >
                            <Icon
                                icon={CircleStackIcon}
                                size='md'
                                color='accent'
                            />
                            <Heading level={2}>Godot documentation models</Heading>
                        </HStack>
                        <Text color='secondary'>
                            Local embedding and reranking models used to search the Godot 4.7
                            documentation.
                        </Text>
                    </VStack>

                    {cache ?
                        <VStack gap={5}>
                            <VStack gap={3}>
                                <HStack
                                    gap={2}
                                    vAlign='center'
                                >
                                    {/*
                                     * The dot's label is its accessible name, so the plain word
                                     * beside it was announced twice. Qualified here and left plain
                                     * on screen, which is what the frame's session dot does.
                                     */}
                                    <StatusDot
                                        variant={cacheStateVariant(cache.state)}
                                        label={`Model cache: ${cacheStateLabel(cache.state)}`}
                                    />
                                    <Text aria-hidden>{cacheStateLabel(cache.state)}</Text>
                                </HStack>
                                <VStack gap={1}>
                                    <Text type='supporting'>Cache location</Text>
                                    <Text color='secondary'>{cache.path}</Text>
                                </VStack>
                                <VStack gap={1}>
                                    <Text type='supporting'>Disk usage</Text>
                                    <Text color='secondary'>{formatBytes(cache.sizeBytes)}</Text>
                                </VStack>
                            </VStack>

                            {/*
                             * One label, not two. `ProgressBar` draws its own above the bar unless
                             * told to hide it, and the line underneath repeated it word for word.
                             */}
                            {busy.downloading && (
                                <ProgressBar
                                    label={progressLabel(progress)}
                                    value={value ?? 0}
                                    isIndeterminate={value === undefined}
                                    hasValueLabel={value !== undefined}
                                />
                            )}
                        </VStack>
                    :   <Text color='secondary'>
                            {state.isLoading ?
                                'Inspecting the model cache…'
                            :   'Cache status is unavailable.'}
                        </Text>
                    }
                </Grid>
            </VStack>
        ),
        footer:
            cache ?
                <LayoutFooter
                    hasDivider
                    label='Documentation model actions'
                >
                    <HStack
                        gap={3}
                        hAlign='end'
                    >
                        <Button
                            label='Delete model cache'
                            variant='destructive'
                            icon={
                                <Icon
                                    icon={TrashIcon}
                                    size='sm'
                                />
                            }
                            isDisabled={!isDeletable}
                            clickAction={() => {
                                dispatch({
                                    type: 'delete-dialog',
                                    isOpen: true
                                })
                            }}
                        />
                        {cache.state !== 'installed' && (
                            <Button
                                label='Download models'
                                variant='primary'
                                icon={
                                    <Icon
                                        icon={CloudArrowDownIcon}
                                        size='sm'
                                    />
                                }
                                isLoading={busy.downloading}
                                /*
                                 * Started rather than awaited. `Button` runs `clickAction` inside
                                 * `startTransition`, and React holds the old screen for as long as
                                 * a transition is pending — so awaiting a 1.68 GiB download here
                                 * meant the progress bar and the Busy badge this sets did not
                                 * appear until the download was already over. Returning at once
                                 * ends the transition and lets the rest paint as it happens; the
                                 * button still spins, on `busy.downloading` above.
                                 */
                                clickAction={() => {
                                    void downloadModels()
                                }}
                            />
                        )}
                    </HStack>
                </LayoutFooter>
            :   undefined,
        confirmation: (
            <AlertDialog
                isOpen={state.isDeleteOpen}
                onOpenChange={isDeleteOpen => {
                    dispatch({type: 'delete-dialog', isOpen: isDeleteOpen})
                }}
                title='Delete documentation model cache?'
                description='This removes only the downloaded embedding and reranking models. Gofer will return to the preparation screen and download approximately 1.68 GiB again.'
                actionLabel='Delete model cache'
                isActionLoading={busy.deleting}
                onAction={deleteCache}
            />
        )
    }
}
