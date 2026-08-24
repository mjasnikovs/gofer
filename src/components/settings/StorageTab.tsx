import {Button} from '@astryxdesign/core/Button'
import {Icon} from '@astryxdesign/core/Icon'
import {LayoutFooter} from '@astryxdesign/core/Layout'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import ArchiveBoxIcon from '@heroicons/react/24/outline/ArchiveBoxIcon'
import {invoke} from '../../services/desktop'
import {settingsBanner} from './settings-view'
import type {SettingsTabView, SettingsView} from './settings-view'

/** What the project database is holding, and the two buttons that act on it. */
export function useStorageTab(view: SettingsView): SettingsTabView {
    const {state, dispatch, run} = view
    const {busy} = state

    const createBackup = () =>
        run('backingUp', 'Backup failed', async () => {
            const result = await invoke('create_project_backup')
            dispatch({
                type: 'noticed',
                tab: 'storage',
                notice: {
                    status: 'success',
                    title: 'Project backup created',
                    description: result.path
                }
            })
        })

    const cleanStorage = () =>
        run('cleaningStorage', 'Storage cleanup failed', async () => {
            const result = await invoke('run_storage_maintenance')
            dispatch({
                type: 'noticed',
                tab: 'storage',
                notice: {
                    status: 'success',
                    title: 'Storage maintenance complete',
                    description: `${String(result.attachmentsRemoved)} attachments, ${String(result.blobsRemoved)} blobs, ${String(result.godotRunsRemoved)} old Godot runs, ${String(result.sketchesRemoved)} sketches, ${String(result.docsAnswersRemoved)} stale manual answers, ${String(result.memoryVectorsRemoved)} orphaned memory vectors, and ${String(result.backupsRemoved)} old backups removed. ${String(result.memoryEmbeddingsRestored)} memory embeddings restored, ${String(result.memoryVectorsRefiled)} re-filed.`
                }
            })
        })

    return {
        body: (
            <VStack gap={8}>
                {settingsBanner(view, 'storage')}

                {/*
                 * No Grid here, unlike the other three: both of this tab's controls live in its
                 * footer, so there is no right-hand column for a two-column layout to hold.
                 */}
                <VStack gap={2}>
                    <HStack
                        gap={2}
                        vAlign='center'
                    >
                        <Icon
                            icon={ArchiveBoxIcon}
                            size='md'
                            color='accent'
                        />
                        <Heading level={2}>Project storage</Heading>
                    </HStack>
                    <Text color='secondary'>
                        Back up the active project database, attachments, and Godot logs. Cleanup
                        retains five backups and thirty days of completed run logs.
                    </Text>
                </VStack>
            </VStack>
        ),
        footer: (
            <LayoutFooter
                hasDivider
                label='Project storage actions'
            >
                <HStack
                    gap={3}
                    hAlign='end'
                >
                    <Button
                        label='Clean storage'
                        variant='secondary'
                        isLoading={busy.cleaningStorage}
                        isDisabled={busy.backingUp}
                        clickAction={cleanStorage}
                    />
                    {/*
                     * Primary here, where it was secondary before: this tab no longer shares a
                     * footer with Save, so there is only one blue on the screen and it names what
                     * the tab is for.
                     */}
                    <Button
                        label='Back up project'
                        variant='primary'
                        isLoading={busy.backingUp}
                        isDisabled={busy.cleaningStorage}
                        clickAction={createBackup}
                    />
                </HStack>
            </LayoutFooter>
        )
    }
}
