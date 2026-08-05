import {useCallback, useMemo} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {StackItem, VStack} from '@astryxdesign/core/Stack'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Text} from '@astryxdesign/core/Text'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import {TreeList} from '@astryxdesign/core/TreeList'
import type {TreeListItemData} from '@astryxdesign/core/TreeList'
import {useGodotQuery} from '../../hooks/useGodotQuery'
import {buildPathTree} from '../../utils/godot-format'
import type {PathTreeNode} from '../../utils/godot-format'
import type {GodotCall, GodotSelection} from '../../models/workspace'
import type {GodotNode, GodotSceneTree, GodotSessionState} from '../../models/godot'
import type {WorkspaceEntry} from '../../models/script'
import {PanelState} from './PanelState'

export type ExplorerTab = 'scene' | 'runtime' | 'files'

type ExplorerPanelProps = Readonly<{
    tab: ExplorerTab
    onTabChange: (tab: ExplorerTab) => void
    call: GodotCall
    state: GodotSessionState
    /** Bumped by the addon's own `scene.changed` events, so an editor-side edit refetches too. */
    sceneEpoch: number
    runtimeEpoch: number
    files: readonly WorkspaceEntry[]
    fileFilter: string
    onFileFilterChange: (filter: string) => void
    selection: GodotSelection | undefined
    onSelect: (selection: GodotSelection) => void
    onOpenFile: (path: string) => void
    onStartSession: () => void
}>

const MAX_LISTED_FILES = 400
/** Generated sidecars and imported artefacts are noise in a project explorer. */
const HIDDEN_SUFFIXES = ['.import', '.uid', '.tmp']
const HIDDEN_PREFIXES = ['.godot/', '.git/', 'addons/gofer/']
/** Only text Gofer can actually open in Monaco is clickable; the rest is listed as context. */
const EDITABLE_SUFFIXES = ['.gd', '.cfg', '.godot', '.json', '.md', '.txt', '.tres', '.tscn']

function isListable(path: string) {
    if (HIDDEN_SUFFIXES.some(suffix => path.endsWith(suffix))) return false
    return !HIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))
}

function isEditable(path: string) {
    return EDITABLE_SUFFIXES.some(suffix => path.endsWith(suffix))
}

function nodeItems(
    node: GodotNode,
    origin: GodotSelection['origin'],
    selected: string | undefined,
    onSelect: (selection: GodotSelection) => void
): TreeListItemData {
    return {
        id: `${origin}:${node.path}`,
        label: node.name,
        description: node.type,
        isExpanded: true,
        isSelected: selected === node.path,
        onClick: () => {
            onSelect({origin, path: node.path, name: node.name, type: node.type})
        },
        ...(node.children.length > 0 && {
            children: node.children.map(child => nodeItems(child, origin, selected, onSelect))
        })
    }
}

function fileItems(
    nodes: readonly PathTreeNode[],
    onOpenFile: (path: string) => void
): TreeListItemData[] {
    return nodes.map(node => ({
        id: node.path,
        label: node.name,
        ...(node.isDirectory ?
            {isExpanded: true, children: fileItems(node.children, onOpenFile)}
        :   {
                isDisabled: !isEditable(node.path),
                onClick: () => {
                    onOpenFile(node.path)
                }
            })
    }))
}

/**
 * The explorer column: the scene the editor has open, the tree of the game that is running, and the
 * worktree's own files.
 *
 * The edited scene and the running scene stay separate concepts here and everywhere else — one is
 * what the editor would save, the other is what the game currently holds in memory, and conflating
 * them would make an inspector reading of a live node look like an editable property.
 */
export function ExplorerPanel({
    tab,
    onTabChange,
    call,
    state,
    sceneEpoch,
    runtimeEpoch,
    files,
    fileFilter,
    onFileFilterChange,
    selection,
    onSelect,
    onOpenFile,
    onStartSession
}: ExplorerPanelProps) {
    const isOffline = state === 'offline' || state === 'error'

    const loadScene = useCallback(() => {
        // The epoch is what makes an editor-side change refetch; reading it here is the dependency.
        void sceneEpoch
        return call('scene.get_tree') as Promise<GodotSceneTree>
    }, [call, sceneEpoch])

    const loadRuntime = useCallback(() => {
        // Likewise: the game starting or stopping is what makes the remote tree refetch.
        void runtimeEpoch
        return call('runtime.get_tree') as Promise<GodotSceneTree>
    }, [call, runtimeEpoch])

    const scene = useGodotQuery(isOffline || tab !== 'scene' ? undefined : loadScene)
    const runtime = useGodotQuery(isOffline || tab !== 'runtime' ? undefined : loadRuntime)

    const listed = useMemo(
        () =>
            files
                .filter(file => isListable(file.path))
                .filter(file => file.path.toLowerCase().includes(fileFilter.toLowerCase()))
                .slice(0, MAX_LISTED_FILES),
        [files, fileFilter]
    )

    const fileTree = useMemo(
        () => fileItems(buildPathTree(listed.map(file => file.path)), onOpenFile),
        [listed, onOpenFile]
    )

    const offline = (
        <VStack padding={3}>
            <EmptyState
                isCompact
                headingLevel={3}
                title='No editor session'
                description='Gofer starts one Godot editor bound to the active task worktree.'
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
                    value='runtime'
                    label='Runtime'
                />
                <Tab
                    value='files'
                    label='Files'
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
                        placeholder='Filter files'
                        value={fileFilter}
                        hasClear
                        onChange={onFileFilterChange}
                    />
                </VStack>
            :   <Toolbar
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
                            isEmpty={!scene.data?.root}
                            emptyTitle='No scene is open'
                            emptyDescription='Open a scene in the editor to inspect its hierarchy.'
                        >
                            {scene.data?.root ?
                                <TreeList
                                    density='compact'
                                    variant='noGuides'
                                    items={[
                                        nodeItems(
                                            scene.data.root,
                                            'edited',
                                            selection?.path,
                                            onSelect
                                        )
                                    ]}
                                />
                            :   null}
                        </PanelState>
                    ))}
                {tab === 'runtime'
                    && (isOffline ? offline : (
                        <PanelState
                            label='runtime tree'
                            isLoading={runtime.isLoading}
                            error={runtime.error}
                            isEmpty={!runtime.data?.root}
                            emptyTitle='The game is not running'
                            emptyDescription='Run the game to inspect the tree it holds in memory.'
                        >
                            {runtime.data?.root ?
                                <TreeList
                                    density='compact'
                                    variant='noGuides'
                                    items={[
                                        nodeItems(
                                            runtime.data.root,
                                            'runtime',
                                            selection?.path,
                                            onSelect
                                        )
                                    ]}
                                />
                            :   null}
                        </PanelState>
                    ))}
                {tab === 'files' && (
                    <PanelState
                        label='worktree listing'
                        isLoading={false}
                        isEmpty={fileTree.length === 0}
                        emptyTitle='No files match'
                        emptyDescription='A worktree is only listed while a task is active.'
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
