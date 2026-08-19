import {useEffect, useMemo, useState} from 'react'
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
    /** The scene the editor has open. `node.inspect` refuses a request naming any other scene. */
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
    useEffect(
        () =>
            schedule(() => {
                setSettled(value)
            }, SEARCH_DEBOUNCE_MS),
        [value]
    )
    return settled
}

/**
 * One connection as a sentence: the signal, the node that hears it, and the method it calls.
 *
 * The arrow is the whole point — a list of signal names says what a node *can* emit, and what the
 * panel is asked for is what is actually wired to what. Deferred and one-shot are named because
 * they change when the method runs, and a connection that fires once is a different thing.
 */
function connectionLabel(connection: GodotNodeConnection) {
    const notes = [
        connection.deferred === true ? 'deferred' : '',
        connection.oneShot === true ? 'one-shot' : ''
    ].filter(Boolean)
    const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : ''
    return `${connection.signal} → ${connection.target}.${connection.method}${suffix}`
}

/** Two connections differ by their bound arguments alone, so those belong in the key. */
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

/*
 * The two tables' shapes, which do not depend on anything the panel holds.
 *
 * Written inline they were a new array of new column objects on every render, and this panel
 * re-renders on every keystroke in the search box above the table — the query is state here and the
 * debounce only delays the request, not the redraw. A `Table` handed a new `columns` and a new
 * `data` has nothing left to compare.
 */
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
                <Badge
                    variant='warning'
                    label='Restart'
                />
            :   ''
    }
]

const EDITOR_SETTING_COLUMNS = [...NAME_AND_VALUE_COLUMNS]

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
    scenePath,
    selection,
    onStartSession
}: InspectorPanelProps) {
    const [projectQuery, setProjectQuery] = useState('')
    const [editorQuery, setEditorQuery] = useState('')
    const settledProject = useDebounced(projectQuery)
    const settledEditor = useDebounced(editorQuery)
    const {state, sceneEpoch, runtimeEpoch} = useEditorSession()
    const isOffline = isSessionOffline(state)

    /*
     * The edited node and the runtime node are two readings rather than one with a branch inside
     * it, because they are two things: one is what the editor would save, the other is what the
     * running game holds in memory. Each is asked only while its own origin is the chosen one, so
     * switching origin clears the answer that no longer describes what is selected.
     */
    const editedNode = useGodotReading(
        'node.inspect',
        {scene: scenePath, node: selection?.path ?? ''},
        {when: tab === 'node' && selection?.origin === 'edited', follows: sceneEpoch}
    )
    // The running game's epoch, not the editor's. A runtime node's properties move when the game
    // steps, and `debugPaused` is not a runtime state — so following the scene left the Node tab
    // showing values frozen at the moment of selection, for as long as the pause lasted, with no
    // refresh control to escape it. The mirror was just as wrong: an edit in the editor refetched
    // a node from the game for nothing.
    const runtimeNode = useGodotReading(
        'runtime.inspect_node',
        {path: selection?.path ?? ''},
        {when: tab === 'node' && selection?.origin === 'runtime', follows: runtimeEpoch}
    )
    const node = selection?.origin === 'runtime' ? runtimeNode : editedNode

    /*
     * Both follow the scene epoch, which is as close as this panel can currently get.
     *
     * Neither used to follow anything, so both defaulted to zero and were asked exactly once per
     * tab visit — and this panel wires no refresh control, so there was no way to ask again short
     * of leaving the tab. Following the scene at least refetches when the editor moves to another
     * scene, which is the common case for a stale reading here.
     *
     * It is not the whole fix, and the difference is worth stating: `sceneEpoch` moves only on the
     * addon's `scene.changed` event, so `project.set_autoload`, `project.set_input_action` and
     * `editor.set_setting` still do not refetch these tables. Closing that needs an epoch a
     * project or editor write moves, and the addon emits no event for either.
     */
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

    // Kept until the answer itself changes, for the same reason the columns are hoisted: a
    // keystroke in the search box is not a new answer to draw.
    const projectRows = useMemo(() => settingRows(project.data), [project.data])
    const editorRows = useMemo(() => settingRows(editor.data), [editor.data])

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
                                    {node.data.connections ?
                                        <VStack gap={1}>
                                            <Text
                                                type='supporting'
                                                color='secondary'
                                            >
                                                Connections
                                            </Text>
                                            {node.data.connections.length > 0 ?
                                                node.data.connections.map(connection => (
                                                    <Text
                                                        key={connectionKey(connection)}
                                                        type='supporting'
                                                    >
                                                        {connectionLabel(connection)}
                                                    </Text>
                                                ))
                                            :   <Text color='secondary'>None</Text>}
                                        </VStack>
                                    :   null}
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
