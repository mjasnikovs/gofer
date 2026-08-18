import {useEffect, useState} from 'react'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {SelectableCard} from '@astryxdesign/core/SelectableCard'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'

import type {PendingChange} from '../../models/app'
import {listPendingChanges} from '../../services/task-actions'

type NewTaskDialogProps = Readonly<{
    isOpen: boolean
    onOpenChange: (isOpen: boolean) => void
    /** Runs the four phases against the ask. Refused while the ask is empty. */
    onPlan: (prompt: string, bringChanges: boolean) => void
    /** Makes the task and opens its empty chat, with whatever was typed waiting in the composer. */
    onSkip: (prompt: string, bringChanges: boolean) => void
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
 * Asks what the new task is, and plans it unless the user says not to.
 *
 * This dialog IS the plan. Planning is the default because it is the thing the user cannot do from
 * the chat — the four phases have to run against the ask before there is a first turn, so the ask
 * has to be taken before there is a chat to type it into.
 *
 * Skipping is the other half, and it is a way out rather than a second mode: it makes the task,
 * opens its empty chat, and leaves the user in front of the composer they already know. Anything
 * typed here goes with them as a draft, unsent — a plan the user changed their mind about must not
 * cost them the sentence they wrote.
 */
export function NewTaskDialog({isOpen, onOpenChange, onPlan, onSkip}: NewTaskDialogProps) {
    const [prompt, setPrompt] = useState('')
    const [changes, setChanges] = useState<readonly PendingChange[]>([])
    const [bring, setBring] = useState(false)
    const ask = prompt.trim()

    // Read once per open. The dialog is mounted only while it is open, so this is that moment.
    useEffect(() => {
        let isCurrent = true
        void listPendingChanges().then(pending => {
            if (!isCurrent || pending.length === 0) return
            setChanges(pending)
            // Files Git has never seen are the user's own copy-in, and the answer is always to keep
            // them. Anything modified could be the closing task's work, so that one is asked cold.
            setBring(pending.every(change => change.isNew))
        })
        return () => {
            isCurrent = false
        }
    }, [])

    const close = () => {
        setPrompt('')
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
            <DialogHeader
                title='New task'
                subtitle='Each task gets its own branch.'
            />
            <VStack
                gap={4}
                padding={4}
            >
                <VStack gap={2}>
                    <TextArea
                        label='What needs doing?'
                        rows={3}
                        value={prompt}
                        hasAutoFocus
                        onChange={setPrompt}
                    />
                    {/*
                     * What planning costs and what it buys, in that order. It is several minutes of
                     * local model time before the first turn, and the user is one keystroke from
                     * spending them — so the price is said before the benefit is.
                     */}
                    <Text
                        size='sm'
                        color='secondary'
                    >
                        Planning takes several minutes. It reads the project, asks you what it
                        cannot settle, and writes a specification the agent works from. Worth it for
                        anything you would have to explain twice.
                    </Text>
                </VStack>
                {changes.length > 0 && (
                    <VStack gap={2}>
                        <Text weight='medium'>
                            {changes.length === 1 ?
                                '1 file is not committed yet'
                            :   `${String(changes.length)} files are not committed yet`}
                        </Text>
                        <VStack gap={0}>
                            {changes.slice(0, NAMED_CHANGES).map(change => (
                                <Text
                                    key={change.path}
                                    size='sm'
                                    color='secondary'
                                >
                                    {change.path}
                                </Text>
                            ))}
                            {changes.length > NAMED_CHANGES && (
                                <Text
                                    size='sm'
                                    color='secondary'
                                >
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
                                    <Text weight='medium'>{choice.title}</Text>
                                    <Text
                                        size='sm'
                                        color='secondary'
                                    >
                                        {choice.detail}
                                    </Text>
                                </VStack>
                            </SelectableCard>
                        ))}
                    </VStack>
                )}
                {/*
                 * The way out sits at the far end from the thing it is a way out of. A spacer rather
                 * than a nested stack, which is what Astryx asks for.
                 */}
                <HStack
                    gap={2}
                    vAlign='center'
                >
                    <Button
                        label='Skip planning'
                        variant='secondary'
                        onClick={() => {
                            onSkip(ask, bring)
                            close()
                        }}
                    />
                    <StackItem size='fill' />
                    <Button
                        label='Cancel'
                        variant='ghost'
                        onClick={close}
                    />
                    <Button
                        label='Plan it'
                        variant='primary'
                        isDisabled={ask.length === 0}
                        onClick={() => {
                            if (ask.length === 0) return
                            onPlan(ask, bring)
                            close()
                        }}
                    />
                </HStack>
            </VStack>
        </Dialog>
    )
}
