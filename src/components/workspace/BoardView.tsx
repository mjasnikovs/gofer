import {useCallback, useEffect, useState} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Divider} from '@astryxdesign/core/Divider'
import {Item} from '@astryxdesign/core/Item'
import {Selector} from '@astryxdesign/core/Selector'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Token} from '@astryxdesign/core/Token'
import {
    commentOnCard,
    createCard,
    editCard,
    listCards,
    moveCard,
    postCardToGofer,
    readCard,
    toBoardError,
    watchBoard
} from '../../services/board'
import {listPendingChanges} from '../../services/task-actions'
import {CARD_STATUSES, CARD_STATUS_LABELS, cardsIn} from '../../models/board'
import type {Card, CardDetail, CardStatus} from '../../models/board'
import type {CommandError} from '../../models/errors'
import type {PendingChange} from '../../models/app'
import {useOpenTask} from '../../hooks/useOpenTask'
import {NewTaskDialog} from './NewTaskDialog'
import {PanelState} from './PanelState'

const STATUS_OPTIONS = CARD_STATUSES.map(status => ({
    value: status,
    label: CARD_STATUS_LABELS[status]
}))

function whoAndWhen(card: Card): string {
    const comments =
        card.commentCount === 0 ?
            ''
        :   ` · ${String(card.commentCount)} comment${card.commentCount === 1 ? '' : 's'}`
    return `${card.owner}${comments}`
}

export function BoardView() {
    const [cards, setCards] = useState<readonly Card[]>()
    const [error, setError] = useState<CommandError>()
    const [isLoading, setIsLoading] = useState(true)
    const [reads, setReads] = useState(0)
    const [openId, setOpenId] = useState<string>()
    const [isAdding, setIsAdding] = useState(false)

    const refresh = useCallback(() => {
        setReads(count => count + 1)
    }, [])

    useEffect(() => {
        let cancelled = false
        void listCards()
            .then(rows => {
                if (cancelled) return
                setCards(rows)
                setError(undefined)
            })
            .catch((failure: unknown) => {
                if (cancelled) return
                setError(toBoardError(failure))
                setCards(undefined)
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [reads])

    useEffect(() => {
        let stop: (() => void) | undefined
        let cancelled = false
        void watchBoard(refresh).then(unlisten => {
            if (cancelled) unlisten()
            else stop = unlisten
        })
        return () => {
            cancelled = true
            stop?.()
        }
    }, [refresh])

    const all = cards ?? []

    return (
        <VStack
            gap={0}
            height='100%'
        >
            <HStack
                gap={3}
                padding={3}
                align='center'
            >
                <StackItem size='fill'>
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        What is asked, what is being done, and what was reviewed. Other agents write
                        here too.
                    </Text>
                </StackItem>
                <Button
                    label='New card'
                    size='sm'
                    clickAction={() => {
                        setIsAdding(true)
                    }}
                />
            </HStack>
            <Divider />
            <StackItem
                size='fill'
                isScrollable
            >
                <PanelState
                    label='board'
                    isLoading={isLoading}
                    error={error}
                    isEmpty={false}
                    emptyTitle='Nothing on the board'
                >
                    <HStack
                        gap={0}
                        height='100%'
                        align='stretch'
                    >
                        {CARD_STATUSES.map(status => (
                            <Column
                                key={status}
                                status={status}
                                cards={cardsIn(all, status)}
                                onOpen={setOpenId}
                            />
                        ))}
                    </HStack>
                </PanelState>
            </StackItem>
            {openId !== undefined && (
                <CardDialog
                    id={openId}
                    version={reads}
                    onClose={() => {
                        setOpenId(undefined)
                    }}
                    onChanged={refresh}
                />
            )}
            {isAdding && (
                <NewCardDialog
                    onClose={() => {
                        setIsAdding(false)
                    }}
                    onCreated={refresh}
                />
            )}
        </VStack>
    )
}

type ColumnProps = Readonly<{
    status: CardStatus
    cards: readonly Card[]
    onOpen: (id: string) => void
}>

function Column({status, cards, onOpen}: ColumnProps) {
    return (
        <StackItem size='fill'>
            <VStack
                gap={0}
                height='100%'
            >
                <HStack
                    gap={2}
                    padding={2}
                    align='center'
                >
                    <StackItem size='fill'>
                        <Text type='label'>{CARD_STATUS_LABELS[status]}</Text>
                    </StackItem>
                    <Badge label={cards.length} />
                </HStack>
                <Divider />
                <StackItem
                    size='fill'
                    isScrollable
                >
                    <VStack gap={0}>
                        {cards.map(card => (
                            <Item
                                key={card.id}
                                label={card.title}
                                labelLines={2}
                                description={whoAndWhen(card)}
                                density='compact'
                                align='start'
                                {...(card.taskId !== null && {
                                    endContent: (
                                        <Token
                                            size='sm'
                                            label='task'
                                        />
                                    )
                                })}
                                onClick={() => {
                                    onOpen(card.id)
                                }}
                            />
                        ))}
                    </VStack>
                </StackItem>
            </VStack>
            <Divider orientation='vertical' />
        </StackItem>
    )
}

type NewCardDialogProps = Readonly<{
    onClose: () => void
    onCreated: () => void
}>

function NewCardDialog({onClose, onCreated}: NewCardDialogProps) {
    const [title, setTitle] = useState('')
    const [body, setBody] = useState('')
    const [failure, setFailure] = useState<string>()
    const [isSaving, setIsSaving] = useState(false)

    const add = async () => {
        setIsSaving(true)
        try {
            await createCard(title, body, 'backlog')
            onCreated()
            onClose()
        } catch (error) {
            setFailure(toBoardError(error).message)
        } finally {
            setIsSaving(false)
        }
    }

    return (
        <Dialog
            isOpen
            purpose='form'
            width={520}
            onOpenChange={isOpen => {
                if (!isOpen) onClose()
            }}
        >
            <DialogHeader
                title='New card'
                onOpenChange={isOpen => {
                    if (!isOpen) onClose()
                }}
            />
            <VStack
                gap={4}
                padding={4}
            >
                {failure !== undefined && (
                    <Banner
                        status='error'
                        title='The card was not added'
                        description={failure}
                    />
                )}
                <TextInput
                    label='Title'
                    value={title}
                    isRequired
                    hasAutoFocus
                    onChange={setTitle}
                />
                <TextArea
                    label='What to do'
                    value={body}
                    rows={5}
                    isOptional
                    onChange={setBody}
                />
                <HStack
                    gap={3}
                    hAlign='end'
                >
                    <Button
                        label='Cancel'
                        variant='ghost'
                        clickAction={onClose}
                    />
                    <Button
                        label='Add card'
                        variant='primary'
                        isLoading={isSaving}
                        isDisabled={title.trim() === ''}
                        clickAction={add}
                    />
                </HStack>
            </VStack>
        </Dialog>
    )
}

type CardDialogProps = Readonly<{
    id: string
    /** Bumped by the board whenever anything changed, so an open card hears about it too. */
    version: number
    onClose: () => void
    onChanged: () => void
}>

function CardDialog({id, version, onClose, onChanged}: CardDialogProps) {
    const openTask = useOpenTask()
    const [detail, setDetail] = useState<CardDetail>()
    const [failure, setFailure] = useState<string>()
    const [title, setTitle] = useState('')
    const [body, setBody] = useState('')
    const [comment, setComment] = useState('')
    const [isBusy, setIsBusy] = useState(false)
    const [pending, setPending] = useState<readonly PendingChange[]>()
    // The text fields are seeded from the card once per opening. A re-read after a comment or a
    // move must not overwrite what the user is halfway through typing.
    const [seededFor, setSeededFor] = useState<string>()

    useEffect(() => {
        let cancelled = false
        void readCard(id)
            .then(read => {
                if (cancelled) return
                setDetail(read)
                if (seededFor === id) return
                setSeededFor(id)
                setTitle(read.card.title)
                setBody(read.card.body)
            })
            .catch((error: unknown) => {
                if (!cancelled) setFailure(toBoardError(error).message)
            })
        return () => {
            cancelled = true
        }
    }, [id, version, seededFor])

    const act = async (work: () => Promise<unknown>) => {
        setIsBusy(true)
        setFailure(undefined)
        try {
            await work()
            onChanged()
        } catch (error) {
            setFailure(toBoardError(error).message)
        } finally {
            setIsBusy(false)
        }
    }

    const post = async (bringChanges: boolean) => {
        setPending(undefined)
        setIsBusy(true)
        setFailure(undefined)
        try {
            const chat = await postCardToGofer(id, bringChanges)
            onChanged()
            onClose()
            if (chat.taskId !== undefined && openTask) openTask(chat.taskId)
        } catch (error) {
            setFailure(toBoardError(error).message)
        } finally {
            setIsBusy(false)
        }
    }

    const offerToPost = async () => {
        const changes = await listPendingChanges()
        if (changes.length === 0) {
            await post(false)
            return
        }
        setPending(changes)
    }

    const card = detail?.card
    const isDone = card?.status === 'done'
    const isEdited = card !== undefined && (title !== card.title || body !== card.body)
    const canPost = card?.taskId === null && !isDone

    return (
        <Dialog
            isOpen
            purpose='form'
            width={640}
            maxHeight='85vh'
            onOpenChange={isOpen => {
                if (!isOpen) onClose()
            }}
        >
            <DialogHeader
                title={card?.title ?? 'Card'}
                {...(card && {subtitle: `${CARD_STATUS_LABELS[card.status]} · ${card.owner}`})}
                onOpenChange={isOpen => {
                    if (!isOpen) onClose()
                }}
            />
            <VStack
                gap={4}
                padding={4}
            >
                {failure !== undefined && (
                    <Banner
                        status='error'
                        title='That did not go through'
                        description={failure}
                    />
                )}
                {detail === undefined || card === undefined ?
                    <Text
                        type='supporting'
                        color='secondary'
                    >
                        Opening the card…
                    </Text>
                :   <>
                        <HStack
                            gap={3}
                            align='end'
                        >
                            <StackItem size='fill'>
                                <Selector
                                    label='Column'
                                    value={card.status}
                                    options={STATUS_OPTIONS}
                                    isDisabled={isBusy}
                                    onChange={status => {
                                        void act(() => moveCard(id, status as CardStatus))
                                    }}
                                />
                            </StackItem>
                            {card.taskId !== null && openTask && (
                                <OpenTaskButton
                                    taskId={card.taskId}
                                    onOpen={taskId => {
                                        onClose()
                                        openTask(taskId)
                                    }}
                                />
                            )}
                        </HStack>
                        <TextInput
                            label='Title'
                            value={title}
                            isReadOnly={isDone}
                            onChange={setTitle}
                        />
                        <TextArea
                            label='What to do'
                            value={body}
                            rows={6}
                            isReadOnly={isDone}
                            onChange={setBody}
                        />
                        {isEdited && !isDone && (
                            <HStack
                                gap={3}
                                hAlign='end'
                            >
                                <Button
                                    label='Save changes'
                                    variant='secondary'
                                    isLoading={isBusy}
                                    clickAction={() => {
                                        void act(() => editCard(id, {title, body}))
                                    }}
                                />
                            </HStack>
                        )}
                        <Divider />
                        <VStack gap={2}>
                            <Text type='label'>Comments</Text>
                            {detail.comments.length === 0 && (
                                <Text
                                    type='supporting'
                                    color='secondary'
                                >
                                    Nobody has said anything yet.
                                </Text>
                            )}
                            {detail.comments.map(one => (
                                <Item
                                    key={one.id}
                                    label={one.body}
                                    labelLines={8}
                                    description={`${one.author} · ${new Date(one.createdAt).toLocaleString()}`}
                                    density='compact'
                                    align='start'
                                />
                            ))}
                            {!isDone && (
                                <>
                                    <TextArea
                                        label='Add a comment'
                                        value={comment}
                                        rows={2}
                                        onChange={setComment}
                                    />
                                    <HStack
                                        gap={3}
                                        hAlign='end'
                                    >
                                        <Button
                                            label='Comment'
                                            variant='secondary'
                                            isLoading={isBusy}
                                            isDisabled={comment.trim() === ''}
                                            clickAction={() => {
                                                void act(async () => {
                                                    await commentOnCard(id, comment)
                                                    setComment('')
                                                })
                                            }}
                                        />
                                    </HStack>
                                </>
                            )}
                        </VStack>
                        {canPost && (
                            <>
                                <Divider />
                                <HStack
                                    gap={3}
                                    align='center'
                                >
                                    <StackItem size='fill'>
                                        <Text
                                            type='supporting'
                                            color='secondary'
                                        >
                                            Opens a task for this card with the ask already typed
                                            in. Merging that task finishes the card.
                                        </Text>
                                    </StackItem>
                                    <Button
                                        label='Post to Gofer'
                                        variant='primary'
                                        isLoading={isBusy}
                                        clickAction={offerToPost}
                                    />
                                </HStack>
                            </>
                        )}
                    </>
                }
            </VStack>
            {pending !== undefined && (
                <NewTaskDialog
                    isOpen
                    changes={pending}
                    onOpenChange={isOpen => {
                        if (!isOpen) setPending(undefined)
                    }}
                    onCreate={bringChanges => {
                        void post(bringChanges)
                    }}
                />
            )}
        </Dialog>
    )
}

type OpenTaskButtonProps = Readonly<{
    taskId: string
    onOpen: (taskId: string) => void
}>

function OpenTaskButton({taskId, onOpen}: OpenTaskButtonProps) {
    return (
        <Button
            label='Open task'
            variant='secondary'
            clickAction={() => {
                onOpen(taskId)
            }}
        />
    )
}
