import {useCallback, useEffect, useRef, useState} from 'react'
import type {KeyboardEvent, ReactNode} from 'react'
import {Badge} from '@astryxdesign/core/Badge'
import {Banner} from '@astryxdesign/core/Banner'
import {Button} from '@astryxdesign/core/Button'
import {ChatComposer, ChatComposerDrawer} from '@astryxdesign/core/Chat'
import type {ChatComposerInputHandle} from '@astryxdesign/core/Chat'
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog'
import {Divider} from '@astryxdesign/core/Divider'
import {Item} from '@astryxdesign/core/Item'
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout'
import {Selector} from '@astryxdesign/core/Selector'
import {HStack, StackItem, VStack} from '@astryxdesign/core/Stack'
import {Text} from '@astryxdesign/core/Text'
import {TextArea} from '@astryxdesign/core/TextArea'
import {TextInput} from '@astryxdesign/core/TextInput'
import {Token} from '@astryxdesign/core/Token'
import {AttachmentPicker, AttachmentThumbnails, GameCapturePicker} from './AttachmentControls'
import {TextField} from '../TextField'
import {clipboardItemImages, imageFiles} from '../../utils/chat-images'
import {
    commentOnCard,
    createCard,
    deleteCard,
    editCard,
    listCards,
    moveCard,
    postCardToGofer,
    readCard,
    storeCardAttachments,
    toBoardError,
    watchBoard
} from '../../services/board'
import {isTauri} from '../../services/desktop'
import {listPendingChanges} from '../../services/task-actions'
import {CARD_STATUSES, CARD_STATUS_LABELS, cardsIn} from '../../models/board'
import type {Card, CardDetail, CardStatus} from '../../models/board'
import type {CommandError} from '../../models/errors'
import type {PendingChange} from '../../models/app'
import {useAttachmentPool} from '../../hooks/useAttachmentPool'
import type {AttachmentPool} from '../../hooks/useAttachmentPool'
import {useFileMentionTrigger} from '../../hooks/useFileMentionTrigger'
import {useOpenCenterTab} from '../../hooks/useCenterTab'
import {useOpenTask} from '../../hooks/useOpenTask'
import {NewTaskDialog} from './NewTaskDialog'
import {PanelState} from './PanelState'

const DIALOG_WIDTH = 960
const DIALOG_MAX_HEIGHT = '90dvh'
// Tall enough that a task is read whole; the dialog body scrolls, the field never does.
const BODY_MAX_ROWS = 200

const STATUS_OPTIONS = CARD_STATUSES.map(status => ({
    value: status,
    label: CARD_STATUS_LABELS[status]
}))

function whoAndWhen(card: Card): string {
    const comments =
        card.commentCount === 0 ?
            ''
        :   ` · ${String(card.commentCount)} comment${card.commentCount === 1 ? '' : 's'}`
    return `#${String(card.number)} · ${card.owner}${comments}`
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

type CardFieldsProps = Readonly<{
    title: string
    onTitle: (title: string) => void
    body: string
    onBody: (body: string) => void
    pictures: AttachmentPool
    isReadOnly: boolean
    isBusy: boolean
    hasAutoFocus?: boolean
    /** The composer's own button: what saving this card is called here. */
    sendButton: ReactNode
}>

/**
 * A card's ask is written the way a message is: files are linked with @, pictures are attached,
 * pasted or dropped. Enter is a new line — a card is a document, and nothing is sent by typing.
 */
function CardFields({
    title,
    onTitle,
    body,
    onBody,
    pictures,
    isReadOnly,
    isBusy,
    hasAutoFocus = false,
    sendButton
}: CardFieldsProps) {
    const fileMentions = useFileMentionTrigger()
    const input = useRef<ChatComposerInputHandle>(null)
    const canAttach = isTauri() && !isReadOnly && !isBusy

    const onKeyDown = (event: KeyboardEvent) => {
        fileMentions.onKeyDown(event)
        if (event.defaultPrevented || event.key !== 'Enter' || event.shiftKey) return
        // The rich input clears itself on a bare Enter whether or not anything is listening.
        event.preventDefault()
        input.current?.insertText('\n')
        event.currentTarget.dispatchEvent(new Event('input', {bubbles: true}))
    }

    return (
        <VStack gap={4}>
            <TextInput
                label='Title'
                value={title}
                isRequired
                isReadOnly={isReadOnly}
                hasAutoFocus={hasAutoFocus}
                onChange={onTitle}
            />
            <VStack gap={1}>
                <Text type='label'>What to do</Text>
                <ChatComposer
                    elevation='none'
                    density='spacious'
                    value={body}
                    onChange={onBody}
                    onSubmit={() => undefined}
                    isDisabled={isReadOnly}
                    headerActions={
                        <>
                            <AttachmentPicker
                                canAttach={canAttach}
                                supportsImages
                                onSelect={files => {
                                    void pictures.select(files)
                                }}
                            />
                            <GameCapturePicker
                                canAttach={canAttach}
                                supportsImages
                                onSelect={files => {
                                    void pictures.select(files)
                                }}
                                onError={() => undefined}
                            />
                        </>
                    }
                    drawer={
                        pictures.attachments.length > 0 ?
                            <ChatComposerDrawer>
                                <AttachmentThumbnails
                                    attachments={pictures.attachments}
                                    isDisabled={isReadOnly || isBusy}
                                    onEdit={pictures.edit}
                                    onRemove={pictures.remove}
                                />
                            </ChatComposerDrawer>
                        :   undefined
                    }
                    input={
                        <TextField
                            kind='rich'
                            label='What to do'
                            placeholder=''
                            value={body}
                            maxRows={BODY_MAX_ROWS}
                            handleRef={input}
                            isDisabled={isReadOnly}
                            triggers={[fileMentions.trigger]}
                            hasPasteAsToken={false}
                            onKeyDown={onKeyDown}
                            onChange={onBody}
                            onFiles={files => {
                                const images = imageFiles(files)
                                if (!canAttach || images.length === 0) return
                                void pictures.select(images)
                            }}
                            onPaste={(event, text) => {
                                if (!canAttach) return undefined
                                const images = clipboardItemImages(event.clipboardData)
                                if (images.length > 0) {
                                    void pictures.select(images)
                                    return true
                                }
                                if (text !== '') return undefined
                                void pictures.attachClipboardImage()
                                return true
                            }}
                        />
                    }
                    sendButton={sendButton}
                />
            </VStack>
        </VStack>
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
    const pictures = useAttachmentPool(setFailure)

    const add = async () => {
        setIsSaving(true)
        try {
            const attachments = await storeCardAttachments(pictures.attachments, new Set())
            await createCard(title, body, 'backlog', attachments)
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
            width={DIALOG_WIDTH}
            maxHeight={DIALOG_MAX_HEIGHT}
            onOpenChange={isOpen => {
                if (!isOpen) onClose()
            }}
        >
            <Layout
                header={
                    <DialogHeader
                        title='New card'
                        onOpenChange={isOpen => {
                            if (!isOpen) onClose()
                        }}
                    />
                }
                content={
                    <LayoutContent padding={4}>
                        <VStack gap={4}>
                            {failure !== undefined && (
                                <Banner
                                    status='error'
                                    title='The card was not added'
                                    description={failure}
                                />
                            )}
                            <CardFields
                                title={title}
                                onTitle={setTitle}
                                body={body}
                                onBody={setBody}
                                pictures={pictures}
                                isReadOnly={false}
                                isBusy={isSaving}
                                hasAutoFocus
                                sendButton={
                                    <Button
                                        label='Add card'
                                        variant='primary'
                                        isLoading={isSaving}
                                        isDisabled={title.trim() === ''}
                                        clickAction={add}
                                    />
                                }
                            />
                        </VStack>
                    </LayoutContent>
                }
                footer={
                    <LayoutFooter hasDivider>
                        <HStack
                            gap={3}
                            hAlign='end'
                        >
                            <Button
                                label='Cancel'
                                variant='ghost'
                                clickAction={onClose}
                            />
                        </HStack>
                    </LayoutFooter>
                }
            />
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

function sameIds(left: readonly {id: string}[], right: readonly {id: string}[]): boolean {
    return left.length === right.length && left.every((one, index) => one.id === right[index]?.id)
}

function CardDialog({id, version, onClose, onChanged}: CardDialogProps) {
    const openTask = useOpenTask()
    const openTab = useOpenCenterTab()
    const [detail, setDetail] = useState<CardDetail>()
    const [failure, setFailure] = useState<string>()
    const [title, setTitle] = useState('')
    const [body, setBody] = useState('')
    const [comment, setComment] = useState('')
    const [isBusy, setIsBusy] = useState(false)
    const [isDeleting, setIsDeleting] = useState(false)
    const [pending, setPending] = useState<readonly PendingChange[]>()
    const pictures = useAttachmentPool(setFailure)
    // The fields are seeded from the card once per opening. A re-read after a comment or a move
    // must not overwrite what the user is halfway through typing.
    const [seededFor, setSeededFor] = useState<string>()
    const restore = pictures.restore

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
                void restore(read.attachments)
            })
            .catch((error: unknown) => {
                if (!cancelled) setFailure(toBoardError(error).message)
            })
        return () => {
            cancelled = true
        }
    }, [id, version, seededFor, restore])

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

    const save = () =>
        act(async () => {
            const held = new Set((detail?.attachments ?? []).map(one => one.id))
            const attachments = await storeCardAttachments(pictures.attachments, held)
            await editCard(id, {title, body, attachments})
        })

    const remove = async () => {
        setIsBusy(true)
        setFailure(undefined)
        try {
            await deleteCard(id)
            onChanged()
            onClose()
        } catch (error) {
            setFailure(toBoardError(error).message)
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
            openTab?.('chat')
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
    const isEdited =
        card !== undefined
        && detail !== undefined
        && (title !== card.title
            || body !== card.body
            || !sameIds(pictures.attachments, detail.attachments))
    const canPost = card?.taskId === null && !isDone

    const close = (isOpen: boolean) => {
        if (!isOpen) onClose()
    }

    return (
        <Dialog
            isOpen
            purpose='form'
            width={DIALOG_WIDTH}
            maxHeight={DIALOG_MAX_HEIGHT}
            onOpenChange={close}
        >
            <Layout
                header={
                    <DialogHeader
                        title={card?.title ?? 'Card'}
                        {...(card && {
                            subtitle: `#${String(card.number)} · ${CARD_STATUS_LABELS[card.status]} · ${card.owner}`
                        })}
                        onOpenChange={close}
                    />
                }
                content={
                    <LayoutContent padding={4}>
                        <VStack gap={4}>
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
                                                    void act(() =>
                                                        moveCard(id, status as CardStatus)
                                                    )
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
                                    <CardFields
                                        title={title}
                                        onTitle={setTitle}
                                        body={body}
                                        onBody={setBody}
                                        pictures={pictures}
                                        isReadOnly={isDone}
                                        isBusy={isBusy}
                                        sendButton={
                                            <Button
                                                label='Save changes'
                                                variant='secondary'
                                                isLoading={isBusy}
                                                isDisabled={!isEdited || isDone}
                                                clickAction={save}
                                            />
                                        }
                                    />
                                    <Divider />
                                    <Comments
                                        detail={detail}
                                        isDone={isDone}
                                        isBusy={isBusy}
                                        comment={comment}
                                        onComment={setComment}
                                        onSend={() => {
                                            void act(async () => {
                                                await commentOnCard(id, comment)
                                                setComment('')
                                            })
                                        }}
                                    />
                                </>
                            }
                        </VStack>
                    </LayoutContent>
                }
                footer={
                    card && (
                        <LayoutFooter hasDivider>
                            {isDeleting ?
                                <HStack
                                    gap={3}
                                    align='center'
                                >
                                    <StackItem size='fill'>
                                        <Text type='supporting'>
                                            Delete this card and everything said under it? This
                                            cannot be undone.
                                        </Text>
                                    </StackItem>
                                    <Button
                                        label='Keep it'
                                        variant='ghost'
                                        isDisabled={isBusy}
                                        clickAction={() => {
                                            setIsDeleting(false)
                                        }}
                                    />
                                    <Button
                                        label='Delete card'
                                        variant='destructive'
                                        isLoading={isBusy}
                                        clickAction={remove}
                                    />
                                </HStack>
                            :   <HStack
                                    gap={3}
                                    align='center'
                                >
                                    <Button
                                        label='Delete'
                                        variant='ghost'
                                        isDisabled={isBusy}
                                        clickAction={() => {
                                            setIsDeleting(true)
                                        }}
                                    />
                                    <StackItem size='fill'>
                                        {canPost && (
                                            <Text
                                                type='supporting'
                                                color='secondary'
                                            >
                                                Opens a task for this card with the ask already
                                                typed in. Merging that task finishes the card.
                                            </Text>
                                        )}
                                    </StackItem>
                                    {canPost && (
                                        <Button
                                            label='Post to Gofer'
                                            variant='primary'
                                            isLoading={isBusy}
                                            clickAction={offerToPost}
                                        />
                                    )}
                                </HStack>
                            }
                        </LayoutFooter>
                    )
                }
            />
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

type CommentsProps = Readonly<{
    detail: CardDetail
    isDone: boolean
    isBusy: boolean
    comment: string
    onComment: (comment: string) => void
    onSend: () => void
}>

function Comments({detail, isDone, isBusy, comment, onComment, onSend}: CommentsProps) {
    return (
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
                        onChange={onComment}
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
                            clickAction={onSend}
                        />
                    </HStack>
                </>
            )}
        </VStack>
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
