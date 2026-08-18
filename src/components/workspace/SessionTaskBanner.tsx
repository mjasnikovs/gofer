import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/Stack'
import {useEditorSession} from '../../hooks/useEditorSession'
import {useOpenTask} from '../../hooks/useOpenTask'
import type {GodotError} from '../../models/godot'

/** The refusal this banner is the way out of. Rust names the task it refuses on behalf of. */
export const SESSION_OTHER_TASK = 'session_other_task'

/** One named string out of a failure's details, or nothing if the backend did not send it. */
function detail(error: GodotError, key: string): string | undefined {
    const value = error.details?.[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The way out of a panel that is reading an editor belonging to a different task.
 *
 * The refusal used to be shown as the sentence it is, and a sentence is not something a stuck user
 * can press. Both of the ways out it describes are here as controls: go to the task that owns the
 * editor, or take the editor. Neither is hidden behind knowing which task that was — Rust names it,
 * and the two buttons are the two halves of what it says to do.
 *
 * A warning rather than an error: nothing is broken, the editor is simply somewhere else.
 */
export function SessionTaskBanner({error}: Readonly<{error: GodotError}>) {
    const {isBusy, start, stop} = useEditorSession()
    const openTask = useOpenTask()
    const taskId = detail(error, 'taskId')

    /*
     * Stopping and starting is one press because it is one intention. Offering them separately
     * means a user who pressed Stop is left on a workspace that is now merely offline, with the
     * session they wanted still not running and nothing saying that a second press is what they
     * are missing. Neither call throws; both report through the frame's own banner.
     */
    const moveEditorHere = async () => {
        await stop()
        await start()
    }

    return (
        <Banner
            container='section'
            status='warning'
            title='The editor is open in another task'
            description={error.message}
            endContent={
                <HStack gap={2}>
                    {taskId && openTask && (
                        <Button
                            label='Open that task'
                            isDisabled={isBusy}
                            onClick={() => {
                                openTask(taskId)
                            }}
                        />
                    )}
                    <Button
                        variant='primary'
                        label='Move the editor here'
                        tooltip='Stops the other task’s editor and starts one for this task.'
                        isDisabled={isBusy}
                        clickAction={moveEditorHere}
                    />
                </HStack>
            }
        />
    )
}
