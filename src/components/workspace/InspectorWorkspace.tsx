import {memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react'
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
import {EditorSessionContext, useEditorSession} from '../../hooks/useEditorSession'
import {useGodotSession} from '../../hooks/useGodotSession'
import {useScriptBuffers} from '../../hooks/useScriptBuffers'
import {OpenCenterTabContext} from '../../hooks/useCenterTab'
import {useRememberedLayout} from '../../hooks/useRememberedLayout'
import {useWaitingQuestions} from '../../hooks/useUserQuestions'
import {WorkspaceFailureContext} from '../../hooks/useWorkspaceFailure'
import {createProjectActions} from '../../services/project-actions'
import {isSessionOffline, isSessionPlaying} from '../../models/godot'
import type {DebugSourceBreakpoints, GodotSessionState} from '../../models/godot'
import type {GodotSelection} from '../../models/workspace'
import {
    EXPLORER_MAX,
    EXPLORER_MIN,
    INSPECTOR_MAX,
    INSPECTOR_MIN,
    nodeStillChosen
} from '../../models/ui-state'
import type {CenterTab, LayoutAction, ScriptViews, WorkspaceLayout} from '../../models/ui-state'
import {BottomPanel} from './BottomPanel'
import {DocsView} from './DocsView'
import {MemoryView} from './MemoryView'
import {SketchesView} from './SketchesView'
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
        /** Changes the layout, and records the change. */
        dispatch: (action: LayoutAction) => void
        /** Records where the cursor was left in one script. */
        recordView: (path: string, view: unknown) => void
    }>

type FrameRegionsProps = Omit<InspectorFrameProps, 'onError'>
    & Readonly<{
        /**
         * Shows a failure in the frame's own banner, and passes it on to the conversation.
         *
         * The regions never see the frame's `onError`. There is one sink below this point, and
         * `WorkspaceFailureContext` is how everything that is not a region reaches it.
         */
        report: (message: string) => void
        clearFailure: () => void
        failure?: string | undefined
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

/**
 * Brings the tab holding a waiting question forward, once per question.
 *
 * A question is drawn in the chat column and nowhere else — inside the tool call that asked it, or
 * beside the composer for a plan's own questions — and the chat column is mounted only while the
 * Chat tab is showing. So an agent that asked something while the user was watching the game put
 * nothing on screen anywhere: no card, no badge, nothing to answer, and the tool blocked for its
 * full thirty minutes and failed `question_timeout`. Approvals never had this: their dialog is
 * mounted beside the frame rather than inside it.
 *
 * Once per question and not while one is waiting, which is the difference between showing the user
 * where the question is and holding them on a tab they are trying to leave. Answering it is the
 * only thing that clears it, and they may well want to read the script it is about first.
 */
function useTabWithTheQuestionOnIt(openCenterTab: (tab: CenterTab) => void) {
    const waiting = useWaitingQuestions()
    const shown = useRef(new Set<string>())
    useEffect(() => {
        const fresh = waiting.filter(question => !shown.current.has(question.questionId))
        if (fresh.length === 0) return
        for (const question of fresh) shown.current.add(question.questionId)
        openCenterTab('chat')
    }, [openCenterTab, waiting])
}

/** Tracks the one breakpoint the responsive contract names. */
function useNarrowViewport() {
    /*
     * Subscribed rather than seeded and then listened to. A `useState` initialiser reads the match
     * during render and the listener only starts after commit, so a viewport that crossed the
     * breakpoint in between fired nothing and the frame drew the wrong regions until the next
     * resize. `useSyncExternalStore` re-reads on subscribe, which closes that window.
     */
    return useSyncExternalStore(subscribeToWidth, isNarrowNow)
}

function subscribeToWidth(onChange: () => void) {
    const media = window.matchMedia(NARROW_QUERY)
    media.addEventListener('change', onChange)
    return () => {
        media.removeEventListener('change', onChange)
    }
}

function isNarrowNow() {
    return window.matchMedia(NARROW_QUERY).matches
}

/**
 * The IDE frame: explorer, center, inspector, and bottom panel around one Godot editor session.
 *
 * The frame owns the state its regions share — the open script buffers, the selected node, the
 * session — so that the Problems list, the debugger, and the editor tabs are three views of one
 * thing rather than three copies of it. Every panel calls the same Rust handlers the AI tool router
 * calls, which is what keeps a click and an agent turn from disagreeing.
 *
 * Memoized, and the memo is load-bearing rather than an optimisation. The frame's parent owns the
 * conversation, so it re-renders once per streamed token; without this boundary every one of those
 * tokens rebuilt the scene tree — one `TreeListItemData` per node, each carrying a `Tooltip` and an
 * `IconButton` — along with the runtime tree, the file listing and the bottom panel. Both props are
 * built to hold it: `chat` is a module constant and `onError` is the parent's stable callback.
 */
export const InspectorWorkspace = memo(function Frame({chat, onError}: InspectorWorkspaceProps) {
    const {state, dispatch, recordView} = useRememberedLayout()

    // The frame mounts once, with the layout already in hand. Mounting on the defaults and moving
    // afterwards would open the wrong tab, refetch through the wrong panel, and write the defaults
    // back over the project's own layout before the read that would have prevented it returned.
    if (!state.isOpen) {
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
            layout={state.layout}
            views={state.views}
            dispatch={dispatch}
            recordView={recordView}
            onError={onError}
        />
    )
})

/**
 * The editor session the frame is built around, and the failures the frame reports about it.
 *
 * This is the whole of what the frame owns that its regions merely read, which is why it is a
 * component of its own: the session is provided here, so everything below reads it the same way —
 * a panel and the frame's own regions ask the same seam, and neither is handed pieces of it.
 */
function InspectorFrame({chat, layout, views, dispatch, recordView, onError}: InspectorFrameProps) {
    const [failure, setFailure] = useState<string>()

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
    const clearFailure = useCallback(() => {
        setFailure(undefined)
    }, [])

    const session = useGodotSession({onError: report})

    return (
        <WorkspaceFailureContext value={report}>
            <EditorSessionContext value={session}>
                <FrameRegions
                    chat={chat}
                    layout={layout}
                    views={views}
                    dispatch={dispatch}
                    recordView={recordView}
                    report={report}
                    clearFailure={clearFailure}
                    {...(failure !== undefined && {failure})}
                />
            </EditorSessionContext>
        </WorkspaceFailureContext>
    )
}

function FrameRegions({
    chat,
    layout,
    views,
    dispatch,
    recordView,
    report,
    clearFailure,
    failure
}: FrameRegionsProps) {
    // How the project was opened, as opposed to how it stands. The widths and the script buffers
    // are owned by hooks that only take a starting value, and a starting value that moved is a
    // hook restarted mid-drag.
    const [opened] = useState(layout)
    const openCenterTab = useCallback(
        (tab: CenterTab) => {
            dispatch({type: 'center-tab', tab})
        },
        [dispatch]
    )
    useTabWithTheQuestionOnIt(openCenterTab)
    const [isInspectorOpen, setIsInspectorOpen] = useState(false)
    const [reveal, setReveal] = useState<ScriptReveal>()
    const inspectorButton = useRef<HTMLButtonElement>(null)

    const isNarrow = useNarrowViewport()

    const scripts = useScriptBuffers({
        onError: report,
        onResolved: clearFailure,
        restore: {
            openScripts: opened.openScripts,
            breakpoints: opened.breakpoints,
            ...(opened.activeScript !== undefined && {activeScript: opened.activeScript})
        }
    })
    const {call, ensureReady, isBusy, runtimeEpoch, scene, scenePath, session, start, state, stop} =
        useEditorSession()

    /*
     * No `autoSaveId`: the hook's own persistence is one width in `localStorage` for the whole
     * machine, so every project shared it. The width is stored with the project instead, which is
     * what makes it a property of the work rather than of the window it was last dragged in.
     */
    const explorer = useResizable({
        defaultSize: opened.explorerWidth,
        minSizePx: EXPLORER_MIN,
        maxSizePx: EXPLORER_MAX
    })
    const inspector = useResizable({
        defaultSize: opened.inspectorWidth,
        minSizePx: INSPECTOR_MIN,
        maxSizePx: INSPECTOR_MAX
    })

    const isOffline = isSessionOffline(state)
    /*
     * Whether there is a game to stop, taken from the editor rather than from what Gofer launched.
     *
     * Godot polls its own play state every frame and the addon reports the transition, so a game
     * that crashed, that ended on its own, or that was closed from its own window stops counting as
     * running here without anything being told. It is also what makes the Game tab's own Run — the
     * editor's play button, not the debugger's launch — show up in the toolbar as a game running.
     */
    const isPlaying = isSessionPlaying(state)

    const breakpoints = useMemo<readonly DebugSourceBreakpoints[]>(
        () =>
            scripts.buffers
                .filter(buffer => buffer.breakpoints.length > 0)
                .map(buffer => ({path: buffer.path, lines: buffer.breakpoints})),
        [scripts.buffers]
    )

    const debug = useDebugSession({breakpoints, isPlaying, onError: report})

    const openScripts = useMemo(() => scripts.buffers.map(buffer => buffer.path), [scripts.buffers])

    // The widths and the open scripts belong to hooks that own their own state, so the layout
    // catches up with them rather than reading them at write time.
    useEffect(() => {
        dispatch({
            type: 'resized',
            explorerWidth: explorer.size,
            inspectorWidth: inspector.size
        })
    }, [dispatch, explorer.size, inspector.size])

    useEffect(() => {
        dispatch({
            type: 'scripts-changed',
            openScripts,
            activeScript: scripts.activePath,
            breakpoints: Object.fromEntries(breakpoints.map(source => [source.path, source.lines]))
        })
    }, [breakpoints, dispatch, openScripts, scripts.activePath])

    /** What the frame does to the project, as opposed to what it draws. */
    const project = useMemo(
        () => createProjectActions({call, ensureReady, debug, dispatch, report}),
        [call, debug, dispatch, ensureReady, report]
    )

    /*
     * Depending on the member, not the container. `useScriptBuffers` memoises what it returns, but
     * that memo lists `buffers` — which typing replaces — so `scripts` still moves on every
     * keystroke. `openBuffer` does not, so these hold. The breakpoint and open-script effects below
     * already follow the same rule.
     */
    const openBuffer = scripts.openBuffer

    const openFile = useCallback(
        (path: string) => {
            void openBuffer(path)
            dispatch({type: 'center-tab', tab: 'scripts'})
        },
        [dispatch, openBuffer]
    )

    const openLocation = useCallback(
        (path: string, line: number) => {
            void openBuffer(path)
            dispatch({type: 'center-tab', tab: 'scripts'})
            setReveal({path, line, at: Date.now()})
        },
        [dispatch, openBuffer]
    )

    // Wrapped like its neighbours: the explorer's file-tree memo lists this handler, so a fresh
    // arrow here rebuilt every row of the tree — up to the listing cap — on every frame render.
    const openScene = useCallback(
        (path: string) => {
            void project.openScene(path)
        },
        [project]
    )

    const openMainScene = useCallback(() => {
        void project.openMainScene()
    }, [project])

    const select = useCallback(
        (next: GodotSelection) => {
            dispatch({type: 'node-chosen', selection: next, scene: scenePath, runtimeEpoch})
        },
        [dispatch, runtimeEpoch, scenePath]
    )

    const selection = nodeStillChosen(layout.selection, {scene: scenePath, runtimeEpoch})

    const startSession = useCallback(() => {
        void start()
    }, [start])

    const closeInspector = useCallback(() => {
        setIsInspectorOpen(false)
        inspectorButton.current?.focus()
    }, [])

    const inspectorPanel = (
        <InspectorPanel
            tab={layout.inspectorTab}
            onTabChange={tab => {
                dispatch({type: 'inspector-tab', tab})
            }}
            scenePath={scenePath}
            selection={selection}
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
                            tab={layout.explorerTab}
                            onTabChange={tab => {
                                dispatch({type: 'explorer-tab', tab})
                            }}
                            files={scripts.files}
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
                            label='Editor'
                            size='sm'
                            dividers={['bottom']}
                            startContent={
                                <HStack
                                    gap={2}
                                    align='center'
                                >
                                    <StatusDot
                                        variant={STATE_VARIANT[state]}
                                        label={`Editor: ${state}`}
                                    />
                                    <Text
                                        type='supporting'
                                        color='secondary'
                                    >
                                        {isOffline ?
                                            'Editor stopped'
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
                                     * Emphasis follows whatever the screen is for. With no editor
                                     * there is only one thing to do, and starting it is already the
                                     * primary; once the editor is live the project controls are, and
                                     * they were both rendering grey-on-grey, so a running workspace
                                     * had no primary action at all.
                                     */}
                                    <Button
                                        label={isPlaying ? 'Stop Game' : 'Run Game'}
                                        size='sm'
                                        variant={isOffline ? 'secondary' : 'primary'}
                                        isDisabled={isBusy || debug.isBusy}
                                        clickAction={() => {
                                            void (isPlaying ? project.stop() : project.run())
                                        }}
                                    />
                                    <Button
                                        label={isOffline ? 'Start Godot' : 'Stop Godot'}
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
                                onDismiss={clearFailure}
                            />
                        )}
                        <TabList
                            size='sm'
                            hasDivider
                            aria-label='Workspace views'
                            value={layout.centerTab}
                            onChange={value => {
                                dispatch({type: 'center-tab', tab: value as CenterTab})
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
                            <Tab
                                value='memory'
                                label='Memory'
                            />
                            {/*
                             * "Design" rather than "Sketches", and the reason is measured rather
                             * than stylistic: at the default panel widths this strip has 358 pixels
                             * and six labels, and "Sketches" needs 373. There is no slack left, so
                             * a seventh view — or a longer label on any of these six — needs the
                             * overflow `TabMenu` rather than another word.
                             */}
                            <Tab
                                value='sketches'
                                label='Design'
                            />
                        </TabList>
                        <StackItem size='fill'>
                            {layout.centerTab === 'chat' ?
                                <VStack
                                    gap={0}
                                    height='100%'
                                >
                                    {/*
                                     * Published here rather than lifted, because this is where the
                                     * tab dispatch lives and the conversation is drawn inside it.
                                     * One reader: an answered design block, pointing at the tab
                                     * holding the layout it agreed.
                                     */}
                                    <OpenCenterTabContext value={openCenterTab}>
                                        {chat}
                                    </OpenCenterTabContext>
                                </VStack>
                            : layout.centerTab === 'scripts' ?
                                <ScriptWorkspace
                                    scripts={scripts}
                                    views={views}
                                    onViewChange={recordView}
                                    {...(reveal && {reveal})}
                                />
                            : layout.centerTab === 'game' ?
                                <GameView />
                            : layout.centerTab === 'docs' ?
                                <DocsView />
                            : layout.centerTab === 'memory' ?
                                <MemoryView />
                            :   <SketchesView />}
                        </StackItem>
                        <Divider />
                        <VStack
                            gap={0}
                            height={layout.isBottomCollapsed ? 'auto' : BOTTOM_HEIGHT}
                        >
                            <BottomPanel
                                tab={layout.bottomTab}
                                onTabChange={tab => {
                                    dispatch({type: 'bottom-tab', tab})
                                }}
                                isCollapsed={layout.isBottomCollapsed}
                                onToggle={() => {
                                    dispatch({type: 'bottom-toggled'})
                                }}
                                logSeverity={layout.logSeverity}
                                onLogSeverityChange={severity => {
                                    dispatch({type: 'log-severity', severity})
                                }}
                                logScope={layout.logScope}
                                onLogScopeChange={scope => {
                                    dispatch({type: 'log-scope', scope})
                                }}
                                diagnostics={scripts.diagnostics}
                                debug={debug}
                                files={scripts.files}
                                onOpenLocation={openLocation}
                            />
                        </VStack>
                    </VStack>
                    {/*
                     * Only built at the width that can open it. A dialog that is merely closed
                     * still renders its children, so at every other width the inspector was mounted
                     * twice — two panels reading the selected node from the editor, drawing every
                     * property twice, one of them behind a dialog nothing can open.
                     */}
                    {isNarrow ?
                        <Dialog
                            isOpen={isInspectorOpen}
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
                    :   null}
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
