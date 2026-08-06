/* eslint-disable react-refresh/only-export-components -- Router configuration is shared with tests. */
import {Suspense, createContext, lazy, use, useCallback, useEffect, useMemo, useState} from 'react'
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
import {invoke, isTauri} from '../services/desktop'
import {HealthGate} from '../components/application/HealthGate'
import {InitializationSplash} from '../components/application/InitializationSplash'
import {Navigation} from '../components/application/Navigation'
import {preloadSettingsPage, preloadWorkspace} from './routes-preload'
import {isTaskSummary} from '../models/app'
import type {Page, TaskSummary} from '../models/app'

type ApplicationContextValue = Readonly<{
    prepareModels: () => void
    refreshTasks: () => Promise<void>
    tasks: readonly TaskSummary[]
}>

const ApplicationContext = createContext<ApplicationContextValue | undefined>(undefined)
const SettingsPage = lazy(preloadSettingsPage)
const Workspace = lazy(() => preloadWorkspace().then(module => ({default: module.Workspace})))

async function loadTasks() {
    if (!isTauri()) return []
    const response = await invoke('list_project_tasks')
    if (!Array.isArray(response) || !response.every(isTaskSummary)) return []
    return response
}

async function redirectToCurrentTask() {
    const tasks = await loadTasks()
    const currentTask = tasks.find(task => task.isCurrent)
    if (!currentTask) return
    return redirect({
        to: '/tasks/$taskId',
        params: {taskId: currentTask.id},
        replace: true
    })
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
    const displayedTask =
        tasks.find(task => task.id === selectedTaskId) ?? tasks.find(task => task.isCurrent)
    const refreshTasks = useCallback(async () => {
        const nextTasks = await loadTasks().catch(() => undefined)
        if (nextTasks) setTasks(nextTasks)
    }, [])
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
    const newTask = useCallback(async () => {
        if (!isTauri()) return
        const created = await invoke('create_chat_task').catch(() => undefined)
        if (!created?.taskId) return
        await refreshTasks()
        await navigate({to: '/tasks/$taskId', params: {taskId: created.taskId}})
    }, [navigate, refreshTasks])
    const openTask = useCallback(
        (taskId: string) => {
            void navigate({to: '/tasks/$taskId', params: {taskId}})
        },
        [navigate]
    )
    // The backend answers with the task that took the deleted one's place, so the workspace follows
    // it rather than being left on a route whose task no longer exists.
    const deleteTask = useCallback(
        async (taskId: string) => {
            if (!isTauri()) return
            const replacement = await invoke('delete_chat_task', {taskId}).catch(() => undefined)
            await refreshTasks()
            if (!replacement?.taskId) {
                await navigate({to: '/'})
                return
            }
            await navigate({to: '/tasks/$taskId', params: {taskId: replacement.taskId}})
        },
        [navigate, refreshTasks]
    )
    const tasksChanged = useCallback(() => {
        void refreshTasks()
    }, [refreshTasks])
    const mergeDisplayedTask = useCallback(async () => {
        if (!displayedTask?.worktree) return
        await invoke('merge_task_worktree', {taskId: displayedTask.id})
        await refreshTasks()
    }, [displayedTask, refreshTasks])
    const context = useMemo<ApplicationContextValue>(
        () => ({prepareModels, refreshTasks, tasks}),
        [prepareModels, refreshTasks, tasks]
    )

    useEffect(() => {
        if (!isReady) return
        const timeout = window.setTimeout(() => {
            void refreshTasks()
        }, 0)
        return () => {
            window.clearTimeout(timeout)
        }
    }, [isReady, refreshTasks])

    // The workspace is checked before the models are downloaded: a folder Gofer cannot work in is
    // not worth a gigabyte of models, and the fixes for it are the ones the user can actually make.
    if (!isHealthy) return <HealthGate onReady={acceptWorkspace} />
    if (!isReady) return <InitializationSplash onReady={showApplication} />

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
                        onNavigate={navigateToPage}
                        onNewTask={() => {
                            void newTask()
                        }}
                        onOpenTask={openTask}
                        onDeleteTask={taskId => {
                            void deleteTask(taskId)
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
                    <Workspace
                        key={selectedTaskId ?? 'workspace'}
                        onTasksChanged={tasksChanged}
                        onMergeTask={mergeDisplayedTask}
                        {...(displayedTask && {activeTask: displayedTask})}
                    />
                </Suspense>
                <Outlet />
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
    loader: async ({params}) => {
        if (!isTauri()) return
        await invoke('activate_chat_task', {taskId: params.taskId})
    },
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
