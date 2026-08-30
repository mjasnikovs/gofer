import {useEffect, useMemo, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {EDITOR_TAB, NODE_TAB, PROJECT_TAB} from '../tab-icons'
import {useCompactTabs} from '../../hooks/useCompactTabs'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Table} from '@astryxdesign/core/Table'
import {proportional} from '@astryxdesign/core/Table'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {MetadataList, MetadataListItem} from '@astryxdesign/core/MetadataList'
import {Token} from '@astryxdesign/core/Token'
import MagnifyingGlassIcon from '@heroicons/react/24/outline/MagnifyingGlassIcon'
import {schedule} from '../../services/clock'
import {useEditorSession} from '../../hooks/useEditorSession'
import {useGodotReading} from '../../hooks/useGodotReading'
import {formatGodotValue} from '../../utils/godot-format'
import {isSessionOffline} from '../../models/godot'
import type {GodotNodeConnection, GodotSettingsPage} from '../../models/godot'
import type {GodotSelection} from '../../models/workspace'
import type {InspectorTab} from '../../models/ui-state'
import {PanelState} from './PanelState'

type InspectorPanelProps = Readonly<{
    tab: InspectorTab
    onTabChange: (tab: InspectorTab) => void
    scenePath: string
    selection: GodotSelection | undefined
    onStartSession: () => void
}>

type SettingRow = Readonly<{
    name: string
    value: string
    restart: boolean
    [key: string]: unknown
}>

const SEARCH_DEBOUNCE_MS = 250

function useDebounced(value: string) {
    const [settled, setSettled] = useState(value)
    useEffect(
        () =>
            schedule(() => {
                setSettled(value)
            }, SEARCH_DEBOUNCE_MS),
        [value]
    )
    return settled
}

function connectionLabel(connection: GodotNodeConnection) {
    const notes = [
        connection.deferred === true ? 'deferred' : '',
        connection.oneShot === true ? 'one-shot' : ''
    ].filter(Boolean)
    const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : ''
    return `${connection.signal} → ${connection.target}.${connection.method}${suffix}`
}

function connectionKey(connection: GodotNodeConnection) {
    return `${connection.signal}|${connection.target}|${connection.method}|${JSON.stringify(connection.binds ?? [])}`
}

function settingRows(page: GodotSettingsPage | undefined): SettingRow[] {
    return (page?.settings ?? []).map(setting => ({
        name: setting.name,
        value: formatGodotValue(setting.value),
        restart: setting.restartRequired === true
    }))
}

const NAME_AND_VALUE_COLUMNS = [
    {key: 'name', header: 'Setting', width: proportional(2, {minWidth: 140})},
    {key: 'value', header: 'Value', width: proportional(1, {minWidth: 100})}
] as const

const PROJECT_SETTING_COLUMNS = [
    ...NAME_AND_VALUE_COLUMNS,
    {
        key: 'restart',
        header: 'Restart',
        width: proportional(1, {minWidth: 80}),
        renderCell: (row: SettingRow) =>
            row.restart ?
                <Token
                    size='sm'
                    color='orange'
                    label='Restart'
                />
            :   ''
    }
]

const EDITOR_SETTING_COLUMNS = [...NAME_AND_VALUE_COLUMNS]

export function InspectorPanel({
    tab,
    onTabChange,
    scenePath,
    selection,
    onStartSession
}: InspectorPanelProps) {
    const [isCompact, onStrip] = useCompactTabs()
    const [projectQuery, setProjectQuery] = useState('')
    const [editorQuery, setEditorQuery] = useState('')
    const settledProject = useDebounced(projectQuery)
    const settledEditor = useDebounced(editorQuery)
    const {state, sceneEpoch, runtimeEpoch} = useEditorSession()
    const isOffline = isSessionOffline(state)

    const editedNode = useGodotReading(
        'node.inspect',
        {scene: scenePath, node: selection?.path ?? ''},
        {when: tab === 'node' && selection?.origin === 'edited', follows: sceneEpoch}
    )
    const runtimeNode = useGodotReading(
        'runtime.inspect_node',
        {path: selection?.path ?? ''},
        {when: tab === 'node' && selection?.origin === 'runtime', follows: runtimeEpoch}
    )
    const node = selection?.origin === 'runtime' ? runtimeNode : editedNode

    const project = useGodotReading(
        'project.search_settings',
        {query: settledProject},
        {when: tab === 'project', follows: sceneEpoch}
    )
    const editor = useGodotReading(
        'editor.search_settings',
        {query: settledEditor},
        {when: tab === 'editor', follows: sceneEpoch}
    )

    const projectRows = useMemo(() => settingRows(project.data), [project.data])
    const editorRows = useMemo(() => settingRows(editor.data), [editor.data])

    const offlineNotice = (
        <VStack padding={3}>
            <EmptyState
                isCompact
                headingLevel={3}
                title='No editor running'
                description='The inspector reads a running editor.'
                actions={
                    <Button
                        label='Start Godot'
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
                ref={onStrip}
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
                    isLabelHidden={isCompact}
                    {...NODE_TAB}
                />
                <Tab
                    value='project'
                    label='Project'
                    isLabelHidden={isCompact}
                    {...PROJECT_TAB}
                />
                <Tab
                    value='editor'
                    label='Editor'
                    isLabelHidden={isCompact}
                    {...EDITOR_TAB}
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
                            isLoading={node.isLoading}
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
                                        <Text type='label'>{node.data.name}</Text>
                                        <Token
                                            size='sm'
                                            color={
                                                selection?.origin === 'runtime' ? 'orange' : 'gray'
                                            }
                                            label={
                                                selection?.origin === 'runtime' ?
                                                    'Runtime'
                                                :   'Edited'
                                            }
                                        />
                                    </HStack>
                                    <MetadataList columns='single'>
                                        <MetadataListItem label='Type'>
                                            {node.data.type}
                                        </MetadataListItem>
                                        <MetadataListItem label='Path'>
                                            {node.data.path}
                                        </MetadataListItem>
                                        <MetadataListItem label='Groups'>
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
                                        </MetadataListItem>
                                        {node.data.connections ?
                                            <MetadataListItem label='Connections'>
                                                {node.data.connections.length > 0 ?
                                                    <VStack gap={1}>
                                                        {node.data.connections.map(connection => (
                                                            <Text
                                                                key={connectionKey(connection)}
                                                                type='supporting'
                                                            >
                                                                {connectionLabel(connection)}
                                                            </Text>
                                                        ))}
                                                    </VStack>
                                                :   <Text color='secondary'>None</Text>}
                                            </MetadataListItem>
                                        :   null}
                                    </MetadataList>
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
                                isLoading={project.isLoading}
                                error={project.error}
                                isEmpty={(project.data?.settings.length ?? 0) === 0}
                                emptyTitle='No settings match'
                                emptyDescription='Project settings are stored in the project, on the task’s branch.'
                            >
                                <VStack
                                    gap={2}
                                    padding={0}
                                >
                                    <Table<SettingRow>
                                        data={projectRows}
                                        density='compact'
                                        textOverflow='truncate'
                                        columns={PROJECT_SETTING_COLUMNS}
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
                                    Editor settings are machine-wide and outside the project, so no
                                    task rollback can undo a change to one.
                                </Text>
                            </VStack>
                            <PanelState
                                label='editor settings'
                                isLoading={editor.isLoading}
                                error={editor.error}
                                isEmpty={(editor.data?.settings.length ?? 0) === 0}
                                emptyTitle='No settings match'
                                emptyDescription='These are the editor’s own preferences, not the project’s.'
                            >
                                <Table<SettingRow>
                                    data={editorRows}
                                    density='compact'
                                    textOverflow='truncate'
                                    columns={EDITOR_SETTING_COLUMNS}
                                />
                            </PanelState>
                        </VStack>
                    ))}
            </StackItem>
        </VStack>
    )
}
