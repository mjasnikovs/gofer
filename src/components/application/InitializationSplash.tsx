import {useCallback, useEffect, useRef, useState} from 'react'
import {AppShell} from '@astryxdesign/core/AppShell'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Icon} from '@astryxdesign/core/Icon'
import {Layout, LayoutContent} from '@astryxdesign/core/Layout'
import {ProgressBar} from '@astryxdesign/core/ProgressBar'
import {Spinner} from '@astryxdesign/core/Spinner'
import {VStack} from '@astryxdesign/core/Stack'
import {Heading, Text} from '@astryxdesign/core/Text'
import CircleStackIcon from '@heroicons/react/24/outline/CircleStackIcon'
import {invoke, isTauri} from '@tauri-apps/api/core'
import {listen} from '@tauri-apps/api/event'
import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
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
            unlisten = await listen<DownloadProgress>('rag-download-progress', event => {
                setState({status: 'initializing', progress: event.payload})
            })
            await invoke('initialize_rag')
            setState({status: 'ready'})
            onReady()
        } catch (error) {
            setState({status: 'error', message: String(error)})
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
                            <VStack
                                gap={3}
                                hAlign='center'
                            >
                                <Icon
                                    icon={CircleStackIcon}
                                    size='lg'
                                    color='accent'
                                />
                                <VStack
                                    gap={1}
                                    hAlign='center'
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
                                    <Spinner
                                        size='lg'
                                        label='Initializing documentation search'
                                    />
                                    <ProgressBar
                                        label={progressLabel(progress)}
                                        value={value ?? 0}
                                        isIndeterminate={value === undefined}
                                        hasValueLabel={value !== undefined}
                                    />
                                    <Text
                                        type='supporting'
                                        color='secondary'
                                    >
                                        {progressLabel(progress)}
                                    </Text>
                                </VStack>
                            :   null}

                            {state.status === 'error' ?
                                <VStack gap={4}>
                                    <Banner
                                        status='error'
                                        title='Models could not be initialized'
                                        description={state.message}
                                    />
                                    <Button
                                        label='Try again'
                                        variant='primary'
                                        width='100%'
                                        clickAction={initialize}
                                    />
                                </VStack>
                            :   null}
                        </VStack>
                    </LayoutContent>
                }
            />
        </AppShell>
    )
}
