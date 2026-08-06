import {useCallback, useEffect, useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Button} from '@astryxdesign/core/Button'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Table} from '@astryxdesign/core/Table'
import {proportional} from '@astryxdesign/core/Table'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Token} from '@astryxdesign/core/Token'
import MagnifyingGlassIcon from '@heroicons/react/24/outline/MagnifyingGlassIcon'
import {useGodotQuery} from '../../hooks/useGodotQuery'
import {formatGodotValue} from '../../utils/godot-format'
import {isSessionReadable} from '../../models/godot'
import type {GodotNodeDetails, GodotSessionState, GodotSettingsPage} from '../../models/godot'
import type {GodotCall, GodotSelection} from '../../models/workspace'
import {PanelState} from './PanelState'

export type InspectorTab = 'node' | 'project' | 'editor'

type InspectorPanelProps = Readonly<{
    tab: InspectorTab
    onTabChange: (tab: InspectorTab) => void
    call: GodotCall
    state: GodotSessionState
    /** The scene the editor has open. `node.inspect` refuses a request naming any other scene. */
    scenePath: string
    selection: GodotSelection | undefined
    sceneEpoch: number
    onStartSession: () => void
}>

type SettingRow = Readonly<{
    name: string
    value: string
    restart: boolean
    [key: string]: unknown
}>

/*
 * No placeholder in these filter boxes. The label is hidden — a filter row in a narrow panel
 * cannot spare a label line above a 28 px box — and a placeholder that only repeats the label
 * leaves the field looking like it already holds a value. The magnifier says what the box is for,
 * and the hidden label is what a screen reader announces.
 */
const SEARCH_DEBOUNCE_MS = 250

/** Search reaches the editor's main loop, so keystrokes settle before one query is sent. */
function useDebounced(value: string) {
    const [settled, setSettled] = useState(value)
    useEffect(() => {
        const timer = setTimeout(() => {
            setSettled(value)
        }, SEARCH_DEBOUNCE_MS)
        return () => {
            clearTimeout(timer)
        }
    }, [value])
    return settled
}

function settingRows(page: GodotSettingsPage | undefined): SettingRow[] {
    return (page?.settings ?? []).map(setting => ({
        name: setting.name,
        value: formatGodotValue(setting.value),
        restart: setting.restartRequired === true
    }))
}

/**
 * The inspector column: what one selected node is, and what the project and the editor are
 * configured to be.
 *
 * Everything here is a reading. A setting is written through the typed command that owns its family
 * — an autoload, an input action, and a plugin each have their own — so no generic value editor can
 * put a malformed entry into project.godot, and a machine-wide editor setting keeps the approval
 * gate it has when the agent asks for it.
 */
export function InspectorPanel({
    tab,
    onTabChange,
    call,
    state,
    scenePath,
    selection,
    sceneEpoch,
    onStartSession
}: InspectorPanelProps) {
    const [projectQuery, setProjectQuery] = useState('')
    const [editorQuery, setEditorQuery] = useState('')
    const settledProject = useDebounced(projectQuery)
    const settledEditor = useDebounced(editorQuery)
    const isOffline = state === 'offline' || state === 'error'
    // A session still coming up answers every read with nothing, and nothing would refetch it.
    const isSettling = !isOffline && !isSessionReadable(state)

    const loadNode = useCallback(() => {
        if (!selection) return Promise.resolve(undefined)
        // The epoch is the dependency: a node re-reads when the scene under it changes.
        void sceneEpoch
        return (
            selection.origin === 'edited' ?
                call('node.inspect', {scene: scenePath, node: selection.path})
            :   call('runtime.inspect_node', {path: selection.path})) as Promise<GodotNodeDetails>
    }, [call, scenePath, sceneEpoch, selection])

    const loadProject = useCallback(
        () =>
            call('project.search_settings', {query: settledProject}) as Promise<GodotSettingsPage>,
        [call, settledProject]
    )

    const loadEditor = useCallback(
        () => call('editor.search_settings', {query: settledEditor}) as Promise<GodotSettingsPage>,
        [call, settledEditor]
    )

    const node = useGodotQuery(
        isOffline || isSettling || tab !== 'node' || !selection ? undefined : loadNode
    )
    const project = useGodotQuery(
        isOffline || isSettling || tab !== 'project' ? undefined : loadProject
    )
    const editor = useGodotQuery(
        isOffline || isSettling || tab !== 'editor' ? undefined : loadEditor
    )

    /*
     * The same shape the explorer uses for the same condition. Both panels are on screen together,
     * and offline as one dim sentence beside a titled empty state with an action read as a panel
     * that had failed rather than one waiting for a session that has not started.
     */
    const offlineNotice = (
        <VStack padding={3}>
            <EmptyState
                isCompact
                headingLevel={3}
                title='No editor session'
                description='The inspector reads a running editor session.'
                actions={
                    <Button
                        label='Start editor session'
                        size='sm'
                        clickAction={onStartSession}
                    />
                }
            />
        </VStack>
    )

    return (
        <VStack
            gap={0}
            height='100%'
        >
            <TabList
                size='sm'
                hasDivider
                layout='fill'
                aria-label='Inspector views'
                value={tab}
                onChange={value => {
                    onTabChange(value as InspectorTab)
                }}
            >
                <Tab
                    value='node'
                    label='Node'
                />
                <Tab
                    value='project'
                    label='Project'
                />
                <Tab
                    value='editor'
                    label='Editor'
                />
            </TabList>
            <StackItem
                size='fill'
                isScrollable
            >
                {tab === 'node'
                    && (isOffline ? offlineNotice : (
                        <PanelState
                            label='node'
                            isLoading={node.isLoading || (isSettling && Boolean(selection))}
                            error={node.error}
                            isEmpty={!node.data}
                            emptyTitle='Nothing selected'
                            emptyDescription='Choose a node in the Scene or Runtime explorer.'
                        >
                            {node.data ?
                                <VStack
                                    gap={3}
                                    padding={3}
                                >
                                    <HStack
                                        gap={2}
                                        align='center'
                                    >
                                        <Text weight='semibold'>{node.data.name}</Text>
                                        <Badge
                                            variant={
                                                selection?.origin === 'runtime' ?
                                                    'warning'
                                                :   'neutral'
                                            }
                                            label={
                                                selection?.origin === 'runtime' ?
                                                    'Runtime'
                                                :   'Edited'
                                            }
                                        />
                                    </HStack>
                                    <VStack gap={1}>
                                        <Text
                                            type='supporting'
                                            color='secondary'
                                        >
                                            Type
                                        </Text>
                                        <Text>{node.data.type}</Text>
                                    </VStack>
                                    <VStack gap={1}>
                                        <Text
                                            type='supporting'
                                            color='secondary'
                                        >
                                            Path
                                        </Text>
                                        <Text>{node.data.path}</Text>
                                    </VStack>
                                    <VStack gap={1}>
                                        <Text
                                            type='supporting'
                                            color='secondary'
                                        >
                                            Groups
                                        </Text>
                                        {node.data.groups && node.data.groups.length > 0 ?
                                            <HStack
                                                gap={1}
                                                wrap='wrap'
                                            >
                                                {node.data.groups.map(group => (
                                                    <Token
                                                        key={group}
                                                        size='sm'
                                                        label={group}
                                                    />
                                                ))}
                                            </HStack>
                                        :   <Text color='secondary'>None</Text>}
                                    </VStack>
                                </VStack>
                            :   null}
                        </PanelState>
                    ))}
                {tab === 'project'
                    && (isOffline ? offlineNotice : (
                        <VStack
                            gap={0}
                            height='100%'
                        >
                            <VStack
                                paddingInline={3}
                                paddingBlock={2}
                            >
                                <TextInput
                                    label='Search project settings'
                                    isLabelHidden
                                    size='sm'
                                    startIcon={MagnifyingGlassIcon}
                                    value={projectQuery}
                                    hasClear
                                    onChange={setProjectQuery}
                                />
                            </VStack>
                            <PanelState
                                label='project settings'
                                isLoading={project.isLoading || isSettling}
                                error={project.error}
                                isEmpty={(project.data?.settings.length ?? 0) === 0}
                                emptyTitle='No settings match'
                                emptyDescription='Project settings are stored in the task worktree.'
                            >
                                <VStack
                                    gap={2}
                                    padding={0}
                                >
                                    <Table<SettingRow>
                                        data={settingRows(project.data)}
                                        density='compact'
                                        textOverflow='truncate'
                                        columns={[
                                            {
                                                key: 'name',
                                                header: 'Setting',
                                                width: proportional(2, {minWidth: 140})
                                            },
                                            {
                                                key: 'value',
                                                header: 'Value',
                                                width: proportional(1, {minWidth: 100})
                                            },
                                            {
                                                key: 'restart',
                                                header: 'Restart',
                                                width: proportional(1, {minWidth: 80}),
                                                renderCell: row =>
                                                    row.restart ?
                                                        <Badge
                                                            variant='warning'
                                                            label='Restart'
                                                        />
                                                    :   ''
                                            }
                                        ]}
                                    />
                                    {project.data?.truncated ?
                                        <VStack paddingInline={3}>
                                            <Text
                                                type='supporting'
                                                color='secondary'
                                            >
                                                {`${String(project.data.totalMatches)} settings match; the first ${String(project.data.settings.length)} are shown.`}
                                            </Text>
                                        </VStack>
                                    :   null}
                                </VStack>
                            </PanelState>
                        </VStack>
                    ))}
                {tab === 'editor'
                    && (isOffline ? offlineNotice : (
                        <VStack
                            gap={0}
                            height='100%'
                        >
                            <VStack
                                paddingInline={3}
                                paddingBlock={2}
                                gap={1}
                            >
                                <TextInput
                                    label='Search editor settings'
                                    isLabelHidden
                                    size='sm'
                                    startIcon={MagnifyingGlassIcon}
                                    value={editorQuery}
                                    hasClear
                                    onChange={setEditorQuery}
                                />
                                <Text
                                    type='supporting'
                                    color='secondary'
                                >
                                    Editor settings are machine-wide and outside the worktree, so no
                                    task rollback can undo a change to one.
                                </Text>
                            </VStack>
                            <PanelState
                                label='editor settings'
                                isLoading={editor.isLoading || isSettling}
                                error={editor.error}
                                isEmpty={(editor.data?.settings.length ?? 0) === 0}
                                emptyTitle='No settings match'
                                emptyDescription='These are the editor’s own preferences, not the project’s.'
                            >
                                <Table<SettingRow>
                                    data={settingRows(editor.data)}
                                    density='compact'
                                    textOverflow='truncate'
                                    columns={[
                                        {
                                            key: 'name',
                                            header: 'Setting',
                                            width: proportional(2, {minWidth: 140})
                                        },
                                        {
                                            key: 'value',
                                            header: 'Value',
                                            width: proportional(1, {minWidth: 100})
                                        }
                                    ]}
                                />
                            </PanelState>
                        </VStack>
                    ))}
            </StackItem>
        </VStack>
    )
}
