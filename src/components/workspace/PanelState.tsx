import type {ReactNode} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Spinner} from '@astryxdesign/core/Spinner'
import {Text} from '@astryxdesign/core/Text'
import type {GodotError} from '../../models/godot'
import {SESSION_OTHER_TASK, SessionTaskBanner} from './SessionTaskBanner'

type PanelStateProps = Readonly<{
    label: string
    isLoading: boolean
    error?: GodotError | undefined
    isEmpty: boolean
    emptyTitle: string
    emptyDescription?: string | undefined
    emptyAction?: ReactNode
    children: ReactNode
}>

export function PanelState({
    label,
    isLoading,
    error,
    isEmpty,
    emptyTitle,
    emptyDescription,
    emptyAction,
    children
}: PanelStateProps) {
    if (error?.code === SESSION_OTHER_TASK) return <SessionTaskBanner error={error} />
    if (error)
        return (
            <Banner
                container='section'
                status={error.retryable ? 'warning' : 'error'}
                title={`The ${label} could not be read`}
                description={`${error.message} (${error.code})`}
            />
        )
    if (isLoading)
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
                    {`Loading the ${label}…`}
                </Text>
            </HStack>
        )
    if (isEmpty)
        return (
            <VStack padding={3}>
                <EmptyState
                    isCompact
                    headingLevel={3}
                    title={emptyTitle}
                    {...(emptyDescription && {description: emptyDescription})}
                    {...(emptyAction && {actions: emptyAction})}
                />
            </VStack>
        )
    return children
}
