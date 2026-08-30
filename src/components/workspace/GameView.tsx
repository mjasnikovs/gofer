import {useCallback, useEffect, useRef, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Icon} from '@astryxdesign/core/Icon'
import ArrowPathIcon from '@heroicons/react/24/outline/ArrowPathIcon'
import CameraIcon from '@heroicons/react/24/outline/CameraIcon'
import StopIcon from '@heroicons/react/24/outline/StopIcon'
import ViewfinderCircleIcon from '@heroicons/react/24/outline/ViewfinderCircleIcon'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {Toolbar} from '@astryxdesign/core/Toolbar'
import {toGodotError} from '../../services/godot-session'
import {useEditorSession} from '../../hooks/useEditorSession'
import {isSessionOffline, isSessionPlaying} from '../../models/godot'
import type {GodotError, GodotFrame} from '../../models/godot'
import {PanelState} from './PanelState'

const CAPTURE_FRAME_STYLE = {maxWidth: '100%', height: 'auto'} as const

type Capture = Readonly<{
    frame: GodotFrame
    source: 'game' | 'editor'
    at: number
    sessionId: string | undefined
}>

type GameControl = 'runtime.run' | 'runtime.restart' | 'runtime.stop' | 'runtime.capture'

const REPLACES_THE_GAME: ReadonlySet<GameControl> = new Set<GameControl>([
    'runtime.run',
    'runtime.restart',
    'runtime.stop'
])

function asFrame(frame: GodotFrame | undefined): GodotFrame | undefined {
    return frame && typeof frame.data === 'string' ? frame : undefined
}

export function GameView() {
    const {call, session, state} = useEditorSession()
    const [taken, setTaken] = useState<Capture>()
    const [error, setError] = useState<GodotError>()
    const [isBusy, setIsBusy] = useState(false)
    const isOffline = isSessionOffline(state)
    const isPlaying = isSessionPlaying(state)

    const live = useRef(session?.sessionId)

    useEffect(() => {
        live.current = session?.sessionId
    }, [session?.sessionId])

    const run = useCallback(
        (command: GameControl, source: 'game' | 'editor' = 'game') => {
            const stamp = live.current
            setIsBusy(true)
            if (REPLACES_THE_GAME.has(command)) setTaken(undefined)
            void call(command === 'runtime.capture' ? 'runtime.capture' : command, {
                ...(command === 'runtime.capture' && source === 'editor' && {source})
            })
                .then(result => {
                    setError(undefined)
                    const frame = 'frame' in result ? asFrame(result.frame) : undefined
                    if (frame) setTaken({frame, source, at: Date.now(), sessionId: stamp})
                    if (command === 'runtime.stop') setTaken(undefined)
                })
                .catch((failure: unknown) => {
                    setError(toGodotError(failure))
                })
                .finally(() => {
                    setIsBusy(false)
                })
        },
        [call]
    )

    const capture =
        (
            taken === undefined
            || (taken.source === 'game' ? !isPlaying : taken.sessionId !== session?.sessionId)
        ) ?
            undefined
        :   taken

    return (
        <VStack
            gap={0}
            height='100%'
        >
            <Toolbar
                label='Game controls'
                size='sm'
                dividers={['bottom']}
                startContent={
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        {capture ?
                            `${capture.source === 'editor' ? 'Editor' : 'Game'} · ${String(capture.frame.width)}×${String(capture.frame.height)}`
                        :   'No frame captured'}
                    </Text>
                }
                endContent={
                    <HStack gap={1}>
                        <Button
                            label='Run'
                            size='sm'
                            isDisabled={isOffline || isBusy || isPlaying}
                            clickAction={() => {
                                run('runtime.run')
                            }}
                        />
                        <Button
                            label='Restart'
                            size='sm'
                            variant='ghost'
                            isIconOnly
                            icon={<Icon icon={ArrowPathIcon} />}
                            tooltip='Restart'
                            isDisabled={isOffline || isBusy}
                            clickAction={() => {
                                run('runtime.restart')
                            }}
                        />
                        <Button
                            label='Stop'
                            size='sm'
                            variant='ghost'
                            isIconOnly
                            icon={<Icon icon={StopIcon} />}
                            tooltip='Stop'
                            isDisabled={isOffline || isBusy}
                            clickAction={() => {
                                run('runtime.stop')
                            }}
                        />
                        <Button
                            label='Capture game'
                            size='sm'
                            variant='ghost'
                            isIconOnly
                            icon={<Icon icon={CameraIcon} />}
                            tooltip='Capture game'
                            isDisabled={isOffline || isBusy}
                            clickAction={() => {
                                run('runtime.capture')
                            }}
                        />
                        <Button
                            label='Capture editor'
                            size='sm'
                            variant='ghost'
                            isIconOnly
                            icon={<Icon icon={ViewfinderCircleIcon} />}
                            tooltip='Capture editor'
                            isDisabled={isOffline || isBusy}
                            clickAction={() => {
                                run('runtime.capture', 'editor')
                            }}
                        />
                    </HStack>
                }
            />
            <StackItem
                size='fill'
                isScrollable
            >
                <PanelState
                    label='game frame'
                    isLoading={isBusy && !capture}
                    error={error}
                    isEmpty={!capture}
                    emptyTitle='No frame yet'
                    emptyDescription='Run the game, or capture the editor viewport, to see it here.'
                >
                    {capture ?
                        <VStack padding={3}>
                            <img
                                src={`data:image/png;base64,${capture.frame.data}`}
                                alt={`The ${capture.source === 'editor' ? 'editor viewport' : 'running game'}, captured at ${new Date(capture.at).toLocaleTimeString()}`}
                                width={capture.frame.width}
                                height={capture.frame.height}
                                style={CAPTURE_FRAME_STYLE}
                            />
                        </VStack>
                    :   null}
                </PanelState>
            </StackItem>
        </VStack>
    )
}
