import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Heading} from '@astryxdesign/core/Text'
import {SelectableCard} from '@astryxdesign/core/SelectableCard'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {HStack, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {useState} from 'react'

import type {PendingChange} from '../../models/app'

type NewTaskDialogProps = Readonly<{
    isOpen: boolean
    onOpenChange: (isOpen: boolean) => void
    changes: readonly PendingChange[]
    onCreate: (bringChanges: boolean) => void
}>

const NAMED_CHANGES = 5

const CHANGE_CHOICES: readonly {
    bring: boolean
    title: string
    detail: string
}[] = [
    {
        bring: true,
        title: 'Bring them into the new task',
        detail: 'The files stay on disk. The new task commits them as its own work.'
    },
    {
        bring: false,
        title: 'Leave them on the current task',
        detail: 'Committed to the task you are closing, and taken off disk with it.'
    }
]

export function NewTaskDialog({isOpen, onOpenChange, changes, onCreate}: NewTaskDialogProps) {
    const [bring, setBring] = useState(() => changes.every(change => change.isNew))

    const close = () => {
        onOpenChange(false)
    }

    return (
        <Dialog
            isOpen={isOpen}
            purpose='form'
            width={560}
            onOpenChange={next => {
                if (!next) close()
            }}
        >
            <Layout
                header={
                    <DialogHeader
                        title='New task'
                        subtitle='Each task gets its own branch.'
                        onOpenChange={close}
                    />
                }
                content={
                    <LayoutContent>
                        <VStack gap={2}>
                            <Text type='label'>
                                {changes.length === 1 ?
                                    '1 file is not committed yet'
                                :   `${String(changes.length)} files are not committed yet`}
                            </Text>
                            <VStack gap={0}>
                                {changes.slice(0, NAMED_CHANGES).map(change => (
                                    <Text
                                        type='supporting'
                                        key={change.path}
                                    >
                                        {change.path}
                                    </Text>
                                ))}
                                {changes.length > NAMED_CHANGES && (
                                    <Text type='supporting'>
                                        and {String(changes.length - NAMED_CHANGES)} more
                                    </Text>
                                )}
                            </VStack>
                            {CHANGE_CHOICES.map(choice => (
                                <SelectableCard
                                    key={choice.title}
                                    label={choice.title}
                                    padding={3}
                                    isSelected={bring === choice.bring}
                                    onChange={() => {
                                        setBring(choice.bring)
                                    }}
                                >
                                    <VStack gap={1}>
                                        <Heading level={4}>{choice.title}</Heading>
                                        <Text type='supporting'>{choice.detail}</Text>
                                    </VStack>
                                </SelectableCard>
                            ))}
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
                                variant='ghost'
                                onClick={close}
                            />
                            <Button
                                label='Create task'
                                variant='primary'
                                onClick={() => {
                                    onCreate(bring)
                                    close()
                                }}
                            />
                        </HStack>
                    </LayoutFooter>
                }
            />
        </Dialog>
    )
}
