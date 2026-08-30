import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {HStack} from '@astryxdesign/core/Stack'
import {useEditorSession} from '../../hooks/useEditorSession'
import {useOpenTask} from '../../hooks/useOpenTask'
import type {GodotError} from '../../models/godot'

export const SESSION_OTHER_TASK = 'session_other_task'

function detail(error: GodotError, key: string): string | undefined {
    const value = error.details?.[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function SessionTaskBanner({error}: Readonly<{error: GodotError}>) {
    const {isBusy, start, stop} = useEditorSession()
    const openTask = useOpenTask()
    const taskId = detail(error, 'taskId')

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
