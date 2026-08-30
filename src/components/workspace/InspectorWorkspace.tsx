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
import {SkillsView} from './SkillsView'
import {ExplorerPanel} from './ExplorerPanel'
import {GameView} from './GameView'
import {InspectorPanel} from './InspectorPanel'
import {ScriptWorkspace} from './ScriptWorkspace'
import type {ScriptReveal} from './ScriptWorkspace'

type InspectorWorkspaceProps = Readonly<{
    chat: ReactNode
    onError: (message: string) => void
}>

type InspectorFrameProps = InspectorWorkspaceProps
    & Readonly<{
        layout: WorkspaceLayout
        views: ScriptViews
        dispatch: (action: LayoutAction) => void
        recordView: (path: string, view: unknown) => void
    }>

type FrameRegionsProps = Omit<InspectorFrameProps, 'onError'>
    & Readonly<{
        report: (message: string) => void
        clearFailure: () => void
        failure?: string | undefined
    }>

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

function useNarrowViewport() {
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

export const InspectorWorkspace = memo(function Frame({chat, onError}: InspectorWorkspaceProps) {
    const {state, dispatch, recordView} = useRememberedLayout()

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

function InspectorFrame({chat, layout, views, dispatch, recordView, onError}: InspectorFrameProps) {
    const [failure, setFailure] = useState<string>()

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

    const project = useMemo(
        () => createProjectActions({call, ensureReady, debug, dispatch, report}),
        [call, debug, dispatch, ensureReady, report]
    )

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
                        <StackItem size='static'>
                            <HStack
                                gap={0}
                                isScrollable
                            >
                                <TabList
                                    size='sm'
                                    hasDivider
                                    style={{flexGrow: 1}}
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
                                    <Tab
                                        value='sketches'
                                        label='Design'
                                    />
                                    <Tab
                                        value='skills'
                                        label='Skills'
                                    />
                                </TabList>
                            </HStack>
                        </StackItem>
                        <StackItem size='fill'>
                            {layout.centerTab === 'chat' ?
                                <VStack
                                    gap={0}
                                    height='100%'
                                >
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
                            : layout.centerTab === 'skills' ?
                                <SkillsView />
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
