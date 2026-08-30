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
    listPendingChanges,
    listTasks,
    watchTaskOperation
} from '../services/task-actions'
import {OpenTaskContext} from '../hooks/useOpenTask'
import {isTurnRunning, watchTurn} from '../services/turn-activity'
import {NewTaskDialog} from '../components/workspace/NewTaskDialog'
import {toSideNavLayout} from '../models/ui-state'
import {SIDE_NAV_KEY} from '../services/ui-state'
import {useRememberedValue} from '../hooks/useRememberedValue'
import type {Page, PendingChange, TaskSummary} from '../models/app'
import type {TaskDestination} from '../services/task-actions'
import type {UnsavedWork} from '../models/unsaved-work'

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
    const navigate = useNavigate()
    const pathname = useRouterState({select: state => state.location.pathname})
    const selectedTaskId = useMatch({
        from: taskRoute.id,
        shouldThrow: false,
        select: match => (match.status === 'success' ? match.params.taskId : undefined)
    })
    const page: Page = pathname === '/settings' ? 'settings' : 'workspace'
    const [lastTaskId, setLastTaskId] = useState(selectedTaskId)
    const [pendingChanges, setPendingChanges] = useState<readonly PendingChange[]>([])
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
    const newTask = useCallback(
        (bringChanges: boolean) => {
            void tasksActions.create(bringChanges).catch(() => undefined)
        },
        [tasksActions]
    )
    const startNewTask = useCallback(() => {
        void listPendingChanges()
            .catch(() => [])
            .then(pending => {
                if (pending.length === 0) {
                    newTask(false)
                    return
                }
                setPendingChanges(pending)
            })
    }, [newTask])
    const isTaskBusy = useSyncExternalStore(
        watchTaskOperation,
        isTaskOperationRunning,
        isTaskOperationRunning
    )
    const isAnswering = useSyncExternalStore(watchTurn, isTurnRunning, isTurnRunning)
    const mergeDisplayedTask = useCallback(
        (unsavedWork?: UnsavedWork) => tasksActions.merge(displayedTask, unsavedWork),
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
    const {value: sideNav, change: changeSideNav} = useRememberedValue({
        key: SIDE_NAV_KEY,
        restore: toSideNavLayout
    })
    const context = useMemo<ApplicationContextValue>(
        () => ({prepareModels, refreshTasks, tasks}),
        [prepareModels, refreshTasks, tasks]
    )

    useEffect(() => {
        if (!isReady) return
        return defer(() => {
            void refreshTasks()
        })
    }, [isReady, refreshTasks])

    if (!isHealthy) return <HealthGate onReady={acceptWorkspace} />
    if (!isReady || !sideNav) return <InitializationSplash onReady={showApplication} />

    return (
        <ApplicationContext value={context}>
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
                        onNewTask={startNewTask}
                        onOpenTask={openTask}
                        onDeleteTask={taskId => {
                            void tasksActions.remove(taskId)
                        }}
                        {...(selectedTaskId && {selectedTaskId})}
                    />
                }
            >
                <Suspense fallback={null}>
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
                {pendingChanges.length > 0 && (
                    <NewTaskDialog
                        isOpen
                        changes={pendingChanges}
                        onOpenChange={isOpen => {
                            if (!isOpen) setPendingChanges([])
                        }}
                        onCreate={newTask}
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
