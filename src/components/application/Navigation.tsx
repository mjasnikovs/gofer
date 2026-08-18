import {useState} from 'react'
import type {ReactNode} from 'react'
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
import {Tooltip} from '@astryxdesign/core/Tooltip'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import PlusIcon from '@heroicons/react/24/outline/PlusIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import TrashIcon from '@heroicons/react/24/outline/TrashIcon'
import {preloadSettingsPage, preloadWorkspace} from '../../app/routes-preload'
import {SIDE_NAV_MAX, SIDE_NAV_MIN, isSideNavWidth} from '../../models/ui-state'
import type {SideNavLayout} from '../../models/ui-state'
import type {Page, TaskSummary} from '../../models/app'

type NavigationProps = Readonly<{
    page: Page
    selectedTaskId?: string
    tasks: readonly TaskSummary[]
    /**
     * Whether a task operation is running. Opening, creating, deleting and merging a task each move
     * the project's one checkout and stop the Godot editor first, which takes seconds. Nothing that
     * would start a second one is offered while one is running.
     */
    isBusy: boolean
    /**
     * Whether the agent is answering. The same controls are withheld, for the same reason one step
     * earlier: the checkout they move is the one the running turn is reading.
     */
    isTurnRunning: boolean
    /** How the sidebar was left last time: what it opens as, and what changes are reported against. */
    sideNav: SideNavLayout
    onNavigate: (page: Page) => void
    onNewTask: () => void
    onOpenTask: (taskId: string) => void
    onDeleteTask: (taskId: string) => void
    onSideNavChange: (sideNav: SideNavLayout) => void
}>

type TaskRowProps = Readonly<{
    task: TaskSummary
    isSelected: boolean
    /** Why this row is not offered, or absent when it is. See [`Locked`]. */
    lockedReason?: string
    onOpenTask: (taskId: string) => void
    onDeleteTask: (task: TaskSummary) => void
}>

/**
 * Says why a control is not offered, on hover and on focus.
 *
 * A disabled control has no voice of its own: it stops answering and explains nothing, which reads
 * as the window having broken rather than as the window being busy. The reason is on the wrapper
 * rather than the control because a disabled button emits no pointer events for a tooltip to hear.
 */
function Locked({reason, children}: {reason: string | undefined; children: ReactNode}) {
    if (reason === undefined) return children
    return (
        <Tooltip content={reason}>
            <HStack>{children}</HStack>
        </Tooltip>
    )
}

/**
 * One task in the sidebar: the link that opens it, and the button that deletes it.
 *
 * The delete button is a sibling of the navigation item rather than its `endContent`, because that
 * slot renders inside the item's own link — a button nested in an anchor, which navigates as well as
 * deletes. The collapsed rail has no room for it and shows the link alone.
 */
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
    /*
     * The two reasons a task control is withheld, in the order the user meets them.
     *
     * Both are the same fact from the backend's side — the project's one checkout is spoken for —
     * and both are temporary. Neither is worth an error the user has to dismiss: the control simply
     * is not offered, and hovering it says why and what ends the wait.
     */
    const lockedReason =
        isBusy ? 'Another task operation is still finishing. This will come back when it does.'
        : isTurnRunning ?
            'Gofer is working. Stop it to open or create a task — it is reading the files a switch would move.'
        :   undefined

    return (
        <>
            <SideNav
                // Announced as well as disabled: a sidebar that has gone quiet for the seconds it
                // takes to stop an editor has to say it is working, not look broken.
                aria-busy={isBusy}
                /*
                 * Opened as the project was left, and every change reported back so it stays that
                 * way. Before this the sidebar was told nothing: it opened at 280px on every
                 * launch, and closing it or dragging it narrower was a choice the next launch lost.
                 *
                 * Started rather than controlled. `SideNav` gives its resize hook the same collapse
                 * setter, so the hook answers a collapse by reporting a state of its own — and a
                 * controlled flag was set back to open by that report before the click had landed.
                 */
                collapsible={{
                    defaultIsCollapsed: sideNav.isCollapsed,
                    onCollapsedChange: isCollapsed => {
                        onSideNavChange({...sideNav, isCollapsed})
                    }
                }}
                resizable={{
                    defaultWidth: sideNav.width,
                    minWidth: SIDE_NAV_MIN,
                    maxWidth: SIDE_NAV_MAX,
                    onWidthChange: width => {
                        if (isSideNavWidth(width)) onSideNavChange({...sideNav, width})
                    }
                }}
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
