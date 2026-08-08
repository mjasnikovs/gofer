import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {ReactNode} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Divider} from '@astryxdesign/core/Divider'
import {Layout, LayoutContent, LayoutPanel} from '@astryxdesign/core/Layout'
import {ResizeHandle, useResizable} from '@astryxdesign/core/Resizable'
import {Spinner} from '@astryxdesign/core/Spinner'
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
import {
    readProjectState,
    SCRIPT_VIEWS_KEY,
    WORKSPACE_LAYOUT_KEY,
    writeProjectState
} from '../../services/ui-state'
import {isSessionReadable} from '../../models/godot'
import type {
    DebugSourceBreakpoints,
    GodotLogSeverity,
    GodotProjectSettings,
    GodotSessionState,
    GodotSessionStatus
} from '../../models/godot'
import type {GodotSelection} from '../../models/workspace'
import {
    EXPLORER_MAX,
    EXPLORER_MIN,
    INSPECTOR_MAX,
    INSPECTOR_MIN,
    toScriptViews,
    toWorkspaceLayout
} from '../../models/ui-state'
import type {
    BottomTab,
    CenterTab,
    ChosenNode,
    ExplorerTab,
    InspectorTab,
    LogScope,
    ScriptViews,
    WorkspaceLayout
} from '../../models/ui-state'
import {BottomPanel} from './BottomPanel'
import {DocsView} from './DocsView'
import {ExplorerPanel} from './ExplorerPanel'
import {GameView} from './GameView'
import {InspectorPanel} from './InspectorPanel'
import {ScriptWorkspace} from './ScriptWorkspace'
import type {ScriptReveal} from './ScriptWorkspace'

type InspectorWorkspaceProps = Readonly<{
    /** The chat column, owned by `Workspace` because the conversation outlives this frame. */
    chat: ReactNode
    onError: (message: string) => void
}>

type InspectorFrameProps = InspectorWorkspaceProps
    & Readonly<{
        /** How this project was left, already checked against what this version understands. */
        layout: WorkspaceLayout
        /** Monaco's cursor and scroll for each script that was open. */
        views: ScriptViews
    }>

/*
 * Responsive contract:
 *   > 1024px   explorer 260 (resizable) | center | inspector 380 (resizable)
 *   <= 1024px  the inspector overlays the center column, opened from the toolbar and dismissed
 *              with Escape; focus returns to the button that opened it
 *   the bottom panel is 240px and collapses to its own tab strip at every width
 */
const NARROW_QUERY = '(max-width: 1024px)'
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
    const [restored, setRestored] =
        useState<Readonly<{layout: WorkspaceLayout; views: ScriptViews}>>()

    useEffect(() => {
        let cancelled = false
        const load = async () => {
            const layout = toWorkspaceLayout(await readProjectState(WORKSPACE_LAYOUT_KEY))
            const views = toScriptViews(
                await readProjectState(SCRIPT_VIEWS_KEY),
                layout.openScripts
            )
            if (!cancelled) setRestored({layout, views})
        }
        void load()
        return () => {
            cancelled = true
        }
    }, [])

    // The frame mounts once, with the layout already in hand. Mounting on the defaults and moving
    // afterwards would open the wrong tab, refetch through the wrong panel, and write the defaults
    // back over the project's own layout before the read that would have prevented it returned.
    if (!restored) {
        return (
            <HStack
                gap={2}
                padding={3}
                align='center'
                role='status'
            >
                <Spinner size='sm' />
                <Text
                    type='supporting'
                    color='secondary'
                >
                    Opening the workspace…
                </Text>
            </HStack>
        )
    }
    return (
        <InspectorFrame
            chat={chat}
            layout={restored.layout}
            views={restored.views}
            onError={onError}
        />
    )
}

function InspectorFrame({chat, layout, views, onError}: InspectorFrameProps) {
    const [centerTab, setCenterTab] = useState<CenterTab>(layout.centerTab)
    const [explorerTab, setExplorerTab] = useState<ExplorerTab>(layout.explorerTab)
    const [inspectorTab, setInspectorTab] = useState<InspectorTab>(layout.inspectorTab)
    const [bottomTab, setBottomTab] = useState<BottomTab>(layout.bottomTab)
    const [isBottomCollapsed, setIsBottomCollapsed] = useState(layout.isBottomCollapsed)
    const [logSeverity, setLogSeverity] = useState<GodotLogSeverity>(layout.logSeverity)
    const [logScope, setLogScope] = useState<LogScope>(layout.logScope)
    const [isInspectorOpen, setIsInspectorOpen] = useState(false)
    const [chosen, setChosen] = useState<ChosenNode | undefined>(layout.selection)
    const [fileFilter, setFileFilter] = useState('')
    const [reveal, setReveal] = useState<ScriptReveal>()
    const [failure, setFailure] = useState<string>()
    const inspectorButton = useRef<HTMLButtonElement>(null)
    // Cursors and scroll are mutable on purpose: they change with every keystroke, and a render
    // per keystroke is a price the layout does not have to pay to be remembered.
    const scriptViews = useRef<Record<string, unknown>>({...views})

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
    const clearFailure = useCallback(() => {
        setFailure(undefined)
    }, [])
    const scripts = useScriptBuffers({
        onError: report,
        onResolved: clearFailure,
        restore: {
            openScripts: layout.openScripts,
            breakpoints: layout.breakpoints,
            ...(layout.activeScript !== undefined && {activeScript: layout.activeScript})
        }
    })
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

    /*
     * No `autoSaveId`: the hook's own persistence is one width in `localStorage` for the whole
     * machine, so every project shared it. The width is stored with the project instead, which is
     * what makes it a property of the work rather than of the window it was last dragged in.
     */
    const explorer = useResizable({
        defaultSize: layout.explorerWidth,
        minSizePx: EXPLORER_MIN,
        maxSizePx: EXPLORER_MAX
    })
    const inspector = useResizable({
        defaultSize: layout.inspectorWidth,
        minSizePx: INSPECTOR_MIN,
        maxSizePx: INSPECTOR_MAX
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

    const openScripts = useMemo(() => scripts.buffers.map(buffer => buffer.path), [scripts.buffers])

    /*
     * Records how the workspace is being left, on every change that is a choice.
     *
     * One effect for the whole layout rather than one per control: the writes are coalesced
     * anyway, and a single snapshot cannot store a tab from before a drag alongside a width from
     * after it. What is deliberately absent is every filter box — a stored search would reopen the
     * project with files hidden and no sign of why.
     */
    useEffect(() => {
        writeProjectState(WORKSPACE_LAYOUT_KEY, {
            centerTab,
            explorerTab,
            inspectorTab,
            bottomTab,
            isBottomCollapsed,
            explorerWidth: explorer.size,
            inspectorWidth: inspector.size,
            logSeverity,
            logScope,
            openScripts,
            ...(scripts.activePath !== undefined && {activeScript: scripts.activePath}),
            breakpoints: Object.fromEntries(breakpoints.map(source => [source.path, source.lines])),
            ...(chosen && {selection: chosen})
        })
    }, [
        bottomTab,
        breakpoints,
        centerTab,
        chosen,
        explorer.size,
        explorerTab,
        inspector.size,
        inspectorTab,
        isBottomCollapsed,
        logScope,
        logSeverity,
        openScripts,
        scripts.activePath
    ])

    /** Records where the cursor was left in one script. */
    const rememberScriptView = useCallback((path: string, view: unknown) => {
        scriptViews.current[path] = view
        writeProjectState(SCRIPT_VIEWS_KEY, scriptViews.current)
    }, [])

    // A closed tab's cursor is not worth keeping: it would grow the record for the life of the
    // project and be restored into a file the user is no longer editing.
    useEffect(() => {
        const kept = toScriptViews(scriptViews.current, openScripts)
        if (Object.keys(kept).length === Object.keys(scriptViews.current).length) return
        scriptViews.current = {...kept}
        writeProjectState(SCRIPT_VIEWS_KEY, kept)
    }, [openScripts])

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

    const select = useCallback(
        (next: GodotSelection) => {
            setChosen({selection: next, scene: scenePath})
            setInspectorTab('node')
        },
        [scenePath]
    )

    /**
     * A node chosen in one scene does not exist in the next one.
     *
     * The editor's scene changes under the inspector all the time — the agent opens one, the user
     * clicks a `.tscn`, the editor opens one for itself on startup — and the chosen path went with
     * it. The reading is then made of the new scene against the old scene's path, and the addon
     * answers exactly what was asked: `Node /Main/Player was not found in the edited scene`. The
     * error is right and the question was not, so the choice is retired with the scene it was made
     * in rather than outliving it as an error the user cannot act on.
     *
     * Derived rather than cleared, so there is no render that still holds the stale path. A runtime
     * choice is kept: it belongs to the running game, which the edited scene changing does not
     * touch.
     */
    const selection =
        (
            chosen === undefined
            || (chosen.selection.origin === 'edited' && chosen.scene !== scenePath)
        ) ?
            undefined
        :   chosen.selection

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
            onStartSession={startSession}
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
                                    {/*
                                     * Emphasis follows whatever the screen is for. With no session
                                     * there is only one thing to do, and starting it is already the
                                     * primary; once a session is live the project controls are, and
                                     * they were both rendering grey-on-grey, so a running workspace
                                     * had no primary action at all.
                                     */}
                                    <Button
                                        label={debug.isLaunched ? 'Stop project' : 'Run project'}
                                        size='sm'
                                        variant={isOffline ? 'secondary' : 'primary'}
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
                                    views={views}
                                    onViewChange={rememberScriptView}
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
                                logSeverity={logSeverity}
                                onLogSeverityChange={setLogSeverity}
                                logScope={logScope}
                                onLogScopeChange={setLogScope}
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
                        width={inspector.size}
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
