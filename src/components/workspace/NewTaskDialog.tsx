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
    /** The files loose in the checkout. Never empty — with none, nothing opens this dialog. */
    changes: readonly PendingChange[]
    /** Makes the task and opens its empty chat. */
    onCreate: (bringChanges: boolean) => void
}>

/** How many loose files are named before the rest are counted. */
const NAMED_CHANGES = 5

/**
 * What each answer does to the files loose in the checkout.
 *
 * The question exists because the answer is destructive-looking either way, and the user is the only
 * one who knows which. Files an agent left are the task being closed. Files the user copied in by
 * hand belong to whatever they are about to ask for, and used to vanish off disk without a word.
 */
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

/**
 * Asks the one question making a task cannot answer for itself.
 *
 * It does not ask what the task is. There is exactly one place in Gofer to write what you want, and
 * it is the composer — the task opens on it, and planning is a control beside its Send button rather
 * than a mode chosen before the chat exists. A second box here was a second box to wonder about, and
 * it could hold neither an image nor a file mention.
 *
 * So this is only the loose-files question, and it is only shown when there are loose files. With a
 * clean checkout there is nothing to ask and New task makes one on the spot.
 */
export function NewTaskDialog({isOpen, onOpenChange, changes, onCreate}: NewTaskDialogProps) {
    // Files Git has never seen are the user's own copy-in, and the answer is always to keep them.
    // Anything modified could be the closing task's work, so that one is asked cold.
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
            {/*
             * The same frame `UnsavedWorkDialog` uses: header, content, footer. Flat, the actions
             * sat in the body with none of the footer's treatment, and the header drew no close
             * button at all because it was never given the handler that makes one.
             */}
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
