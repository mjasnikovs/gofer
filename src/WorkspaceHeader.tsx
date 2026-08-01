import {Button} from '@astryxdesign/core/Button'
import {Icon} from '@astryxdesign/core/Icon'
import {HStack} from '@astryxdesign/core/Stack'
import {StatusDot} from '@astryxdesign/core/StatusDot'
import {Heading, Text} from '@astryxdesign/core/Text'
import {Token} from '@astryxdesign/core/Token'
import ArrowPathIcon from '@heroicons/react/24/outline/ArrowPathIcon'
import PlayIcon from '@heroicons/react/24/outline/PlayIcon'
import StopIcon from '@heroicons/react/24/outline/StopIcon'
import type {TaskSummary} from './app-models'

export type ConnectionState = 'connecting' | 'connected' | 'offline'

type WorkspaceHeaderProps = Readonly<{
    activeTask?: TaskSummary
    connectionState: ConnectionState
    isGodotRunning: boolean
    onConnect: () => void
    onMergeTask: () => void
    onRunGodot: () => void
    onStopGodot: () => void
}>

export function WorkspaceHeader({
    activeTask,
    connectionState,
    isGodotRunning,
    onConnect,
    onMergeTask,
    onRunGodot,
    onStopGodot
}: WorkspaceHeaderProps) {
    const connectionVariant =
        connectionState === 'connected' ? 'success'
        : connectionState === 'connecting' ? 'warning'
        : 'error'

    return (
        <HStack
            padding={4}
            hAlign='between'
            vAlign='center'
        >
            <HStack
                gap={3}
                vAlign='center'
            >
                <Heading level={2}>{activeTask?.title ?? 'New task'}</Heading>
                <Token label='Godot 4.7' />
            </HStack>
            <HStack
                gap={2}
                vAlign='center'
            >
                <HStack
                    gap={1}
                    vAlign='center'
                >
                    <StatusDot
                        variant={connectionVariant}
                        label={connectionState}
                    />
                    <Text type='supporting'>Local AI {connectionState}</Text>
                </HStack>
                {connectionState === 'offline' ?
                    <Button
                        label='Reconnect'
                        variant='ghost'
                        size='sm'
                        icon={
                            <Icon
                                icon={ArrowPathIcon}
                                size='sm'
                            />
                        }
                        clickAction={onConnect}
                    />
                :   null}
                <Button
                    label={isGodotRunning ? 'Stop Godot' : 'Run project'}
                    variant={isGodotRunning ? 'destructive' : 'secondary'}
                    size='sm'
                    icon={
                        <Icon
                            icon={isGodotRunning ? StopIcon : PlayIcon}
                            size='sm'
                        />
                    }
                    clickAction={isGodotRunning ? onStopGodot : onRunGodot}
                />
                {activeTask?.worktree && !activeTask.worktree.mergedCommit ?
                    <Button
                        label='Merge task'
                        variant='secondary'
                        size='sm'
                        clickAction={onMergeTask}
                    />
                :   null}
            </HStack>
        </HStack>
    )
}
