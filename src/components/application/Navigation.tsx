import {Icon} from '@astryxdesign/core/Icon'
import {NavIcon} from '@astryxdesign/core/NavIcon'
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav'
import Cog6ToothIcon from '@heroicons/react/24/outline/Cog6ToothIcon'
import PlusIcon from '@heroicons/react/24/outline/PlusIcon'
import SparklesIcon from '@heroicons/react/24/outline/SparklesIcon'
import type {Page, TaskSummary} from '../../models/app'

type NavigationProps = Readonly<{
    page: Page
    selectedTaskId?: string
    tasks: readonly TaskSummary[]
    onNavigate: (page: Page) => void
    onNewTask: () => void
    onOpenTask: (taskId: string) => void
}>

export function Navigation({
    page,
    selectedTaskId,
    tasks,
    onNavigate,
    onNewTask,
    onOpenTask
}: NavigationProps) {
    return (
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
                        <SideNavItem
                            key={task.id}
                            label={task.title}
                            href={`#/tasks/${encodeURIComponent(task.id)}`}
                            isSelected={page === 'workspace' && task.id === selectedTaskId}
                            onClick={event => {
                                event.preventDefault()
                                onOpenTask(task.id)
                            }}
                        />
                    ))}
                </SideNavSection>
            :   null}
        </SideNav>
    )
}
