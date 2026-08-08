import {useCallback, useEffect, useRef, useState} from 'react'
import {AppShell} from '@astryxdesign/core/AppShell'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import {isTauri, listen} from '../../services/desktop'
import {initializeRag} from '../../services/settings-store'
import {commandErrorMessage} from '../../utils/command-error'
import type {InitializationState} from '../../models/chat'
import {progressLabel, progressValue} from '../../models/settings'

export function InitializationSplash({onReady}: {onReady: () => void}) {
    const [state, setState] = useState<InitializationState>({status: 'initializing'})
    const hasStarted = useRef(false)

    const initialize = useCallback(async () => {
        setState({status: 'initializing'})

        if (!isTauri()) {
            setState({
                status: 'error',
                message:
                    'Model initialization requires the desktop app. Start Gofer with npm run tauri dev.'
            })
            return
        }

        let unlisten: (() => void) | undefined
        try {
            unlisten = await listen('rag-download-progress', event => {
                setState({status: 'initializing', progress: event.payload})
            })
            await initializeRag()
            setState({status: 'ready'})
            onReady()
        } catch (error) {
            setState({status: 'error', message: commandErrorMessage(error)})
        } finally {
            unlisten?.()
        }
    }, [onReady])

    useEffect(() => {
        if (hasStarted.current) return
        hasStarted.current = true
        void initialize()
    }, [initialize])

    const progress = state.status === 'initializing' ? state.progress : undefined
    const value = progressValue(progress)

    return (
        <AppShell
            contentPadding={6}
            variant='wash'
        >
            <Layout
                height='fill'
                contentWidth={640}
                content={
                    <LayoutContent padding={6}>
                        <VStack
                            height='100%'
                            gap={6}
                            hAlign='stretch'
                            vAlign='center'
                        >
                            {/*
                             * One axis for the screen. Centred, the title and subtitle sat over a
                             * left-aligned banner, paragraph and progress label in the same 592 px
                             * column, so the block read as two screens stacked.
                             */}
                            <VStack
                                gap={3}
                                hAlign='start'
                            >
                                <Icon
                                    icon={CircleStackIcon}
                                    size='lg'
                                    color='accent'
                                />
                                <VStack
                                    gap={1}
                                    hAlign='start'
                                >
                                    <Heading
                                        level={1}
                                        type='display-2'
                                    >
                                        Prepare Gofer
                                    </Heading>
                                    <Text color='secondary'>
                                        Installing the local models used to search the Godot 4.7
                                        documentation.
                                    </Text>
                                </VStack>
                            </VStack>

                            {state.status === 'initializing' ?
                                <VStack gap={4}>
                                    <Banner
                                        status='info'
                                        title='Preparing documentation models'
                                        description='Missing models download automatically. Existing models are reused from the local cache.'
                                    />
                                    {/*
                                     * One indicator for one download. The bar carries its own
                                     * label and its indeterminate state covers the phase before a
                                     * byte count exists, which is what the spinner above it was
                                     * for — two of them side by side read as two things happening.
                                     */}
                                    <ProgressBar
                                        label={progressLabel(progress)}
                                        value={value ?? 0}
                                        isIndeterminate={value === undefined}
                                        hasValueLabel={value !== undefined}
                                    />
                                </VStack>
                            :   null}

                            {state.status === 'error' ?
                                <VStack gap={4}>
                                    <Banner
                                        status='error'
                                        title='Models could not be initialized'
                                        description={state.message}
                                    />
                                    {/*
                                     * A half-written cache fails the same way on every retry, so
                                     * the second button is the one that actually gets the user
                                     * moving: it clears what was downloaded and starts over.
                                     */}
                                    <Text
                                        type='supporting'
                                        color='secondary'
                                    >
                                        Downloads resume where they stopped. If retrying keeps
                                        failing, delete the cache — Settings › Documentation models
                                        › Delete cache — and prepare it again.
                                    </Text>
                                    {/*
                                     * Stretched to the column this was a 592 px slab, four times
                                     * the width of any other button in the application; a button
                                     * that wide stops reading as a button. It sizes to its label
                                     * and sits at the end of the block it belongs to.
                                     */}
                                    <HStack hAlign='end'>
                                        <Button
                                            label='Try again'
                                            variant='primary'
                                            clickAction={initialize}
                                        />
                                    </HStack>
                                </VStack>
                            :   null}
                        </VStack>
                    </LayoutContent>
                }
            />
        </AppShell>
    )
}
