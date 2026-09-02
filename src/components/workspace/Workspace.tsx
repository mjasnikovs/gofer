import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore
} from 'react'
import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import {useChatStreamScroll} from '@astryxdesign/core/Chat'
import {Divider} from '@astryxdesign/core/Divider'
import {StackItem, VStack} from '@astryxdesign/core/Stack'
import {invoke, isTauri} from '../../services/desktop'
import {commandErrorMessage, toCommandError} from '../../utils/command-error'
import type {TaskSummary} from '../../models/app'
import type {CommandError} from '../../models/errors'
import type {AnnotationShape} from '../../models/annotation'
import type {ChatAttachment, DraftAttachment} from '../../models/chat'
import {messageUsage} from '../../utils/chat-format'
import {attachmentData, pngFile} from '../../services/chat-storage'
import {draftKey} from '../../services/ui-state'
import {isTurnRunning, watchTurn} from '../../services/turn-activity'
import {NO_THINKING_LEVELS, activeModel, thinkingLevelsFor} from '../../models/settings'
import {useAiConnection} from '../../hooks/useAiConnection'
import {useAttachmentPreviews} from '../../hooks/useAttachmentPreviews'
import {useConversation} from '../../hooks/useConversation'
import {COMPACT_COMMAND} from '../../hooks/useCompactCommandTrigger'
import {useRememberedValue} from '../../hooks/useRememberedValue'
import {useToolApprovals} from '../../hooks/useToolApprovals'
import {AskedQuestionsContext, useUserQuestions} from '../../hooks/useUserQuestions'
import {useTaskBrief} from '../../hooks/useTaskBrief'
import {ChatColumnContext} from '../../hooks/useChatColumn'
import type {ChatColumn as ChatColumnValue} from '../../hooks/useChatColumn'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import {ComposerAppendContext} from '../../hooks/useComposerAppend'
import type {ComposerAddition, ComposerAppend} from '../../hooks/useComposerAppend'
import {ComposerContext} from '../../hooks/useComposer'
import type {Composer, ComposerActions} from '../../hooks/useComposer'
import {referenceInsertion} from '../../utils/chat-references'
import type {ChatReference} from '../../utils/chat-references'
import {ChatColumn} from './ChatColumn'
import {InspectorWorkspace} from './InspectorWorkspace'
import {MergeConflictDialog} from './MergeConflictDialog'
import type {MergeConflictMode} from './MergeConflictDialog'
import {UnsavedWorkDialog} from './UnsavedWorkDialog'
import {unsavedScenes} from '../../models/unsaved-work'
import type {UnsavedWork} from '../../models/unsaved-work'
import {ToolApprovalDialog} from './ToolApprovalDialog'
import {WorkspaceHeader} from './WorkspaceHeader'

type WorkspaceProps = Readonly<{
    activeTask?: TaskSummary
    taskId?: string
    isTaskBusy?: boolean
    onTasksChanged?: () => void
    onMergeTask?: (unsavedWork?: UnsavedWork) => Promise<void>
    onResolveMerge?: () => Promise<readonly string[]>
    onAbandonMerge?: () => Promise<void>
}>

type MergeOffer = Readonly<{
    mode: MergeConflictMode
    paths: readonly string[]
}>

const NOTHING_TO_OFFER: MergeOffer = {mode: 'clashed', paths: []}

// The live document is not ours to rewrite, so the blank line before the addition is made out of
// whatever the draft already ends with.
function joinDraft(previous: string, text: string): string {
    if (previous.trim() === '') return text
    const written = /\n*$/u.exec(previous)?.[0].length ?? 0
    return `${'\n\n'.slice(Math.min(written, 2))}${text}`
}

function pasteDraft(previous: string, text: string): string | undefined {
    return previous.includes(text) ? undefined : joinDraft(previous, text)
}

function mergeOffer(failure: CommandError): MergeOffer {
    const mode = MERGE_FAILURE_MODES[failure.code]
    if (!mode) return NOTHING_TO_OFFER
    const named = failure.details?.['conflicts']
    if (!Array.isArray(named)) return NOTHING_TO_OFFER
    return {mode, paths: named.filter((path): path is string => typeof path === 'string')}
}

const MERGE_FAILURE_MODES: Readonly<Record<string, MergeConflictMode | undefined>> = {
    task_merge_conflicted: 'clashed',
    task_merge_unfinished: 'unfinished'
}

function conflictPrompt(conflicts: readonly string[]): string {
    return [
        "I have brought the project's branch into this task and Git could not merge these files.",
        'Each one now holds both versions, marked with <<<<<<<, ======= and >>>>>>>:',
        ...conflicts.map(path => `- ${path}`),
        '',
        'Read each one, keep what both sides were trying to do, and remove every marker. Write a',
        'scene through the scene tools and a script through godot_script, not as raw text. When',
        'nothing is left holding both versions, say so and stop — I will merge from there.'
    ].join('\n')
}

const CHAT_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_CHAT_ATTACHMENTS = 5
const MAX_CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024
const DEFAULT_CONTEXT_WINDOW = 120_064
const CHAT_COLUMN = <ChatColumn />

export function Workspace({
    activeTask,
    taskId: openTaskId,
    isTaskBusy = false,
    onTasksChanged,
    onMergeTask,
    onResolveMerge,
    onAbandonMerge
}: WorkspaceProps) {
    const [draftAttachments, setDraftAttachments] = useState<readonly DraftAttachment[]>([])
    const composerAppendRef = useRef<ComposerAppend | null>(null)
    const [isSavingAttachments, setIsSavingAttachments] = useState(false)
    const [workspaceError, setWorkspaceError] = useState<string>()
    const [mergeOffered, setMergeOffered] = useState<MergeOffer>(NOTHING_TO_OFFER)
    const [unsaved, setUnsaved] = useState<readonly string[]>([])
    const messageScrollRef = useRef<HTMLElement>(null)

    const report = useCallback((message: string) => {
        setWorkspaceError(message)
    }, [])
    const clearError = useCallback(() => {
        setWorkspaceError(undefined)
    }, [])

    const {
        messages,
        taskId,
        turnError,
        clearTurnError,
        isChatLoaded,
        isStreaming,
        handBack,
        takeHandBack,
        start,
        queue,
        retry,
        compact,
        stop
    } = useConversation({taskId: openTaskId, onError: report, onTasksChanged})
    const streamError = workspaceError ?? turnError
    // The banner shows whichever half is set, so dismissing it has to answer for both.
    const dismissError = useCallback(() => {
        clearError()
        clearTurnError()
    }, [clearError, clearTurnError])
    const {attachmentPreviews, addPreviews} = useAttachmentPreviews({messages, isChatLoaded})
    const {settings, models, connectionState, connect, applyModel, applyThinkingLevel} =
        useAiConnection({onError: report, onConnected: clearError})
    const {approvals, respond: respondToApproval} = useToolApprovals({onError: report})
    const {questions, answer: answerQuestion} = useUserQuestions({onError: report})
    const isBusy = useSyncExternalStore(watchTurn, isTurnRunning, isTurnRunning)

    const hasConversation = messages.length > 0
    const chatScroll = useChatStreamScroll({
        scrollRef: messageScrollRef,
        enabled: hasConversation,
        stiffness: 0.6
    })

    const {value: storedDraft, change: setDraft} = useRememberedValue({
        key: taskId === undefined ? undefined : draftKey(taskId),
        restore: stored => (typeof stored === 'string' ? stored : ''),
        isEmpty: value => value === ''
    })
    const draft = storedDraft ?? ''
    // The composer's own document is the live one; the remembered value only catches up to it.
    const addToDraft = useCallback(
        (addition: ComposerAddition, takesCaret: boolean) => {
            const append = composerAppendRef.current
            if (append?.(addition, takesCaret)) return
            setDraft(previous => {
                const added = addition(previous)
                return added === undefined ? previous : `${previous}${added}`
            })
        },
        [setDraft]
    )
    // A queued message the turn never carried comes back to where it was typed.
    useEffect(() => {
        if (handBack.length === 0) return
        // The queue holds what the user wrote, twice over if they wrote it twice, and nothing else
        // is keeping it once it is taken.
        for (const text of takeHandBack()) addToDraft(previous => joinDraft(previous, text), false)
    }, [addToDraft, handBack, takeHandBack])
    const {briefState, isPlanStarted, startPlan, stopBrief, startWithoutPlan} = useTaskBrief({
        taskId: openTaskId,
        onStartTurn: start,
        onError: report
    })
    const isBriefRunning = briefState.isRunning

    useEffect(() => {
        chatScroll.scrollIfLocked()
    }, [messages, chatScroll.scrollIfLocked])

    const jumpToNewest = useCallback(() => {
        chatScroll.scrollToBottom()
    }, [chatScroll.scrollToBottom])

    useEffect(() => {
        const content = messageScrollRef.current?.firstElementChild
        if (!content) return undefined
        const observer = new ResizeObserver(() => {
            chatScroll.scrollIfLocked()
        })
        observer.observe(content)
        return () => {
            observer.disconnect()
        }
    }, [chatScroll.scrollIfLocked, hasConversation])

    const takeAttachments = async (): Promise<readonly ChatAttachment[]> => {
        const taken = draftAttachments
        if (taken.length === 0) return []
        await Promise.all(
            taken.map(attachment =>
                invoke('save_chat_attachment', {
                    request: {
                        attachment: {
                            id: attachment.id,
                            name: attachment.name,
                            mimeType: attachment.mimeType,
                            size: attachment.size
                        },
                        data: attachment.data
                    }
                })
            )
        )
        addPreviews(
            Object.fromEntries(taken.map(attachment => [attachment.id, attachment.previewUrl]))
        )
        setDraftAttachments([])
        return taken.map(attachment => ({
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size
        }))
    }

    // A running turn takes the message rather than eating it: queued here, steered into the turn by
    // the worker at its next boundary.
    const queueMessage = (prompt: string) => {
        if (draftAttachments.length > 0) {
            setWorkspaceError('Images can only go with a message that starts a new turn.')
            return
        }
        if (!isStreaming || !queue(prompt)) {
            setWorkspaceError('Gofer is busy with another job, so this could not be queued.')
            return
        }
        setWorkspaceError(undefined)
        setDraft('')
    }

    const submitMessage = async (value: string) => {
        const prompt = value.trim()
        // Intercepted here rather than at the keyboard, so the send button spends it too. The
        // draft is only spent once the command can actually run; otherwise it is still the user's.
        if (prompt === COMPACT_COMMAND) {
            if (!canCompact) {
                setWorkspaceError(
                    isBusy ?
                        'Gofer is working. Summarise once the turn ends.'
                    :   'There is no conversation to summarise yet.'
                )
                return
            }
            setDraft('')
            await offerCompact()
            return
        }
        if ((!prompt && draftAttachments.length === 0) || !isTauri()) return
        if (isBusy) {
            queueMessage(prompt)
            return
        }
        setIsSavingAttachments(true)
        setWorkspaceError(undefined)
        try {
            const attachments = await takeAttachments()
            setDraft('')
            start(prompt, attachments)
        } catch (error) {
            setWorkspaceError(`The images could not be attached: ${commandErrorMessage(error)}`)
        } finally {
            setIsSavingAttachments(false)
        }
    }

    const selectAttachments = async (files: FileList | readonly File[] | null) => {
        if (!files) return
        const available = MAX_CHAT_ATTACHMENTS - draftAttachments.length
        const selected = Array.from(files).slice(0, available)
        const invalid = selected.find(
            file =>
                !CHAT_ATTACHMENT_TYPES.has(file.type)
                || file.size === 0
                || file.size > MAX_CHAT_ATTACHMENT_BYTES
        )
        if (files.length > available) {
            setWorkspaceError(`You can attach up to ${String(MAX_CHAT_ATTACHMENTS)} images.`)
            return
        }
        if (invalid) {
            setWorkspaceError(
                invalid.size === 0 ? `${invalid.name} is empty.`
                : CHAT_ATTACHMENT_TYPES.has(invalid.type) ? `${invalid.name} is larger than 10 MiB.`
                : `${invalid.name} is not a supported image.`
            )
            return
        }
        try {
            const attachments = await Promise.all(
                selected.map(async file => ({
                    id: crypto.randomUUID(),
                    name: file.name,
                    mimeType: file.type,
                    size: file.size,
                    ...(await attachmentData(file))
                }))
            )
            setDraftAttachments(previous => [...previous, ...attachments])
            setWorkspaceError(undefined)
        } catch (error) {
            setWorkspaceError(`The images could not be read: ${commandErrorMessage(error)}`)
        }
    }

    const retryTurn = useCallback(
        (assistantId: number) => {
            setWorkspaceError(undefined)
            retry(assistantId)
        },
        [retry]
    )

    const mergeTask = async (unsavedWork?: UnsavedWork) => {
        if (!onMergeTask) return
        setWorkspaceError(undefined)
        setMergeOffered(NOTHING_TO_OFFER)
        setUnsaved([])
        try {
            await onMergeTask(unsavedWork)
        } catch (error) {
            const failure = toCommandError(error)
            const holding = unsavedScenes(failure)
            if (holding.length > 0) {
                setUnsaved(holding)
                return
            }
            setWorkspaceError(`The task could not be merged: ${failure.message}`)
            setMergeOffered(mergeOffer(failure))
        }
    }

    const resolveMerge = async () => {
        if (!onResolveMerge) return
        setMergeOffered(NOTHING_TO_OFFER)
        setWorkspaceError(undefined)
        let conflicts: readonly string[]
        try {
            conflicts = await onResolveMerge()
        } catch (error) {
            setWorkspaceError(`The merge could not be started: ${commandErrorMessage(error)}`)
            return
        }
        if (conflicts.length === 0) {
            setWorkspaceError(
                'The project merged into this task cleanly after all. Press Merge to finish.'
            )
            return
        }
        await submitMessage(conflictPrompt(conflicts))
    }

    const abandonMerge = async () => {
        if (!onAbandonMerge) return
        setMergeOffered(NOTHING_TO_OFFER)
        try {
            await onAbandonMerge()
            setWorkspaceError(undefined)
        } catch (error) {
            setWorkspaceError(`The merge could not be discarded: ${commandErrorMessage(error)}`)
        }
    }

    const usage = useMemo(() => messageUsage(messages), [messages])
    const canCompact = isChatLoaded && !isBusy && hasConversation
    const [isCompactOffered, setIsCompactOffered] = useState(false)
    const model = activeModel(settings)
    const supportsImages = Boolean(model?.input.includes('image'))

    const editAttachment = async (
        attachmentId: string,
        file: File,
        shapes: readonly AnnotationShape[]
    ) => {
        if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
            setWorkspaceError(`${file.name} is larger than 10 MiB once drawn on.`)
            return
        }
        try {
            const stored = await attachmentData(file)
            setDraftAttachments(previous =>
                previous.map(attachment =>
                    attachment.id === attachmentId ?
                        {
                            ...attachment,
                            name: file.name,
                            mimeType: file.type,
                            size: file.size,
                            ...stored,
                            annotation: {
                                src: attachment.annotation?.src ?? attachment.previewUrl,
                                shapes
                            }
                        }
                    :   attachment
                )
            )
            setWorkspaceError(undefined)
        } catch (error) {
            setWorkspaceError(`The drawing could not be saved: ${commandErrorMessage(error)}`)
        }
    }

    const planMessage = async (value: string) => {
        const prompt = value.trim()
        if (!prompt || isBusy || !isTauri()) return
        setIsSavingAttachments(true)
        setWorkspaceError(undefined)
        try {
            const attachments = await takeAttachments()
            setDraft('')
            startPlan(prompt, attachments)
        } catch (error) {
            setWorkspaceError(`The images could not be attached: ${commandErrorMessage(error)}`)
        } finally {
            setIsSavingAttachments(false)
        }
    }

    const removeAttachment = useCallback((attachmentId: string) => {
        setDraftAttachments(previous => previous.filter(item => item.id !== attachmentId))
    }, [])

    const attachClipboardImage = async () => {
        if (!isTauri()) return
        try {
            const image = await invoke('read_clipboard_image')
            if (!image) return
            await selectAttachments([pngFile(image.pngBase64, 'pasted-image.png')])
        } catch (error) {
            setWorkspaceError(`The pasted image could not be read: ${commandErrorMessage(error)}`)
        }
    }

    const offerCompact = async () => {
        setIsCompactOffered(true)
    }

    const liveActions: ComposerActions = {
        applyModel,
        applyThinkingLevel,
        attachClipboardImage,
        changeDraft: setDraft,
        clearError: dismissError,
        compact: offerCompact,
        editAttachment,
        plan: planMessage,
        removeAttachment,
        selectAttachments,
        stop: isBriefRunning ? stopBrief : stop,
        submit: submitMessage
    }
    const newest = useRef(liveActions)

    useLayoutEffect(() => {
        newest.current = liveActions
    })

    const actions = useMemo<ComposerActions>(
        () => ({
            applyModel: (chosen, previous) => newest.current.applyModel(chosen, previous),
            applyThinkingLevel: (level, previous) =>
                newest.current.applyThinkingLevel(level, previous),
            attachClipboardImage: () => newest.current.attachClipboardImage(),
            changeDraft: value => {
                newest.current.changeDraft(value)
            },
            clearError: () => {
                newest.current.clearError()
            },
            compact: () => newest.current.compact(),
            editAttachment: (attachmentId, file, shapes) =>
                newest.current.editAttachment(attachmentId, file, shapes),
            plan: value => newest.current.plan(value),
            removeAttachment: attachmentId => {
                newest.current.removeAttachment(attachmentId)
            },
            selectAttachments: files => newest.current.selectAttachments(files),
            stop: () => {
                newest.current.stop()
            },
            submit: value => newest.current.submit(value)
        }),
        []
    )

    const composerValue = useMemo<Composer>(
        () => ({
            state: {
                draft,
                draftAttachments,
                selectedModel: model?.name ?? model?.id ?? 'Loading model…',
                thinkingLevel: model?.thinkingLevel ?? 'off',
                usage,
                ...(streamError && {streamError})
            },
            actions,
            meta: {
                canAttachImages: supportsImages && !isBusy && !isSavingAttachments && isTauri(),
                canCompact,
                canQueue: isStreaming,
                contextWindow: model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
                isSavingAttachments,
                isPlanOffered: isChatLoaded && !hasConversation && !isPlanStarted,
                isStreaming: isBusy,
                models,
                supportsImages,
                thinkingLevels: model ? thinkingLevelsFor(model) : NO_THINKING_LEVELS,
                ...(settings && {settings})
            }
        }),
        [
            actions,
            draft,
            draftAttachments,
            hasConversation,
            canCompact,
            isBusy,
            isChatLoaded,
            isStreaming,
            isPlanStarted,
            isSavingAttachments,
            model,
            models,
            settings,
            streamError,
            supportsImages,
            usage
        ]
    )

    const references = useMemo(
        () => ({
            add: (reference: ChatReference) => {
                addToDraft(previous => referenceInsertion(previous, reference), true)
            },
            paste: (text: string) => {
                addToDraft(previous => pasteDraft(previous, text), true)
            }
        }),
        [addToDraft]
    )

    const chatColumn = useMemo<ChatColumnValue>(
        () => ({
            attachmentPreviews,
            isStreaming: isBusy,
            messages,
            scrollRef: messageScrollRef,
            isScrolledUp: chatScroll.isScrolledUp,
            scrollToBottom: jumpToNewest,
            retry: retryTurn,
            brief: briefState,
            cancelBrief: stopBrief,
            startWithoutPlan
        }),
        [
            attachmentPreviews,
            briefState,
            chatScroll.isScrolledUp,
            isBusy,
            jumpToNewest,
            messages,
            retryTurn,
            startWithoutPlan,
            stopBrief
        ]
    )

    const asked = useMemo(() => ({questions, answer: answerQuestion}), [questions, answerQuestion])

    return (
        <ComposerContext value={composerValue}>
            <AskedQuestionsContext value={asked}>
                <ChatColumnContext value={chatColumn}>
                    <VStack
                        gap={0}
                        height='100%'
                    >
                        <WorkspaceHeader
                            connectionState={connectionState}
                            isTaskBusy={isTaskBusy}
                            onConnect={connect}
                            onMergeTask={() => {
                                void mergeTask()
                            }}
                            {...(activeTask && {activeTask})}
                        />
                        <Divider />
                        <StackItem size='fill'>
                            <ChatReferenceContext.Provider value={references}>
                                <ComposerAppendContext.Provider value={composerAppendRef}>
                                    <InspectorWorkspace
                                        chat={CHAT_COLUMN}
                                        onError={report}
                                    />
                                </ComposerAppendContext.Provider>
                            </ChatReferenceContext.Provider>
                        </StackItem>
                        <ToolApprovalDialog
                            onRespond={respondToApproval}
                            {...(approvals[0] && {prompt: approvals[0]})}
                        />
                        <UnsavedWorkDialog
                            scenes={unsaved}
                            onSave={() => {
                                void mergeTask('save')
                            }}
                            onDiscard={() => {
                                void mergeTask('discard')
                            }}
                            onDismiss={() => {
                                setUnsaved([])
                            }}
                        />
                        <AlertDialog
                            isOpen={isCompactOffered}
                            // Escape would otherwise leave the summary running behind a closed
                            // dialog, with nothing on screen saying the connection is still held.
                            onOpenChange={next => {
                                if (!isBusy) setIsCompactOffered(next)
                            }}
                            title='Summarise this conversation?'
                            description='The older part becomes a summary the model reads instead. Every message stays on screen, and this cannot be undone.'
                            actionLabel='Summarise'
                            isActionLoading={isBusy}
                            onAction={() => {
                                void compact().finally(() => {
                                    setIsCompactOffered(false)
                                })
                            }}
                        />
                        <MergeConflictDialog
                            conflicts={mergeOffered.paths}
                            mode={mergeOffered.mode}
                            onResolve={() => {
                                void resolveMerge()
                            }}
                            onDiscard={() => {
                                void abandonMerge()
                            }}
                            onDismiss={() => {
                                setMergeOffered(NOTHING_TO_OFFER)
                            }}
                        />
                    </VStack>
                </ChatColumnContext>
            </AskedQuestionsContext>
        </ComposerContext>
    )
}
