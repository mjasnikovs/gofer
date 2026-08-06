import {useState} from 'react'
import {AlertDialog} from '@astryxdesign/core/AlertDialog'
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
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import PlusIcon from '@heroicons/react/24/outline/PlusIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {preloadSettingsPage, preloadWorkspace} from '../../app/routes-preload'
import type {Page, TaskSummary} from '../../models/app'

type NavigationProps = Readonly<{
    page: Page
    selectedTaskId?: string
    tasks: readonly TaskSummary[]
    onNavigate: (page: Page) => void
    onNewTask: () => void
    onOpenTask: (taskId: string) => void
    onDeleteTask: (taskId: string) => void
}>

type TaskRowProps = Readonly<{
    task: TaskSummary
    isSelected: boolean
    onOpenTask: (taskId: string) => void
    onDeleteTask: (task: TaskSummary) => void
}>

/**
 * One task in the sidebar: the link that opens it, and the button that deletes it.
 *
 * The delete button is a sibling of the navigation item rather than its `endContent`, because that
 * slot renders inside the item's own link — a button nested in an anchor, which navigates as well as
 * deletes. The collapsed rail has no room for it and shows the link alone.
 */
function TaskRow({task, isSelected, onOpenTask, onDeleteTask}: TaskRowProps) {
    const {isCollapsed} = useSideNavCollapse()

    return (
        <HStack
            align='center'
            gap={0.5}
        >
            <StackItem size='fill'>
                <SideNavItem
                    label={task.title}
                    href={`#/tasks/${encodeURIComponent(task.id)}`}
                    isSelected={isSelected}
                    // The workspace chunk starts downloading while the pointer is still on its way
                    // to the click, rather than after it.
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
    )
}

export function Navigation({
    page,
    selectedTaskId,
    tasks,
    onNavigate,
    onNewTask,
    onOpenTask,
    onDeleteTask
}: NavigationProps) {
    const [taskToDelete, setTaskToDelete] = useState<TaskSummary | undefined>(undefined)

    return (
        <>
            <SideNav
                collapsible
                resizable={{defaultWidth: 280, minWidth: 220, maxWidth: 400}}
                header={
                    <SideNavHeading
                        heading='Gofer'
                        icon={
                            <NavIcon
                                icon={
                                    <Icon
                                        icon={SparklesIcon}
                                        size='sm'
                                        color='accent'
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
                    <SideNavItem
                        label='New task'
                        icon={PlusIcon}
                        href='#/'
                        onClick={event => {
                            event.preventDefault()
                            onNewTask()
                        }}
                    />
                </SideNavSection>
                {tasks.length > 0 ?
                    <SideNavSection title='Tasks'>
                        {tasks.map(task => (
                            <TaskRow
                                key={task.id}
                                task={task}
                                isSelected={page === 'workspace' && task.id === selectedTaskId}
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
                        `"${taskToDelete.title}" and its chat are removed, and the Git branch and worktree Gofer made for it are deleted with everything still uncommitted or unmerged in them. This cannot be undone.`
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
