import {useMemo, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import {Tooltip} from '@astryxdesign/core/Tooltip'
import {IconButton} from '@astryxdesign/core/IconButton'
import {Icon} from '@astryxdesign/core/Icon'
import AtSymbolIcon from '@heroicons/react/24/outline/AtSymbolIcon'
import MagnifyingGlassIcon from '@heroicons/react/24/outline/MagnifyingGlassIcon'
import {TreeList} from '@astryxdesign/core/TreeList'
import type {TreeListItemData} from '@astryxdesign/core/TreeList'
import {useEditorSession} from '../../hooks/useEditorSession'
import {useGodotReading} from '../../hooks/useGodotReading'
import {useGodotClassIcons} from '../../hooks/useGodotClassIcons'
import {useChatReferences} from '../../hooks/useChatReferences'
import type {ChatReferenceSink} from '../../hooks/useChatReferences'
import type {ChatReference} from '../../utils/chat-references'
import type {ClassIcons} from '../../hooks/useGodotClassIcons'
import {buildPathTree, filterSceneTree} from '../../utils/godot-format'
import type {PathTreeNode} from '../../utils/godot-format'
import type {GodotSelection} from '../../models/workspace'
import {isSessionOffline, isSessionReadable} from '../../models/godot'
import type {GodotNode} from '../../models/godot'
import type {WorkspaceEntry} from '../../models/script'
import type {ExplorerTab} from '../../models/ui-state'
import {PanelState} from './PanelState'

type ExplorerPanelProps = Readonly<{
    tab: ExplorerTab
    onTabChange: (tab: ExplorerTab) => void
    files: readonly WorkspaceEntry[]
    selection: GodotSelection | undefined
    onSelect: (selection: GodotSelection) => void
    onOpenFile: (path: string) => void
    onOpenScene: (path: string) => void
    onOpenMainScene: () => void
    onStartSession: () => void
}>

const MAX_LISTED_FILES = 400

const MAX_TREE_NODES = 4096

const WHOLE_TREE = {limit: MAX_TREE_NODES} as const
const HIDDEN_SUFFIXES = ['.import', '.uid', '.tmp']
const HIDDEN_PREFIXES = ['.godot/', '.git/', 'addons/gofer/']
const EDITABLE_SUFFIXES = ['.gd', '.cfg', '.godot', '.json', '.md', '.txt', '.tres']
const SCENE_SUFFIX = '.tscn'

const ROW_LABEL_STYLE = {minWidth: 0, overflow: 'hidden'} as const

const ROW_NAME_STYLE = {minWidth: 0} as const

const NODE_ICON_STYLE = {
    width: 'var(--spacing-4)',
    height: 'var(--spacing-4)',
    flexShrink: 0
} as const

function isListable(path: string) {
    if (HIDDEN_SUFFIXES.some(suffix => path.endsWith(suffix))) return false
    return !HIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))
}

function isEditable(path: string) {
    return EDITABLE_SUFFIXES.some(suffix => path.endsWith(suffix))
}

function isScene(path: string) {
    return path.endsWith(SCENE_SUFFIX)
}

function NodeIcon({icon, type}: Readonly<{icon: string | undefined; type: string}>) {
    if (icon === undefined) {
        return (
            <span
                role='img'
                aria-label={type}
                style={NODE_ICON_STYLE}
            />
        )
    }
    return (
        <img
            src={icon}
            alt={type}
            style={NODE_ICON_STYLE}
        />
    )
}

function MentionButton({
    name,
    reference,
    references
}: Readonly<{name: string; reference: ChatReference; references: ChatReferenceSink}>) {
    return (
        <span className='gofer-row-action'>
            <IconButton
                label={`Mention ${name} in the message`}
                size='sm'
                variant='ghost'
                icon={
                    <Icon
                        icon={AtSymbolIcon}
                        size='sm'
                    />
                }
                clickAction={() => {
                    references.add(reference)
                }}
            />
        </span>
    )
}

type NodeTreeContext = Readonly<{
    origin: GodotSelection['origin']
    selected: string | undefined
    icons: ClassIcons
    onSelect: (selection: GodotSelection) => void
    references: ChatReferenceSink | undefined
}>

function nodeItems(node: GodotNode, context: NodeTreeContext): TreeListItemData {
    const {origin, selected, icons, onSelect, references} = context
    return {
        id: `${origin}:${node.path}`,
        label: (
            <Tooltip
                content={node.type}
                placement='below'
                alignment='start'
                hasHoverIndication={false}
            >
                <HStack
                    gap={2}
                    vAlign='center'
                    width='100%'
                    style={ROW_LABEL_STYLE}
                >
                    <NodeIcon
                        icon={icons[node.icon ?? node.type]}
                        type={node.type}
                    />
                    <Text
                        maxLines={1}
                        style={ROW_NAME_STYLE}
                    >
                        {node.name}
                    </Text>
                </HStack>
            </Tooltip>
        ),
        ...(references && {
            startContent: (
                <MentionButton
                    name={node.name}
                    reference={{kind: 'node', id: node.path, detail: node.type}}
                    references={references}
                />
            )
        }),
        isExpanded: true,
        isSelected: selected === node.path,
        onClick: () => {
            onSelect({origin, path: node.path, name: node.name, type: node.type})
        },
        ...(node.children.length > 0 && {
            children: node.children.map(child => nodeItems(child, context))
        })
    }
}

type FileTreeContext = Readonly<{
    onOpenFile: (path: string) => void
    onOpenScene: (path: string) => void
    references: ChatReferenceSink | undefined
}>

function fileItems(nodes: readonly PathTreeNode[], context: FileTreeContext): TreeListItemData[] {
    const {onOpenFile, onOpenScene, references} = context
    return nodes.map(node => {
        const canOpen = isEditable(node.path) || isScene(node.path)
        return {
            id: node.path,
            label:
                node.isDirectory || canOpen ?
                    node.name
                :   <Text
                        color='secondary'
                        maxLines={1}
                    >
                        {node.name}
                    </Text>,
            ...(references && {
                startContent: (
                    <MentionButton
                        name={node.name}
                        reference={{
                            kind: 'file',
                            id: node.isDirectory ? `${node.path}/` : node.path
                        }}
                        references={references}
                    />
                )
            }),
            ...(node.isDirectory ? {isExpanded: true, children: fileItems(node.children, context)}
            : canOpen ?
                {
                    onClick: () => {
                        if (isScene(node.path)) onOpenScene(node.path)
                        else onOpenFile(node.path)
                    }
                }
            :   {})
        }
    })
}

function truncatedNotice(truncated: boolean | undefined) {
    if (truncated !== true) return null
    return (
        <VStack paddingInline={3}>
            <Text
                type='supporting'
                color='secondary'
            >
                This scene is larger than one read answers with; the tree above stops short.
            </Text>
        </VStack>
    )
}

export function ExplorerPanel({
    tab,
    onTabChange,
    files,
    selection,
    onSelect,
    onOpenFile,
    onOpenScene,
    onOpenMainScene,
    onStartSession
}: ExplorerPanelProps) {
    const {call, state, sceneEpoch, runtimeEpoch} = useEditorSession()
    const isOffline = isSessionOffline(state)

    const scene = useGodotReading('scene.get_tree', WHOLE_TREE, {
        when: tab === 'scene',
        follows: sceneEpoch
    })
    const runtime = useGodotReading('runtime.get_tree', WHOLE_TREE, {
        when: tab === 'runtime',
        follows: runtimeEpoch
    })

    const isGameIdle = runtime.error?.code === 'runtime_not_running'

    const shownRoot = tab === 'runtime' ? runtime.data?.root : scene.data?.root
    const icons = useGodotClassIcons(call, shownRoot, isSessionReadable(state) && tab !== 'files')
    const references = useChatReferences()
    const [fileFilter, setFileFilter] = useState('')
    const [nodeFilter, setNodeFilter] = useState('')

    const sceneRoot = useMemo(() => {
        const root = scene.data?.root
        return root ? filterSceneTree(root, nodeFilter) : undefined
    }, [scene.data, nodeFilter])
    const runtimeRoot = useMemo(() => {
        const root = runtime.data?.root
        return root ? filterSceneTree(root, nodeFilter) : undefined
    }, [runtime.data, nodeFilter])

    const selectedPath = selection?.path
    const sceneItems = useMemo(
        () =>
            sceneRoot ?
                [
                    nodeItems(sceneRoot, {
                        origin: 'edited',
                        selected: selectedPath,
                        icons,
                        onSelect,
                        references
                    })
                ]
            :   undefined,
        [icons, onSelect, references, sceneRoot, selectedPath]
    )
    const runtimeItems = useMemo(
        () =>
            runtimeRoot ?
                [
                    nodeItems(runtimeRoot, {
                        origin: 'runtime',
                        selected: selectedPath,
                        icons,
                        onSelect,
                        references
                    })
                ]
            :   undefined,
        [icons, onSelect, references, runtimeRoot, selectedPath]
    )

    const listed = useMemo(
        () =>
            files
                .filter(file => isListable(file.path))
                .filter(file => file.path.toLowerCase().includes(fileFilter.toLowerCase()))
                .slice(0, MAX_LISTED_FILES),
        [files, fileFilter]
    )

    const fileTree = useMemo(
        () =>
            fileItems(buildPathTree(listed.map(file => file.path)), {
                onOpenFile,
                onOpenScene,
                references
            }),
        [listed, onOpenFile, onOpenScene, references]
    )

    const offline = (
        <VStack padding={3}>
            <EmptyState
                isCompact
                headingLevel={3}
                title='No editor running'
                description='Gofer starts one Godot editor on the project, holding the active task branch.'
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
                aria-label='Explorer views'
                value={tab}
                onChange={value => {
                    onTabChange(value as ExplorerTab)
                }}
            >
                <Tab
                    value='scene'
                    label='Scene'
                />
                <Tab
                    value='files'
                    label='Files'
                />
                <Tab
                    value='runtime'
                    label='Runtime'
                />
            </TabList>
            {tab === 'files' ?
                <VStack
                    paddingInline={3}
                    paddingBlock={2}
                >
                    <TextInput
                        label='Filter files'
                        isLabelHidden
                        size='sm'
                        startIcon={MagnifyingGlassIcon}
                        value={fileFilter}
                        hasClear
                        onChange={setFileFilter}
                    />
                </VStack>
            :   <>
                    <Toolbar
                        label='Explorer actions'
                        size='sm'
                        dividers={['bottom']}
                        startContent={
                            <Text
                                type='supporting'
                                color='secondary'
                            >
                                {tab === 'scene' ? 'Edited scene' : 'Running game'}
                            </Text>
                        }
                        endContent={
                            <Button
                                label='Refresh'
                                size='sm'
                                variant='ghost'
                                isDisabled={isOffline}
                                clickAction={tab === 'scene' ? scene.reload : runtime.reload}
                            />
                        }
                    />
                    {!isOffline && (
                        <VStack
                            paddingInline={2}
                            paddingBlock={2}
                        >
                            <TextInput
                                label='Filter nodes'
                                isLabelHidden
                                size='sm'
                                startIcon={MagnifyingGlassIcon}
                                value={nodeFilter}
                                hasClear
                                onChange={setNodeFilter}
                            />
                        </VStack>
                    )}
                </>
            }
            <StackItem
                size='fill'
                isScrollable
            >
                {tab === 'scene'
                    && (isOffline ? offline : (
                        <PanelState
                            label='scene tree'
                            isLoading={scene.isLoading}
                            error={scene.error}
                            isEmpty={!sceneRoot}
                            emptyTitle={
                                scene.data?.root ? 'No node matches the filter' : 'No scene is open'
                            }
                            emptyDescription={
                                scene.data?.root ?
                                    'Nodes are matched by their name and by their class.'
                                :   'Open a scene from Files, or open the one the project runs.'
                            }
                            emptyAction={
                                <Button
                                    label='Open main scene'
                                    size='sm'
                                    clickAction={onOpenMainScene}
                                />
                            }
                        >
                            {sceneItems ?
                                <TreeList
                                    density='compact'
                                    variant='noGuides'
                                    items={sceneItems}
                                />
                            :   null}
                            {truncatedNotice(scene.data?.truncated)}
                        </PanelState>
                    ))}
                {tab === 'runtime'
                    && (isOffline ? offline : (
                        <PanelState
                            label='runtime tree'
                            isLoading={runtime.isLoading}
                            {...(!isGameIdle && {error: runtime.error})}
                            isEmpty={isGameIdle || !runtimeRoot}
                            emptyTitle={
                                runtime.data?.root ?
                                    'No node matches the filter'
                                :   'The game is not running'
                            }
                            emptyDescription={
                                runtime.data?.root ?
                                    'Nodes are matched by their name and by their class.'
                                :   'Run the game to inspect the tree it holds in memory.'
                            }
                        >
                            {runtimeItems ?
                                <TreeList
                                    density='compact'
                                    variant='noGuides'
                                    items={runtimeItems}
                                />
                            :   null}
                            {truncatedNotice(runtime.data?.truncated)}
                        </PanelState>
                    ))}
                {tab === 'files' && (
                    <PanelState
                        label='project listing'
                        isLoading={false}
                        isEmpty={fileTree.length === 0}
                        emptyTitle='No files match'
                        emptyDescription='The project is only listed while a task is active.'
                    >
                        <TreeList
                            density='compact'
                            variant='noGuides'
                            items={fileTree}
                        />
                    </PanelState>
                )}
            </StackItem>
        </VStack>
    )
}
