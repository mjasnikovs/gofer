import type {ReactNode} from 'react'
import {Banner} from '@astryxdesign/core/Banner'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Spinner} from '@astryxdesign/core/Spinner'
import {Text} from '@astryxdesign/core/Text'
import type {GodotError} from '../../models/godot'

type PanelStateProps = Readonly<{
    /** What the panel is reading, named for the status message: “Loading the scene tree…”. */
    label: string
    isLoading: boolean
    error?: GodotError | undefined
    isEmpty: boolean
    emptyTitle: string
    emptyDescription?: string | undefined
    children: ReactNode
}>

/**
 * The four states every panel in this workspace has: loading, failed, empty, and answered.
 *
 * A failure keeps its structured code — `session_not_active` and `runtime_not_running` are ordinary
 * states of a workspace whose editor is not running, so they read as facts rather than as faults.
 */
export function PanelState({
    label,
    isLoading,
    error,
    isEmpty,
    emptyTitle,
    emptyDescription,
    children
}: PanelStateProps) {
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
                />
            </VStack>
        )
    return children
}
