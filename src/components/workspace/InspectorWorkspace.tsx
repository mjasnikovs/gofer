import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Divider} from '@astryxdesign/core/Divider'
import {Layout, LayoutContent, LayoutPanel} from '@astryxdesign/core/Layout'
import {ResizeHandle, useResizable} from '@astryxdesign/core/Resizable'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Tab, TabList} from '@astryxdesign/core/TabList'
import {Text} from '@astryxdesign/core/Text'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import {useDebugSession} from '../../hooks/useDebugSession'
import {useGodotQuery} from '../../hooks/useGodotQuery'
import {useGodotSession} from '../../hooks/useGodotSession'
import {useScriptBuffers} from '../../hooks/useScriptBuffers'
import {toGodotError} from '../../services/godot-session'
import {isSessionReadable} from '../../models/godot'
import type {
    DebugSourceBreakpoints,
    GodotProjectSettings,
    GodotSessionState,
    GodotSessionStatus
} from '../../models/godot'
import type {GodotSelection} from '../../models/workspace'
import {BottomPanel} from './BottomPanel'
import type {BottomTab} from './BottomPanel'
import {DocsView} from './DocsView'
import {ExplorerPanel} from './ExplorerPanel'
import type {ExplorerTab} from './ExplorerPanel'
import {GameView} from './GameView'
import {InspectorPanel} from './InspectorPanel'
import type {InspectorTab} from './InspectorPanel'
import {ScriptWorkspace} from './ScriptWorkspace'
import type {ScriptReveal} from './ScriptWorkspace'

type InspectorWorkspaceProps = Readonly<{
    /** The chat column, owned by `Workspace` because the conversation outlives this frame. */
    chat: ReactNode
    onError: (message: string) => void
}>

type CenterTab = 'chat' | 'scripts' | 'game' | 'docs'

/*
 * Responsive contract:
 *   > 1024px   explorer 260 (resizable) | center | inspector 380 (resizable)
 *   <= 1024px  the inspector overlays the center column, opened from the toolbar and dismissed
 *              with Escape; focus returns to the button that opened it
 *   the bottom panel is 240px and collapses to its own tab strip at every width
 */
const NARROW_QUERY = '(max-width: 1024px)'
const EXPLORER_WIDTH = 260
const EXPLORER_MIN = 200
const EXPLORER_MAX = 420
const INSPECTOR_WIDTH = 380
const INSPECTOR_MIN = 320
const INSPECTOR_MAX = 480
const BOTTOM_HEIGHT = 240

/** The editor names a scene by its resource path; the explorer names a file by its worktree path. */
function resourcePath(path: string) {
    return path.startsWith('res://') ? path : `res://${path}`
}

const STATE_VARIANT: Readonly<
    Record<GodotSessionState, 'success' | 'warning' | 'error' | 'neutral'>
> = {
    offline: 'neutral',
    staging: 'warning',
    starting: 'warning',
    importing: 'warning',
    ready: 'success',
    playing: 'success',
    debugPaused: 'warning',
    stopping: 'warning',
    error: 'error'
}

/** Tracks the one breakpoint the responsive contract names. */
function useNarrowViewport() {
    const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
    useEffect(() => {
        const media = window.matchMedia(NARROW_QUERY)
        const update = (event: MediaQueryListEvent) => {
            setIsNarrow(event.matches)
        }
        media.addEventListener('change', update)
        return () => {
            media.removeEventListener('change', update)
        }
    }, [])
    return isNarrow
}

/**
 * The IDE frame: explorer, center, inspector, and bottom panel around one Godot editor session.
 *
 * The frame owns the state its regions share — the open script buffers, the selected node, the
 * session — so that the Problems list, the debugger, and the editor tabs are three views of one
 * thing rather than three copies of it. Every panel calls the same Rust handlers the AI tool router
 * calls, which is what keeps a click and an agent turn from disagreeing.
 */
export function InspectorWorkspace({chat, onError}: InspectorWorkspaceProps) {
    const [centerTab, setCenterTab] = useState<CenterTab>('chat')
    const [explorerTab, setExplorerTab] = useState<ExplorerTab>('scene')
    const [inspectorTab, setInspectorTab] = useState<InspectorTab>('node')
    const [bottomTab, setBottomTab] = useState<BottomTab>('problems')
    const [isBottomCollapsed, setIsBottomCollapsed] = useState(false)
    const [isInspectorOpen, setIsInspectorOpen] = useState(false)
    const [selection, setSelection] = useState<GodotSelection>()
    const [fileFilter, setFileFilter] = useState('')
    const [reveal, setReveal] = useState<ScriptReveal>()
    const [failure, setFailure] = useState<string>()
    const inspectorButton = useRef<HTMLButtonElement>(null)

    /**
     * Reports a failure where the person who caused it is looking.
     *
     * The chat composer is where the workspace's errors are shown, and it is on screen only while
     * the chat is. A scene that will not open, a session that will not start, and a debugger that
     * will not launch are all things a user provokes from the frame — from a tab that is not the
     * chat — so the frame keeps its own banner rather than reporting into a column nobody is
     * looking at. The message still reaches the conversation, which is where it belongs afterwards.
     */
    const report = useCallback(
        (message: string) => {
            setFailure(message)
            onError(message)
        },
        [onError]
    )

    const isNarrow = useNarrowViewport()
    const scripts = useScriptBuffers({onError: report})
    const {
        call,
        ensureReady,
        isBusy,
        runtimeEpoch,
        scene,
        sceneEpoch,
        session,
        start,
        state,
        stop
    } = useGodotSession({onError: report})

    const explorer = useResizable({
        defaultSize: EXPLORER_WIDTH,
        minSizePx: EXPLORER_MIN,
        maxSizePx: EXPLORER_MAX,
        autoSaveId: 'gofer-explorer'
    })
    const inspector = useResizable({
        defaultSize: INSPECTOR_WIDTH,
        minSizePx: INSPECTOR_MIN,
        maxSizePx: INSPECTOR_MAX,
        autoSaveId: 'gofer-inspector'
    })

    const isOffline = state === 'offline' || state === 'error'

    const loadStatus = useCallback(() => {
        // The epoch is the dependency: an editor-side scene change re-reads the session state.
        void sceneEpoch
        return call('session.get_state') as Promise<GodotSessionStatus>
    }, [call, sceneEpoch])

    // A session still coming up has no scene to name; asking now would keep that empty answer.
    const status = useGodotQuery(isOffline || !isSessionReadable(state) ? undefined : loadStatus)
    const scenePath = scene?.path ?? status.data?.scene ?? ''

    const breakpoints = useMemo<readonly DebugSourceBreakpoints[]>(
        () =>
            scripts.buffers
                .filter(buffer => buffer.breakpoints.length > 0)
                .map(buffer => ({path: buffer.path, lines: buffer.breakpoints})),
        [scripts.buffers]
    )

    const debug = useDebugSession({breakpoints, onError: report})

    /**
     * The Run control: ensure the managed editor session, then launch the game through Godot's own
     * debug adapter.
     *
     * It is one action rather than two because running without an editor session is not something
     * Gofer can do at all — the adapter belongs to the editor. Launching under the debugger is what
     * makes the breakpoints in Monaco's gutter mean something, so the bottom panel follows the game
     * to the debugger tab. The Game tab's controls remain the editor's own play buttons, which
     * capture frames but stop at no breakpoint.
     */
    const runProject = useCallback(() => {
        void (async () => {
            if (!(await ensureReady())) return
            setBottomTab('debugger')
            setIsBottomCollapsed(false)
            await debug.launch()
        })()
    }, [debug, ensureReady])

    const stopProject = useCallback(() => {
        void debug.terminate()
    }, [debug])

    const openFile = useCallback(
        (path: string) => {
            void scripts.openBuffer(path)
            setCenterTab('scripts')
        },
        [scripts]
    )

    /**
     * Opens a scene in the managed editor and shows what it opened.
     *
     * The editor owns the edited scene, so this is a request to it rather than a local state
     * change; the tree, the inspector, and Run all follow the addon's own `scene.changed` event.
     */
    const openScene = useCallback(
        (path: string) => {
            void (async () => {
                if (!(await ensureReady())) return
                try {
                    // The explorer names a file by its place in the worktree; the editor names a
                    // scene by its resource path, and `scene.open` is the editor's command. Sending
                    // the worktree path asks the editor to open a scene it has never heard of.
                    await call('scene.open', {path: resourcePath(path)})
                    setExplorerTab('scene')
                } catch (error) {
                    report(`The scene could not be opened: ${toGodotError(error).message}`)
                }
            })()
        },
        [call, ensureReady, report]
    )

    /** Opens the scene `project.godot` names, which is the scene Run plays. */
    const openMainScene = useCallback(() => {
        void (async () => {
            if (!(await ensureReady())) return
            try {
                const settings = (await call('project.get_settings')) as GodotProjectSettings
                if (!settings.mainScene) {
                    report('This project names no main scene, so there is none to open.')
                    return
                }
                await call('scene.open', {path: resourcePath(settings.mainScene)})
                setExplorerTab('scene')
            } catch (error) {
                report(`The main scene could not be opened: ${toGodotError(error).message}`)
            }
        })()
    }, [call, ensureReady, report])

    const openLocation = useCallback(
        (path: string, line: number) => {
            void scripts.openBuffer(path)
            setCenterTab('scripts')
            setReveal({path, line, at: Date.now()})
        },
        [scripts]
    )

    const select = useCallback((next: GodotSelection) => {
        setSelection(next)
        setInspectorTab('node')
    }, [])

    const startSession = useCallback(() => {
        void start()
    }, [start])

    const closeInspector = useCallback(() => {
        setIsInspectorOpen(false)
        inspectorButton.current?.focus()
    }, [])

    const inspectorPanel = (
        <InspectorPanel
            tab={inspectorTab}
            onTabChange={setInspectorTab}
            call={call}
            state={state}
            scenePath={scenePath}
            selection={selection}
            sceneEpoch={sceneEpoch}
        />
    )

    return (
        <Layout
            height='fill'
            start={
                <>
                    <LayoutPanel
                        padding={0}
                        role='navigation'
                        label='Explorer'
                        isScrollable={false}
                        resizable={explorer.props}
                    >
                        <ExplorerPanel
                            tab={explorerTab}
                            onTabChange={setExplorerTab}
                            call={call}
                            state={state}
                            sceneEpoch={sceneEpoch}
                            runtimeEpoch={runtimeEpoch}
                            files={scripts.files}
                            fileFilter={fileFilter}
                            onFileFilterChange={setFileFilter}
                            selection={selection}
                            onSelect={select}
                            onOpenFile={openFile}
                            onOpenScene={openScene}
                            onOpenMainScene={openMainScene}
                            onStartSession={startSession}
                        />
                    </LayoutPanel>
                    <ResizeHandle
                        resizable={explorer.props}
                        direction='horizontal'
                        hasDivider
                        label='Resize the explorer'
                    />
                </>
            }
            content={
                <LayoutContent padding={0}>
                    <VStack
                        gap={0}
                        height='100%'
                    >
                        <Toolbar
                            label='Session'
                            size='sm'
                            dividers={['bottom']}
                            startContent={
                                <HStack
                                    gap={2}
                                    align='center'
                                >
                                    <StatusDot
                                        variant={STATE_VARIANT[state]}
                                        label={`Editor session: ${state}`}
                                    />
                                    <Text
                                        type='supporting'
                                        color='secondary'
                                    >
                                        {isOffline ?
                                            'Editor session stopped'
                                        :   `${session?.godotVersion ?? 'Godot'} · ${scenePath === '' ? 'no scene open' : scenePath}${scene?.dirty === true ? ' •' : ''}`
                                        }
                                    </Text>
                                </HStack>
                            }
                            endContent={
                                <HStack gap={1}>
                                    {isNarrow ?
                                        <Button
                                            ref={inspectorButton}
                                            label='Inspector'
                                            size='sm'
                                            variant='ghost'
                                            aria-expanded={isInspectorOpen}
                                            clickAction={() => {
                                                setIsInspectorOpen(true)
                                            }}
                                        />
                                    :   null}
                                    <Button
                                        label={debug.isLaunched ? 'Stop project' : 'Run project'}
                                        size='sm'
                                        variant={debug.isLaunched ? 'ghost' : 'secondary'}
                                        isDisabled={isBusy || debug.isBusy}
                                        clickAction={debug.isLaunched ? stopProject : runProject}
                                    />
                                    <Button
                                        label={isOffline ? 'Start session' : 'Stop session'}
                                        size='sm'
                                        variant={isOffline ? 'primary' : 'ghost'}
                                        isDisabled={isBusy}
                                        clickAction={() => {
                                            if (isOffline) void start()
                                            else void stop()
                                        }}
                                    />
                                </HStack>
                            }
                        />
                        {failure === undefined ? null : (
                            <Banner
                                container='section'
                                status='error'
                                title='The workspace could not do that'
                                description={failure}
                                isDismissable
                                onDismiss={() => {
                                    setFailure(undefined)
                                }}
                            />
                        )}
                        <TabList
                            size='sm'
                            hasDivider
                            aria-label='Workspace views'
                            value={centerTab}
                            onChange={value => {
                                setCenterTab(value as CenterTab)
                            }}
                        >
                            <Tab
                                value='chat'
                                label='Chat'
                            />
                            <Tab
                                value='scripts'
                                label='Scripts'
                            />
                            <Tab
                                value='game'
                                label='Game'
                            />
                            <Tab
                                value='docs'
                                label='Docs'
                            />
                        </TabList>
                        <StackItem size='fill'>
                            {centerTab === 'chat' ?
                                <VStack
                                    gap={0}
                                    height='100%'
                                >
                                    {chat}
                                </VStack>
                            : centerTab === 'scripts' ?
                                <ScriptWorkspace
                                    scripts={scripts}
                                    onError={onError}
                                    {...(reveal && {reveal})}
                                />
                            : centerTab === 'game' ?
                                <GameView
                                    call={call}
                                    state={state}
                                />
                            :   <DocsView />}
                        </StackItem>
                        <Divider />
                        <VStack
                            gap={0}
                            height={isBottomCollapsed ? 'auto' : BOTTOM_HEIGHT}
                        >
                            <BottomPanel
                                tab={bottomTab}
                                onTabChange={setBottomTab}
                                isCollapsed={isBottomCollapsed}
                                onToggle={() => {
                                    setIsBottomCollapsed(previous => !previous)
                                }}
                                call={call}
                                state={state}
                                diagnostics={scripts.diagnostics}
                                debug={debug}
                                files={scripts.files}
                                onOpenLocation={openLocation}
                            />
                        </VStack>
                    </VStack>
                    <Dialog
                        isOpen={isNarrow && isInspectorOpen}
                        purpose='form'
                        width={INSPECTOR_WIDTH}
                        onOpenChange={closeInspector}
                    >
                        <DialogHeader
                            title='Inspector'
                            onOpenChange={closeInspector}
                        />
                        {inspectorPanel}
                    </Dialog>
                </LayoutContent>
            }
            {...(!isNarrow && {
                end: (
                    <>
                        <ResizeHandle
                            resizable={inspector.props}
                            direction='horizontal'
                            isReversed
                            hasDivider
                            label='Resize the inspector'
                        />
                        <LayoutPanel
                            padding={0}
                            role='complementary'
                            label='Inspector'
                            isScrollable={false}
                            resizable={inspector.props}
                        >
                            {inspectorPanel}
                        </LayoutPanel>
                    </>
                )
            })}
        />
    )
}
