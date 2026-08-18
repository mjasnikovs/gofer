import {Component} from 'react'
import type {ErrorInfo, ReactNode} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {Icon} from '@astryxdesign/core/Icon'
import {VStack} from '@astryxdesign/core/Stack'
import ExclamationTriangleIcon from '@heroicons/react/24/outline/ExclamationTriangleIcon'

type ErrorBoundaryProps = Readonly<{
    children: ReactNode
    /** What stopped working, in the user's terms — a region, not a component name. */
    title: string
    description: string
}>

type ErrorBoundaryState = Readonly<{message?: string | undefined}>

/**
 * Keeps one bad render inside the region it happened in.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so before this existed
 * a single unexpected value — one stream event with a field the timeline did not expect — replaced
 * the entire window with a blank page, with the conversation still safe on disk and no way to reach
 * it. The blast radius is now the region, and the region offers its way back.
 *
 * A class because that is the only thing React lets catch a render error.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    override state: ErrorBoundaryState = {}

    static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
        return {message: error instanceof Error ? error.message : String(error)}
    }

    override componentDidCatch(error: Error, info: ErrorInfo) {
        // The stack says which component threw, and it is the only copy: nothing else in the
        // application sees a render error at all.
        console.error(`${this.props.title}: ${error.message}`, info.componentStack)
    }

    private readonly retry = () => {
        this.setState({message: undefined})
    }

    override render() {
        if (this.state.message === undefined) return this.props.children
        return (
            <VStack
                height='100%'
                padding={6}
                hAlign='center'
                vAlign='center'
            >
                <EmptyState
                    headingLevel={2}
                    icon={
                        <Icon
                            icon={ExclamationTriangleIcon}
                            size='lg'
                        />
                    }
                    title={this.props.title}
                    description={`${this.props.description} ${this.state.message}`}
                    actions={
                        <Button
                            label='Try again'
                            variant='primary'
                            clickAction={this.retry}
                        />
                    }
                />
            </VStack>
        )
    }
}
