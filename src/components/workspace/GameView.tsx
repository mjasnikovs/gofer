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
import {useEditorSession} from '../../hooks/useEditorSession'
import {isSessionOffline, isSessionPlaying} from '../../models/godot'
import type {GodotError, GodotFrame} from '../../models/godot'
import {PanelState} from './PanelState'

/** The capture is the game's own resolution; the panel is whatever the user dragged it to. */
const CAPTURE_FRAME_STYLE = {maxWidth: '100%', height: 'auto'} as const

type Capture = Readonly<{
    frame: GodotFrame
    source: 'game' | 'editor'
    at: number
}>

/** The four controls this panel offers, named as the commands they send. */
type GameControl = 'runtime.run' | 'runtime.restart' | 'runtime.stop' | 'runtime.capture'

/** The commands that end the game the panel is showing, and so end its picture straight away. */
const REPLACES_THE_GAME: ReadonlySet<GameControl> = new Set<GameControl>([
    'runtime.run',
    'runtime.restart',
    'runtime.stop'
])

function asFrame(frame: GodotFrame | undefined): GodotFrame | undefined {
    return frame && typeof frame.data === 'string' ? frame : undefined
}

/**
 * The game surface: run, stop, restart, and the last captured frame.
 *
 * It is a snapshot, not a stream. A run and an input both answer with the frame that already shows
 * their effect, so the picture on screen is evidence of the action rather than a later poll that
 * might have missed it.
 */
export function GameView() {
    const {call, state} = useEditorSession()
    const [taken, setTaken] = useState<Capture>()
    const [error, setError] = useState<GodotError>()
    const [isBusy, setIsBusy] = useState(false)
    const isOffline = isSessionOffline(state)
    const isPlaying = isSessionPlaying(state)

    const run = useCallback(
        (command: GameControl, source: 'game' | 'editor' = 'game') => {
            setIsBusy(true)
            // The old picture goes down with the game it was of, at the moment that game is asked
            // to end — not when its replacement arrives, which is a second later and a whole
            // restart away.
            if (REPLACES_THE_GAME.has(command)) setTaken(undefined)
            // Only a capture takes a source; the other three answer about the game either way.
            void call(command === 'runtime.capture' ? 'runtime.capture' : command, {
                ...(command === 'runtime.capture' && source === 'editor' && {source})
            })
                .then(result => {
                    setError(undefined)
                    // A stop answers about the game, not with a picture of it, so it carries no
                    // frame at all — which the map now says, rather than leaving it to be read for.
                    const frame = 'frame' in result ? asFrame(result.frame) : undefined
                    if (frame) setTaken({frame, source, at: Date.now()})
                    // A stop answers with nothing to show, so the last frame is cleared with it.
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

    /*
     * A frame of the game is evidence of that game, and it is shown for exactly as long as that
     * game is the one running. A game that ended — stopped, restarted, crashed — left its last
     * picture on screen beside controls describing a game that no longer exists.
     *
     * The editor is what says whether a game is running, so that is what retires the picture. It
     * used to be a counter the workspace bumps, tagged onto the frame when the command was sent —
     * but pressing Run moves that counter, and the move and the answer race, so the run's own
     * first frame was retired by the run it is a picture of and the panel read "No frame captured"
     * over a game that was playing.
     *
     * A capture of the editor viewport is not of a game at all, so nothing retires it.
     */
    const capture = taken?.source === 'game' && !isPlaying ? undefined : taken

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
                            // A second run of a game that is already running can only answer
                            // `already_running`, which is an error the user provoked by pressing a
                            // control the panel was offering. Restart beside it is the action they
                            // wanted.
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
