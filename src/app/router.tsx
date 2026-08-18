/* eslint-disable react-refresh/only-export-components -- Router configuration is shared with tests. */
import {
    Suspense,
    createContext,
    lazy,
    use,
    useCallback,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore
} from 'react'
import {
    createHashHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    redirect,
    RouterProvider,
    useMatch,
    useNavigate,
    useRouterState
} from '@tanstack/react-router'
import type {RouterHistory} from '@tanstack/react-router'
import {AppShell} from '@astryxdesign/core/AppShell'
import {defer} from '../services/clock'
import {HealthGate} from '../components/application/HealthGate'
import {InitializationSplash} from '../components/application/InitializationSplash'
import {Navigation} from '../components/application/Navigation'
import {preloadSettingsPage, preloadWorkspace} from './routes-preload'
import {
    activateTask,
    createTaskActions,
    isTaskOperationRunning,
    listTasks,
    watchTaskOperation
} from '../services/task-actions'
import {OpenTaskContext} from '../hooks/useOpenTask'
import {isTurnRunning, watchTurn} from '../services/turn-activity'
import {NewTaskDialog} from '../components/workspace/NewTaskDialog'
import {toSideNavLayout} from '../models/ui-state'
import {SIDE_NAV_KEY} from '../services/ui-state'
import {useRememberedValue} from '../hooks/useRememberedValue'
import type {Page, TaskSummary} from '../models/app'
import type {TaskDestination} from '../services/task-actions'
import type {TaskStart} from '../services/task-start'

type ApplicationContextValue = Readonly<{
    prepareModels: () => void
    refreshTasks: () => Promise<void>
    tasks: readonly TaskSummary[]
}>

const ApplicationContext = createContext<ApplicationContextValue | undefined>(undefined)
const SettingsPage = lazy(preloadSettingsPage)
const Workspace = lazy(() => preloadWorkspace().then(module => ({default: module.Workspace})))

async function redirectToCurrentTask() {
    const tasks = await listTasks()
    const currentTask = tasks.find(task => task.isCurrent)
    if (!currentTask) return
    return redirect({
        to: '/tasks/$taskId',
        params: {taskId: currentTask.id},
        replace: true
    })
}

/**
 * Opens the task the route names, or leaves the window on the task it is already showing.
 *
 * Run from `beforeLoad` rather than from the loader, because a loader's answer is cached per match
 * and a task opened a second time resolves from that cache at once — the workspace remounts and
 * reads before the switch it asked for has landed. `beforeLoad` runs on every navigation and the
 * navigation waits for it, which is the ordering the rest of the window assumes: the checkout, the
 * editor and the files are the task's own by the time anything mounts to read them.
 *
 * A switch is refused for reasons the click could not know about — a turn still running, another
 * task operation holding the checkout — and a loader that rejects has no error boundary above it:
 * the root one catches it and replaces the entire window with "Something went wrong", sidebar and
 * conversation and all, until the application is restarted. Measured in the shipped build, not
 * reasoned about.
 *
 * So a refusal sends the window back to the task the backend still calls current, which is the task
 * whose files are on disk and whose chat is on screen. A refusal about that task itself is nothing
 * to bounce: the route already names it.
 */
async function openTaskRoute(taskId: string) {
    try {
        await activateTask(taskId)
    } catch {
        const currentTask = (await listTasks()).find(task => task.isCurrent)
        if (!currentTask || currentTask.id === taskId) return
        return redirect({
            to: '/tasks/$taskId',
            params: {taskId: currentTask.id},
            replace: true
        })
    }
}

function useApplication() {
    const context = use(ApplicationContext)
    if (!context) throw new Error('Application context is unavailable')
    return context
}

function Application() {
    const [tasks, setTasks] = useState<readonly TaskSummary[]>([])
    const [isHealthy, setIsHealthy] = useState(false)
    const [isReady, setIsReady] = useState(false)
    // Absent rather than defaulted until the project has answered: mounting the sidebar open and
    // collapsing it a moment later is the same flash as never having remembered it.
    const navigate = useNavigate()
    const pathname = useRouterState({select: state => state.location.pathname})
    const selectedTaskId = useMatch({
        from: taskRoute.id,
        shouldThrow: false,
        select: match => (match.status === 'success' ? match.params.taskId : undefined)
    })
    const page: Page = pathname === '/settings' ? 'settings' : 'workspace'
    /*
     * The task the workspace belongs to, held across a route that is not a task.
     *
     * Settings is a route, so opening it leaves the task route unmatched and `selectedTaskId`
     * undefined — and the workspace's key below would have changed with it, remounting a workspace
     * that never left the screen. Mid-turn that was fatal: the remount threw away the chat runner
     * the running answer was streaming into, so the reply had nowhere to arrive and the next send
     * met the backend's "already in progress" guard with no way out but a restart.
     *
     * Adjusted during the render rather than from an effect, because the key is needed by this
     * render: an effect would let one render key the workspace on nothing first, which is the
     * remount it exists to prevent.
     */
    const [lastTaskId, setLastTaskId] = useState(selectedTaskId)
    const [isNewTaskOpen, setIsNewTaskOpen] = useState(false)
    if (selectedTaskId && selectedTaskId !== lastTaskId) setLastTaskId(selectedTaskId)
    const workspaceTaskId = selectedTaskId ?? lastTaskId
    const displayedTask =
        tasks.find(task => task.id === selectedTaskId) ?? tasks.find(task => task.isCurrent)
    const refreshTasks = useCallback(async () => {
        const nextTasks = await listTasks().catch(() => undefined)
        if (nextTasks) setTasks(nextTasks)
    }, [])
    const goToTask = useCallback(
        async (taskId: TaskDestination) => {
            if (taskId === undefined) {
                await navigate({to: '/'})
                return
            }
            await navigate({to: '/tasks/$taskId', params: {taskId}})
        },
        [navigate]
    )
    const tasksActions = useMemo(
        () => createTaskActions({navigate: goToTask, refresh: refreshTasks}),
        [goToTask, refreshTasks]
    )
    const openTask = useCallback(
        (taskId: string) => {
            void tasksActions.open(taskId)
        },
        [tasksActions]
    )
    const showApplication = useCallback(() => {
        setIsReady(true)
    }, [])
    const acceptWorkspace = useCallback(() => {
        setIsHealthy(true)
    }, [])
    const prepareModels = useCallback(() => {
        setIsReady(false)
    }, [])
    const navigateToCurrentTask = useCallback(() => {
        const currentTask = tasks.find(task => task.isCurrent)
        if (currentTask) {
            void navigate({to: '/tasks/$taskId', params: {taskId: currentTask.id}})
            return
        }
        void navigate({to: '/'})
    }, [navigate, tasks])
    const navigateToPage = useCallback(
        (nextPage: Page) => {
            if (nextPage === 'settings') {
                void navigate({to: '/settings'})
                return
            }
            navigateToCurrentTask()
        },
        [navigate, navigateToCurrentTask]
    )
    const tasksChanged = useCallback(() => {
        void refreshTasks()
    }, [refreshTasks])
    /*
     * The failure is prevented rather than reported. Every refusal the backend has for a creation —
     * a turn running, another task operation holding the checkout — is a state the sidebar can see,
     * and it stops offering the control while it lasts.
     */
    const newTask = useCallback(
        (start: TaskStart | undefined, bringChanges: boolean) => {
            void tasksActions.create(start, bringChanges).catch(() => undefined)
        },
        [tasksActions]
    )
    /*
     * Opening, creating, deleting and merging a task each move the project's one checkout, and each
     * stops the Godot editor before they do — a quit request and a wait of up to ten seconds. The
     * window used to look idle through all of it and answer every control, so a second operation was
     * one click away and the two met inside Git, where the loser died on `index.lock`.
     *
     * Read from the service rather than kept here, because opening a task is a route loader that
     * runs before any of this exists. See `watchTaskOperation`.
     */
    const isTaskBusy = useSyncExternalStore(
        watchTaskOperation,
        isTaskOperationRunning,
        isTaskOperationRunning
    )
    /*
     * Read the same way and for the same reason: the sidebar withholds the controls that would move
     * the checkout, and the conversation that knows a turn is running is mounted beside it rather
     * than above it.
     */
    const isAnswering = useSyncExternalStore(watchTurn, isTurnRunning, isTurnRunning)
    const mergeDisplayedTask = useCallback(
        () => tasksActions.merge(displayedTask),
        [displayedTask, tasksActions]
    )
    const resolveDisplayedMerge = useCallback(
        () => tasksActions.resolveMerge(displayedTask),
        [displayedTask, tasksActions]
    )
    const abandonDisplayedMerge = useCallback(
        () => tasksActions.abandonMerge(displayedTask),
        [displayedTask, tasksActions]
    )
    // Read while the health check and the models are still going, so it has arrived by the time
    // there is a sidebar to draw. `value` is undefined until it has, which is what the splash
    // below waits on — the sidebar never mounts on a default that would be written back.
    const {value: sideNav, change: changeSideNav} = useRememberedValue({
        key: SIDE_NAV_KEY,
        restore: toSideNavLayout
    })
    const context = useMemo<ApplicationContextValue>(
        () => ({prepareModels, refreshTasks, tasks}),
        [prepareModels, refreshTasks, tasks]
    )

    // Deferred to after the render rather than run inside it, so a mount and its StrictMode double
    // collapse into one refresh instead of two.
    useEffect(() => {
        if (!isReady) return
        return defer(() => {
            void refreshTasks()
        })
    }, [isReady, refreshTasks])

    // The workspace is checked before the models are downloaded: a folder Gofer cannot work in is
    // not worth a gigabyte of models, and the fixes for it are the ones the user can actually make.
    if (!isHealthy) return <HealthGate onReady={acceptWorkspace} />
    if (!isReady || !sideNav) return <InitializationSplash onReady={showApplication} />

    return (
        <ApplicationContext value={context}>
            {/*
             * `section` paints the task list and the workspace with one surface and separates them
             * with a hairline: 89.8% of the window measured as a single grey, so nothing told the
             * eye where the frame ended and the work began. `elevated` drops the nav to the body
             * colour and leaves the content on surface, which is the layering the ramp is for.
             */}
            <AppShell
                contentPadding={0}
                variant='elevated'
                sideNav={
                    <Navigation
                        page={page}
                        tasks={tasks}
                        isBusy={isTaskBusy}
                        isTurnRunning={isAnswering}
                        sideNav={sideNav}
                        onSideNavChange={changeSideNav}
                        onNavigate={navigateToPage}
                        onNewTask={() => {
                            setIsNewTaskOpen(true)
                        }}
                        onOpenTask={openTask}
                        onDeleteTask={taskId => {
                            void tasksActions.remove(taskId)
                        }}
                        {...(selectedTaskId && {selectedTaskId})}
                    />
                }
            >
                <Suspense fallback={null}>
                    {/*
                     * The key resets the workspace when the user switches tasks, so it follows the
                     * task the route names and nothing else. Keying on the task list instead would
                     * remount the moment the first list arrives — while the workspace is already
                     * showing that very task — and a remount discards whatever has not reached the
                     * debounced chat save yet, which is exactly a message just sent.
                     */}
                    <OpenTaskContext value={openTask}>
                        <Workspace
                            key={workspaceTaskId ?? 'workspace'}
                            {...(workspaceTaskId && {taskId: workspaceTaskId})}
                            isTaskBusy={isTaskBusy}
                            onTasksChanged={tasksChanged}
                            onMergeTask={mergeDisplayedTask}
                            onResolveMerge={resolveDisplayedMerge}
                            onAbandonMerge={abandonDisplayedMerge}
                            {...(displayedTask && {activeTask: displayedTask})}
                        />
                    </OpenTaskContext>
                </Suspense>
                <Outlet />
                {/*
                 * Mounted only while it is open. The dialog's own title is the same words as the
                 * control that opens it, and a closed dialog left in the tree keeps that text in the
                 * document — which is a real ambiguity for anything reading the screen, not only for
                 * a test.
                 */}
                {isNewTaskOpen && (
                    <NewTaskDialog
                        isOpen
                        onOpenChange={setIsNewTaskOpen}
                        onPlan={(prompt, bringChanges) => {
                            newTask({prompt, mode: 'planned'}, bringChanges)
                        }}
                        /*
                         * An empty ask stages nothing at all. Skipping with the box untouched is the
                         * plain "new task" it looks like: the chat opens on an empty composer, and a
                         * staged start holding an empty string would be a draft of nothing.
                         */
                        onSkip={(prompt, bringChanges) => {
                            newTask(prompt ? {prompt, mode: 'draft'} : undefined, bringChanges)
                        }}
                    />
                )}
            </AppShell>
        </ApplicationContext>
    )
}

function TaskRoute() {
    const {refreshTasks} = useApplication()
    const {taskId} = taskRoute.useParams()

    useEffect(() => {
        void refreshTasks()
    }, [refreshTasks, taskId])

    return null
}

function SettingsRoute() {
    const {prepareModels, tasks} = useApplication()
    const navigate = useNavigate()

    return (
        <Suspense fallback={null}>
            <SettingsPage
                isOpen
                onOpenChange={isOpen => {
                    if (isOpen) return
                    const currentTask = tasks.find(task => task.isCurrent)
                    if (currentTask) {
                        void navigate({to: '/tasks/$taskId', params: {taskId: currentTask.id}})
                        return
                    }
                    void navigate({to: '/'})
                }}
                onCacheDeleted={prepareModels}
            />
        </Suspense>
    )
}

const rootRoute = createRootRoute({component: Application})
const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    loader: redirectToCurrentTask
})
const legacyWorkspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'workspace',
    loader: redirectToCurrentTask
})
const taskRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'tasks/$taskId',
    beforeLoad: ({params}) => openTaskRoute(params.taskId),
    component: TaskRoute
})
const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: 'settings',
    component: SettingsRoute
})
const routeTree = rootRoute.addChildren([
    indexRoute,
    legacyWorkspaceRoute,
    taskRoute,
    settingsRoute
])
export function createAppRouter(history: RouterHistory = createHashHistory()) {
    return createRouter({routeTree, history})
}

const router = createAppRouter()

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

export default function AppRouter() {
    return <RouterProvider router={router} />
}
