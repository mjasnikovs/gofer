/* eslint-disable react-refresh/only-export-components -- Router configuration is shared with tests. */
import {createContext, use, useCallback, useEffect, useMemo, useState} from 'react'
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
import {invoke, isTauri} from '@tauri-apps/api/core'
import {InitializationSplash, Navigation, SettingsPage, Workspace} from './App'
import {isTaskSummary} from './app-models'
import type {Page, TaskSummary} from './app-models'

type CreatedTask = Readonly<{
    taskId?: string
}>

type ApplicationContextValue = Readonly<{
    prepareModels: () => void
    refreshTasks: () => Promise<void>
    tasks: readonly TaskSummary[]
}>

const ApplicationContext = createContext<ApplicationContextValue | undefined>(undefined)

async function loadTasks() {
    if (!isTauri()) return []
    const response = await invoke<unknown>('list_project_tasks')
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
        const created = await invoke<CreatedTask>('create_chat_task').catch(() => undefined)
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

    if (!isReady) return <InitializationSplash onReady={showApplication} />

    return (
        <ApplicationContext value={context}>
            <AppShell
                contentPadding={0}
                variant='section'
                sideNav={
                    <Navigation
                        page={page}
                        tasks={tasks}
                        onNavigate={navigateToPage}
                        onNewTask={() => {
                            void newTask()
                        }}
                        onOpenTask={openTask}
                        {...(selectedTaskId && {selectedTaskId})}
                    />
                }
            >
                <Workspace
                    key={displayedTask?.id ?? selectedTaskId ?? 'workspace'}
                    onTasksChanged={tasksChanged}
                    onMergeTask={mergeDisplayedTask}
                    {...(displayedTask && {activeTask: displayedTask})}
                />
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
