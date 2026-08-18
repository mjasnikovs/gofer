import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {HStack, Layout, LayoutContent, LayoutFooter, VStack} from '@astryxdesign/core/Layout'
import {Text} from '@astryxdesign/core/Text'

type UnsavedWorkDialogProps = Readonly<{
    /** The scenes the editor is holding. An empty list is no dialog at all. */
    scenes: readonly string[]
    onSave: () => void
    onDiscard: () => void
    onDismiss: () => void
}>

/** At most this many scenes are listed before the dialog stops being readable. */
const NAMED_SCENES = 6

/**
 * The question a merge has to ask before it stops the Godot editor.
 *
 * Merging moves the project's one checkout, so the editor is stopped first — and stopping it is the
 * editor's own quit, which neither prompts nor saves. A person who had been painting a tilemap lost
 * that work with nothing anywhere saying so, which is the reported defect this answers.
 *
 * Three answers, because two of them are not the same: saving writes every open scene and then
 * merges, merging anyway throws the work away, and cancelling leaves both the editor and the task
 * exactly as they are. Discarding is the destructive one and is labelled as what it does rather than
 * as "no" — it is the only button here that loses anything.
 */
export function UnsavedWorkDialog({scenes, onSave, onDiscard, onDismiss}: UnsavedWorkDialogProps) {
    if (scenes.length === 0) return null
    const listed = scenes.slice(0, NAMED_SCENES)
    const rest = scenes.length - listed.length
    return (
        <Dialog
            isOpen
            purpose='required'
            width={480}
            onOpenChange={isOpen => {
                if (!isOpen) onDismiss()
            }}
        >
            <Layout
                header={
                    <DialogHeader
                        title='Save your Godot work before merging?'
                        subtitle='Merging closes the editor, and the editor does not save on its way out.'
                        onOpenChange={() => {
                            onDismiss()
                        }}
                    />
                }
                content={
                    <LayoutContent>
                        <VStack gap={2}>
                            <Text type='body'>
                                The editor is still holding changes you have not saved:
                            </Text>
                            {listed.map(scene => (
                                <Text
                                    key={scene}
                                    type='code'
                                >
                                    {scene}
                                </Text>
                            ))}
                            {rest > 0 && (
                                <Text type='supporting'>{`and ${String(rest)} more`}</Text>
                            )}
                        </VStack>
                    </LayoutContent>
                }
                footer={
                    <LayoutFooter>
                        <HStack
                            gap={2}
                            hAlign='end'
                        >
                            <Button
                                label='Cancel'
                                variant='secondary'
                                onClick={onDismiss}
                            />
                            <Button
                                label='Merge without saving'
                                variant='destructive'
                                onClick={onDiscard}
                            />
                            <Button
                                label='Save and merge'
                                variant='primary'
                                onClick={onSave}
                            />
                        </HStack>
                    </LayoutFooter>
                }
            />
        </Dialog>
    )
}
