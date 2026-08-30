import {useState} from 'react'
import type {ReactNode} from 'react'
import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {Avatar} from '@astryxdesign/core/Avatar'
import {Icon} from '@astryxdesign/core/Icon'
import {IconButton} from '@astryxdesign/core/IconButton'
import {NavIcon} from '@astryxdesign/core/NavIcon'
import {
    SideNav,
    SideNavHeading,
    SideNavItem,
    SideNavSection,
    useSideNavCollapse
} from '@astryxdesign/core/SideNav'
import {HStack, StackItem} from '@astryxdesign/core/Stack'
import {Tooltip} from '@astryxdesign/core/Tooltip'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import PlusIcon from '@heroicons/react/24/outline/PlusIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {preloadSettingsPage, preloadWorkspace} from '../../app/routes-preload'
import mascotUrl from '../../assets/gofer-mascot.png'
import {SIDE_NAV_MAX, SIDE_NAV_MIN, isSideNavWidth} from '../../models/ui-state'
import type {SideNavLayout} from '../../models/ui-state'
import type {Page, TaskSummary} from '../../models/app'

type NavigationProps = Readonly<{
    page: Page
    selectedTaskId?: string
    tasks: readonly TaskSummary[]
    isBusy: boolean
    isTurnRunning: boolean
    sideNav: SideNavLayout
    onNavigate: (page: Page) => void
    onNewTask: () => void
    onOpenTask: (taskId: string) => void
    onDeleteTask: (taskId: string) => void
    onSideNavChange: (change: (current: SideNavLayout) => SideNavLayout) => void
}>

type TaskRowProps = Readonly<{
    task: TaskSummary
    isSelected: boolean
    lockedReason?: string
    onOpenTask: (taskId: string) => void
    onDeleteTask: (task: TaskSummary) => void
}>

function Locked({reason, children}: {reason: string | undefined; children: ReactNode}) {
    if (reason === undefined) return children
    return (
        <Tooltip content={reason}>
            <HStack>{children}</HStack>
        </Tooltip>
    )
}

function TaskRow({task, isSelected, lockedReason, onOpenTask, onDeleteTask}: TaskRowProps) {
    const {isCollapsed} = useSideNavCollapse()

    return (
        <Locked reason={lockedReason}>
            <HStack
                align='center'
                gap={0.5}
            >
                <StackItem size='fill'>
                    <SideNavItem
                        label={task.title}
                        href={`#/tasks/${encodeURIComponent(task.id)}`}
                        isSelected={isSelected}
                        isDisabled={lockedReason !== undefined}
                        onMouseEnter={() => {
                            void preloadWorkspace()
                        }}
                        onFocus={() => {
                            void preloadWorkspace()
                        }}
                        onClick={event => {
                            event.preventDefault()
                            onOpenTask(task.id)
                        }}
                    />
                </StackItem>
                {isCollapsed ? null : (
                    <IconButton
                        label={`Delete task ${task.title}`}
                        tooltip='Delete task'
                        variant='ghost'
                        size='sm'
                        isDisabled={lockedReason !== undefined}
                        icon={
                            <Icon
                                icon={TrashIcon}
                                size='sm'
                            />
                        }
                        onClick={() => {
                            onDeleteTask(task)
                        }}
                    />
                )}
            </HStack>
        </Locked>
    )
}

export function Navigation({
    page,
    selectedTaskId,
    tasks,
    isBusy,
    isTurnRunning,
    sideNav,
    onNavigate,
    onNewTask,
    onOpenTask,
    onDeleteTask,
    onSideNavChange
}: NavigationProps) {
    const [taskToDelete, setTaskToDelete] = useState<TaskSummary | undefined>(undefined)
    const lockedReason =
        isBusy ? 'Another task operation is still finishing. This will come back when it does.'
        : isTurnRunning ?
            'Gofer is working. Stop it to open or create a task — it is reading the files a switch would move.'
        :   undefined

    return (
        <>
            <SideNav
                aria-busy={isBusy}
                collapsible={{
                    defaultIsCollapsed: sideNav.isCollapsed,
                    onCollapsedChange: isCollapsed => {
                        onSideNavChange(current => ({...current, isCollapsed}))
                    }
                }}
                resizable={{
                    defaultWidth: sideNav.width,
                    minWidth: SIDE_NAV_MIN,
                    maxWidth: SIDE_NAV_MAX,
                    onWidthChange: width => {
                        if (isSideNavWidth(width)) onSideNavChange(current => ({...current, width}))
                    }
                }}
                header={
                    <SideNavHeading
                        heading='Gofer'
                        icon={
                            <NavIcon
                                icon={
                                    <Avatar
                                        src={mascotUrl}
                                        size={32}
                                        alt=''
                                        tooltip={false}
                                    />
                                }
                            />
                        }
                        headingHref='#/'
                    />
                }
                footer={
                    <SideNavSection
                        title='System'
                        isHeaderHidden
                    >
                        <SideNavItem
                            label='Settings'
                            icon={Cog6ToothIcon}
                            href='#/settings'
                            isSelected={page === 'settings'}
                            onMouseEnter={() => {
                                void preloadSettingsPage()
                            }}
                            onFocus={() => {
                                void preloadSettingsPage()
                            }}
                            onClick={event => {
                                event.preventDefault()
                                onNavigate('settings')
                            }}
                        />
                    </SideNavSection>
                }
            >
                <SideNavSection
                    title='Actions'
                    isHeaderHidden
                >
                    <Locked reason={lockedReason}>
                        <SideNavItem
                            label='New task'
                            icon={PlusIcon}
                            href='#/'
                            isDisabled={lockedReason !== undefined}
                            onClick={event => {
                                event.preventDefault()
                                onNewTask()
                            }}
                        />
                    </Locked>
                </SideNavSection>
                {tasks.length > 0 ?
                    <SideNavSection title='Tasks'>
                        {tasks.map(task => (
                            <TaskRow
                                key={task.id}
                                task={task}
                                isSelected={page === 'workspace' && task.id === selectedTaskId}
                                {...(lockedReason !== undefined && {lockedReason})}
                                onOpenTask={onOpenTask}
                                onDeleteTask={setTaskToDelete}
                            />
                        ))}
                    </SideNavSection>
                :   null}
            </SideNav>
            <AlertDialog
                isOpen={taskToDelete !== undefined}
                onOpenChange={isOpen => {
                    if (!isOpen) setTaskToDelete(undefined)
                }}
                title='Delete this task?'
                description={
                    taskToDelete ?
                        `"${taskToDelete.title}" and its chat are removed, and the Git branch Gofer made for it is deleted with everything still uncommitted or unmerged on it. This cannot be undone.`
                    :   ''
                }
                actionLabel='Delete task'
                onAction={() => {
                    if (taskToDelete) onDeleteTask(taskToDelete.id)
                    setTaskToDelete(undefined)
                }}
            />
        </>
    )
}
