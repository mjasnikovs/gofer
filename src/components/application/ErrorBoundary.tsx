import {Component} from 'react'
import type {ErrorInfo, ReactNode} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {EmptyState} from '@astryxdesign/core/EmptyState'
import {Icon} from '@astryxdesign/core/Icon'
import {VStack} from '@astryxdesign/core/Stack'
import ExclamationTriangleIcon from '@heroicons/react/24/outline/ExclamationTriangleIcon'

type ErrorBoundaryProps = Readonly<{
    children: ReactNode
    title: string
    description: string
}>

type ErrorBoundaryState = Readonly<{message?: string | undefined}>

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    override state: ErrorBoundaryState = {}

    static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
        return {message: error instanceof Error ? error.message : String(error)}
    }

    override componentDidCatch(error: Error, info: ErrorInfo) {
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
