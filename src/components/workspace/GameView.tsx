import {useCallback, useState} from 'react'
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
import type {GodotError, GodotFrame, GodotSessionState} from '../../models/godot'
import type {GodotCall} from '../../models/workspace'
import {PanelState} from './PanelState'

/** The capture is the game's own resolution; the panel is whatever the user dragged it to. */
const CAPTURE_FRAME_STYLE = {maxWidth: '100%', height: 'auto'} as const

type GameViewProps = Readonly<{
    call: GodotCall
    state: GodotSessionState
}>

type Capture = Readonly<{
    frame: GodotFrame
    source: 'game' | 'editor'
    at: number
}>

function asFrame(result: Readonly<Record<string, unknown>>): GodotFrame | undefined {
    const frame = result['frame']
    if (typeof frame !== 'object' || frame === null) return undefined
    const candidate = frame as Partial<GodotFrame>
    return typeof candidate.data === 'string' ? (frame as GodotFrame) : undefined
}

/**
 * The game surface: run, stop, restart, and the last captured frame.
 *
 * It is a snapshot, not a stream. A run and an input both answer with the frame that already shows
 * their effect, so the picture on screen is evidence of the action rather than a later poll that
 * might have missed it.
 */
export function GameView({call, state}: GameViewProps) {
    const [capture, setCapture] = useState<Capture>()
    const [error, setError] = useState<GodotError>()
    const [isBusy, setIsBusy] = useState(false)
    const isOffline = state === 'offline' || state === 'error'

    const run = useCallback(
        (command: string, source: 'game' | 'editor' = 'game') => {
            setIsBusy(true)
            void call(command, source === 'editor' ? {source} : {})
                .then(result => {
                    setError(undefined)
                    const frame = asFrame(result)
                    if (frame) setCapture({frame, source, at: Date.now()})
                    // A stop answers with nothing to show, so the last frame is cleared with it.
                    if (command === 'runtime.stop') setCapture(undefined)
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
                /*
                 * Run keeps its label; the four beside it do not fit one in a panel this narrow.
                 * Each carries its label as its tooltip and its accessible name.
                 */
                endContent={
                    <HStack gap={1}>
                        <Button
                            label='Run'
                            size='sm'
                            isDisabled={isOffline || isBusy}
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
