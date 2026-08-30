import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'

type UnsavedWorkDialogProps = Readonly<{
    scenes: readonly string[]
    onSave: () => void
    onDiscard: () => void
    onDismiss: () => void
}>

const NAMED_SCENES = 6

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
