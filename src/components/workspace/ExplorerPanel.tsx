import {useCallback, useMemo, useState} from 'react'
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
import {useGodotQuery} from '../../hooks/useGodotQuery'
import {useGodotClassIcons} from '../../hooks/useGodotClassIcons'
import {useChatReferences} from '../../hooks/useChatReferences'
import type {ChatReferenceSink} from '../../hooks/useChatReferences'
import type {ClassIcons} from '../../hooks/useGodotClassIcons'
import {buildPathTree, filterSceneTree} from '../../utils/godot-format'
import type {PathTreeNode} from '../../utils/godot-format'
import type {GodotCall, GodotSelection} from '../../models/workspace'
import {isSessionReadable} from '../../models/godot'
import type {GodotNode, GodotSceneTree, GodotSessionState} from '../../models/godot'
import type {WorkspaceEntry} from '../../models/script'
import type {ExplorerTab} from '../../models/ui-state'
import {PanelState} from './PanelState'

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
    /** Opens a scene in the managed editor, which is what every scene-reading panel follows. */
    onOpenScene: (path: string) => void
    /** Opens the scene `project.godot` names, for an editor that is editing none. */
    onOpenMainScene: () => void
    onStartSession: () => void
}>

const MAX_LISTED_FILES = 400
/** Generated sidecars and imported artefacts are noise in a project explorer. */
const HIDDEN_SUFFIXES = ['.import', '.uid', '.tmp']
const HIDDEN_PREFIXES = ['.godot/', '.git/', 'addons/gofer/']
/** Only text Gofer can actually open in Monaco is clickable; the rest is listed as context. */
const EDITABLE_SUFFIXES = ['.gd', '.cfg', '.godot', '.json', '.md', '.txt', '.tres']
/**
 * A scene is opened in the editor rather than in Monaco.
 *
 * Its text is the editor's serialization, not something a person edits by hand, and every panel
 * that reads a scene — the tree, the inspector, the debugger's Run — reads the *edited* scene. A
 * scene opened as text would leave all of them empty while looking like it had been opened.
 */
const SCENE_SUFFIX = '.tscn'

/*
 * A deep branch leaves a long name less room, and a name that refuses to shrink drags the row wider
 * than the column — taking the row's action off the right edge with it. `HStack` has no prop for
 * either, so this is the whole of what the row still carries by hand.
 */
const ROW_LABEL_STYLE = {minWidth: 0, overflow: 'hidden'} as const

/** The name itself, which is the part allowed to run out of room. */
const ROW_NAME_STYLE = {minWidth: 0} as const

/**
 * Godot draws its class icons at 16 px; the slot holds that whether or not an icon fills it.
 *
 * The element stays raw: Astryx has no component for a bitmap another process drew, and an empty
 * span is the only way to hold the width while none has arrived. Both values are spacing tokens.
 */
const NODE_ICON_STYLE = {
    width: 'var(--spacing-4)',
    height: 'var(--spacing-4)',
    flexShrink: 0
} as const

/*
 * No placeholder in these filter boxes. The label is hidden — a filter row in a narrow panel
 * cannot spare a label line above a 28 px box — and a placeholder that only repeats the label
 * leaves the field looking like it already holds a value. The magnifier says what the box is for,
 * and the hidden label is what a screen reader announces.
 */
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

/**
 * A row's class icon, the artwork the editor itself draws.
 *
 * The class is the image's alternative text, so a row still announces what it is even though the
 * tree no longer prints the class under every name. Until the icons arrive — or for a class the
 * editor has no icon for — the slot keeps its width, so no tree ever reflows around a late answer.
 */
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

type NodeTreeContext = Readonly<{
    origin: GodotSelection['origin']
    selected: string | undefined
    icons: ClassIcons
    onSelect: (selection: GodotSelection) => void
    /** Absent wherever there is no conversation to add a node to. */
    references: ChatReferenceSink | undefined
}>

function nodeItems(node: GodotNode, context: NodeTreeContext): TreeListItemData {
    const {origin, selected, icons, onSelect, references} = context
    return {
        id: `${origin}:${node.path}`,
        // Godot's own scene tree names a node once and lets its icon say what class it is. Printing
        // the class under every name said the same thing twice and made the two lines compete; the
        // class is on the row's tooltip and on the icon's alternative text instead.
        //
        // Icon and name are one trigger, filling the row: the tooltip has to survive the pointer
        // crossing from the name to the icon, which two separate triggers cannot do.
        label: (
            <Tooltip
                content={node.type}
                // Under the row and anchored to its start: the trigger is the full row, so an
                // end-placed tooltip hangs off the right of a 260 px column and lands in the next
                // pane entirely.
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
        // At the head of the row, ahead of the class icon, because that is where the row's own
        // width is guaranteed: the end of a row is the first thing a long name in a deep branch
        // takes away. The at sign is the gesture people already know — it names a thing inside a
        // message rather than creating one, which is what a plus promised and this does not do.
        ...(references && {
            startContent: (
                // Raw, and deliberately: the wrapper exists so `src/theme/rows.css` can reveal the
                // button when its row is hovered or focused, which is a relationship between two
                // elements that no component prop expresses.
                <span className='gofer-row-action'>
                    <IconButton
                        label={`Mention ${node.name} in the message`}
                        size='sm'
                        variant='ghost'
                        // Through Astryx's `Icon`, which puts a width and a height on the drawing.
                        // A bare Heroicon carries only a `viewBox`: Chromium then stretches it to
                        // its box, WebKit — the engine the desktop actually renders in — draws it
                        // at nothing at all, so the button was there and empty on every row.
                        icon={
                            <Icon
                                icon={AtSymbolIcon}
                                size='sm'
                            />
                        }
                        clickAction={() => {
                            references.add({kind: 'node', id: node.path, detail: node.type})
                        }}
                    />
                </span>
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

function fileItems(
    nodes: readonly PathTreeNode[],
    onOpenFile: (path: string) => void,
    onOpenScene: (path: string) => void
): TreeListItemData[] {
    return nodes.map(node => ({
        id: node.path,
        label: node.name,
        ...(node.isDirectory ?
            {isExpanded: true, children: fileItems(node.children, onOpenFile, onOpenScene)}
        :   {
                isDisabled: !isEditable(node.path) && !isScene(node.path),
                onClick: () => {
                    if (isScene(node.path)) onOpenScene(node.path)
                    else onOpenFile(node.path)
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
    onOpenScene,
    onOpenMainScene,
    onStartSession
}: ExplorerPanelProps) {
    const isOffline = state === 'offline' || state === 'error'
    // A session that is staging, starting, or importing is not offline and has nothing to show yet.
    const isSettling = !isOffline && !isSessionReadable(state)

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

    const scene = useGodotQuery(isOffline || isSettling || tab !== 'scene' ? undefined : loadScene)
    const runtime = useGodotQuery(
        isOffline || isSettling || tab !== 'runtime' ? undefined : loadRuntime
    )

    /**
     * "No game is running" arrives as an error code, and for this panel it is the ordinary state.
     *
     * The addon answers `runtime.get_tree` with `runtime_not_running` whenever no game holds the
     * Gofer helper, which is true of every session that has not pressed Run. Rendering that as
     * "The runtime tree could not be read" told the user something had gone wrong, and made the
     * empty message this panel already has — "The game is not running" — unreachable.
     */
    const isGameIdle = runtime.error?.code === 'runtime_not_running'

    // Both trees draw from one icon cache: a running game is the same project's classes, and the
    // editor is the only half that has a theme to read them from.
    const shownRoot = tab === 'runtime' ? runtime.data?.root : scene.data?.root
    const icons = useGodotClassIcons(call, shownRoot, !isOffline && !isSettling && tab !== 'files')
    const references = useChatReferences()
    const [nodeFilter, setNodeFilter] = useState('')

    // What each tree draws once the filter has had its say. A filter that matches nothing leaves an
    // empty tree, which the panel already reports as an empty state rather than as a broken read.
    const sceneRoot = useMemo(() => {
        const root = scene.data?.root
        return root ? filterSceneTree(root, nodeFilter) : undefined
    }, [scene.data, nodeFilter])
    const runtimeRoot = useMemo(() => {
        const root = runtime.data?.root
        return root ? filterSceneTree(root, nodeFilter) : undefined
    }, [runtime.data, nodeFilter])

    const listed = useMemo(
        () =>
            files
                .filter(file => isListable(file.path))
                .filter(file => file.path.toLowerCase().includes(fileFilter.toLowerCase()))
                .slice(0, MAX_LISTED_FILES),
        [files, fileFilter]
    )

    const fileTree = useMemo(
        () => fileItems(buildPathTree(listed.map(file => file.path)), onOpenFile, onOpenScene),
        [listed, onOpenFile, onOpenScene]
    )

    const offline = (
        <VStack padding={3}>
            <EmptyState
                isCompact
                headingLevel={3}
                title='No editor running'
                description='Gofer starts one Godot editor bound to the active task worktree.'
                actions={
                    <Button
                        label='Start editor'
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
                        startIcon={MagnifyingGlassIcon}
                        value={fileFilter}
                        hasClear
                        onChange={onFileFilterChange}
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
                    {/* No tree, nothing to filter: an offline panel offers to start the session. */}
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
                            isLoading={scene.isLoading || isSettling}
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
                            {sceneRoot ?
                                <TreeList
                                    density='compact'
                                    variant='noGuides'
                                    items={[
                                        nodeItems(sceneRoot, {
                                            origin: 'edited',
                                            selected: selection?.path,
                                            icons,
                                            onSelect,
                                            references
                                        })
                                    ]}
                                />
                            :   null}
                        </PanelState>
                    ))}
                {tab === 'runtime'
                    && (isOffline ? offline : (
                        <PanelState
                            label='runtime tree'
                            isLoading={runtime.isLoading || isSettling}
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
                            {runtimeRoot ?
                                <TreeList
                                    density='compact'
                                    variant='noGuides'
                                    items={[
                                        nodeItems(runtimeRoot, {
                                            origin: 'runtime',
                                            selected: selection?.path,
                                            icons,
                                            onSelect,
                                            references
                                        })
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
