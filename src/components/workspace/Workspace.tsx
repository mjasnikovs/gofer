import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react'
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
import {ALL_THINKING_LEVELS, NO_THINKING_LEVELS} from '../../models/settings'
import {useAiConnection} from '../../hooks/useAiConnection'
import {useAttachmentPreviews} from '../../hooks/useAttachmentPreviews'
import {useConversation} from '../../hooks/useConversation'
import {useRememberedValue} from '../../hooks/useRememberedValue'
import {useToolApprovals} from '../../hooks/useToolApprovals'
import {useDesignSession} from '../../hooks/useDesignSession'
import {useUserQuestions} from '../../hooks/useUserQuestions'
import {useTaskBrief} from '../../hooks/useTaskBrief'
import {ChatColumnContext} from '../../hooks/useChatColumn'
import type {ChatColumn as ChatColumnValue} from '../../hooks/useChatColumn'
import {ChatReferenceContext} from '../../hooks/useChatReferences'
import {ComposerContext} from '../../hooks/useComposer'
import type {Composer} from '../../hooks/useComposer'
import {appendReference} from '../../utils/chat-references'
import type {ChatReference} from '../../utils/chat-references'
import {ChatColumn} from './ChatColumn'
import {InspectorWorkspace} from './InspectorWorkspace'
import {MergeConflictDialog} from './MergeConflictDialog'
import type {MergeConflictMode} from './MergeConflictDialog'
import {UnsavedWorkDialog} from './UnsavedWorkDialog'
import {unsavedScenes} from '../../models/unsaved-work'
import type {UnsavedWork} from '../../models/unsaved-work'
import {ToolApprovalDialog} from './ToolApprovalDialog'
import {UserQuestionDialog} from './UserQuestionDialog'
import {WorkspaceHeader} from './WorkspaceHeader'

type WorkspaceProps = Readonly<{
    activeTask?: TaskSummary
    /**
     * The task this workspace is drawing, as the route names it.
     *
     * Passed rather than taken from `activeTask`, which is looked up in a list that lags a switch by
     * one refresh. The chat is read by this name, so what is on screen is the conversation of the
     * task the window says it is showing and never the one the backend happens to have active.
     */
    taskId?: string
    /** Whether a task operation is running, which is when Merge must not be offered. */
    isTaskBusy?: boolean
    onTasksChanged?: () => void
    /**
     * Merges the displayed task.
     *
     * The argument is the answer to the question the merge asks about unsaved Godot work. Left out,
     * a merge that would lose it is refused and names the scenes instead.
     */
    onMergeTask?: (unsavedWork?: UnsavedWork) => Promise<void>
    /** Brings the project's branch into the task and answers what clashed. */
    onResolveMerge?: () => Promise<readonly string[]>
    /** Throws away an unfinished resolution merge and leaves the task as it was. */
    onAbandonMerge?: () => Promise<void>
}>

/** What the window is offering about a merge, and the files it is offering it about. */
type MergeOffer = Readonly<{
    mode: MergeConflictMode
    paths: readonly string[]
}>

const NOTHING_TO_OFFER: MergeOffer = {mode: 'clashed', paths: []}

/**
 * What a coded merge failure leaves to offer, or nothing.
 *
 * Two of the failures carry files and the rest carry a sentence. `task_merge_conflicted` is a merge
 * that never started, and the offer is to hand it to the agent. `task_merge_unfinished` is one that
 * started and stopped, and the offer is to throw it away — the state this feature is the only thing
 * that can create, so it is the one thing that has to answer for it.
 */
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

/**
 * What the agent is told about the merge it has been handed.
 *
 * It names the files and what state they are in, because the agent has no way to find that out —
 * nothing in the conversation says a merge is open. `git` through the shell would answer, but a
 * scene cannot be named in a shell command here, and the conflicts in the reported case were a
 * `.tscn` and five other files. So the prompt carries the list, and the rule that decides when the
 * job is done.
 */
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
/**
 * The chat column, built once at module scope.
 *
 * This is what makes the frame's memo hold: the element the frame is handed has to keep its
 * identity through a streamed reply, and an element built during render never can. The column reads
 * the conversation from `ChatColumnContext` instead.
 */
const CHAT_COLUMN = <ChatColumn />

/**
 * The chat column and the frame around it.
 *
 * What a turn is belongs to `services/turn.ts`; what is left here is the composer around it — the
 * unsent message, the images waiting to go with it, and where a failure is shown.
 */
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
    const [isSavingAttachments, setIsSavingAttachments] = useState(false)
    const [workspaceError, setWorkspaceError] = useState<string>()
    // The files a merge failure named, which is what the offer about them is drawn from.
    const [mergeOffered, setMergeOffered] = useState<MergeOffer>(NOTHING_TO_OFFER)
    // The scenes the editor was holding when a merge was refused for them.
    const [unsaved, setUnsaved] = useState<readonly string[]>([])
    const messageScrollRef = useRef<HTMLElement>(null)

    /** Everything that fails outside a turn reports here: the panels, the connection, the images. */
    const report = useCallback((message: string) => {
        setWorkspaceError(message)
    }, [])
    const clearError = useCallback(() => {
        setWorkspaceError(undefined)
    }, [])

    const {messages, taskId, turnError, isChatLoaded, start, retry, stop} = useConversation({
        taskId: openTaskId,
        onError: report,
        onTasksChanged
    })
    // The composer shows one line. A turn's own failure is the runner's to clear, so it is read
    // rather than copied — copying it was what left a stale error under the next turn.
    const streamError = workspaceError ?? turnError
    const {attachmentPreviews, addPreviews} = useAttachmentPreviews({messages, isChatLoaded})
    const {settings, models, connectionState, connect, applyModel, applyThinkingLevel} =
        useAiConnection({onError: report, onConnected: clearError})
    const {approvals, respond: respondToApproval} = useToolApprovals({onError: report})
    // Mounted beside the approvals dialog and knowing nothing about briefs: `ask_user` is an
    // ordinary tool, so an ordinary chat turn can ask the user something too.
    const {questions, answer: answerQuestion} = useUserQuestions({onError: report})
    const isBusy = useSyncExternalStore(watchTurn, isTurnRunning, isTurnRunning)
    // A design loop asks about one layout several times. Left as ordinary questions the card would
    // close on every answer and reopen once the agent had redrawn, so the user would watch their own
    // modal flicker rather than one design change. This keeps it on screen for the whole loop.
    const design = useDesignSession({
        questions,
        isTurnRunning: isBusy,
        onAnswer: answerQuestion
    })

    const hasConversation = messages.length > 0
    /*
     * The follow is a spring, and a spring that trails a growing column settles at a fixed distance
     * behind it: `growth × (mass − damping) / stiffness` per frame. At the library's default
     * stiffness that measured 57px of the last row hidden under the viewport's edge for as long as
     * the reply streamed. Twelve times stiffer holds the same stream at the bottom and still eases:
     * only a row that arrives in one piece, rather than a token at a time, is briefly behind.
     */
    const chatScroll = useChatStreamScroll({
        scrollRef: messageScrollRef,
        enabled: hasConversation,
        stiffness: 0.6
    })

    /*
     * The unsent message is kept with the task it was being written for.
     *
     * The pair is safe because the module makes it so: the read is asynchronous, and the empty
     * composer that exists while it is in flight would otherwise be written back over the draft it
     * is waiting for, and switching tasks would save one task's half-written message onto another.
     * A task that has not loaded yet has no key, so the composer still works and remembers nothing.
     */
    const {value: storedDraft, change: setDraft} = useRememberedValue({
        key: taskId === undefined ? undefined : draftKey(taskId),
        restore: stored => (typeof stored === 'string' ? stored : ''),
        isEmpty: value => value === ''
    })
    const draft = storedDraft ?? ''
    // Planning is the composer's other way to send a first message: the four phases run against
    // what was typed, and their specification is the turn.
    const {briefState, isPlanStarted, startPlan, stopBrief, startWithoutPlan} = useTaskBrief({
        taskId: openTaskId,
        onStartTurn: start,
        onError: report
    })
    /*
     * Whether the agent is occupied, whichever thing is occupying it.
     *
     * Read from the service rather than ORed here, because the sidebar needs the same answer and is
     * mounted beside this rather than inside it. See `turn-activity`: a brief is an AI turn — that
     * is what makes it stoppable, and what stops the checkout being switched under it — but it is
     * not the CHAT turn, so `isStreaming` stays false for the whole of it.
     */
    const isBriefRunning = briefState.isRunning

    useEffect(() => {
        chatScroll.scrollIfLocked()
    }, [messages, chatScroll.scrollIfLocked])

    /*
     * The jump button's handler takes no argument: `scrollToBottom` reads an options object, and a
     * click handler passed straight through would hand it the mouse event as those options.
     */
    const jumpToNewest = useCallback(() => {
        chatScroll.scrollToBottom()
    }, [chatScroll.scrollToBottom])

    /*
     * The column also follows growth that arrives without a new message.
     *
     * The effect above fires on `messages`, which is every streamed token but not every change in
     * height: the running indicator appearing under the last paragraph, a lazily loaded block of
     * tool output, an image finishing its decode. Each of those grew the column after the last
     * token, so the bottom row sat half under the composer until the next token pushed it — and
     * the indicator, which is the last row by definition, sat there the whole time it ran.
     *
     * The observer watches the list rather than the viewport: the viewport's own size is fixed by
     * the frame, so it never reports the growth that matters.
     */
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

    /**
     * Puts the drawer's images on disk and answers with what names them from here on.
     *
     * Both of the composer's sends go through this, because both take the images with them: the
     * bytes cross to the backend once and everything after it — the brief, the turn, the stored
     * row — carries the metadata alone. The drawer is emptied here for the same reason the draft
     * is emptied beside it: the images have been taken, and a copy left behind is a second send
     * waiting to happen.
     */
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

    const submitMessage = async (value: string) => {
        const prompt = value.trim()
        if ((!prompt && draftAttachments.length === 0) || isBusy || !isTauri()) return
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

    /**
     * Retry is handed to every message in the conversation, so it has to keep its identity between
     * renders or `ConversationMessage`'s memo never holds: a callback redefined per token
     * re-renders the whole conversation per token.
     *
     * The draft is deliberately left alone — a retry is not a message the user just sent, and
     * clearing the composer threw away whatever they had started typing while the turn failed.
     */
    const retryTurn = useCallback(
        (assistantId: number) => {
            setWorkspaceError(undefined)
            retry(assistantId)
        },
        [retry]
    )

    /**
     * Merges, and asks about anything the Godot editor is still holding.
     *
     * The first press answers nothing, so a merge that would throw unsaved scenes away comes back
     * refused and naming them; the dialog then presses this again with what the user chose. Nothing
     * has moved when that refusal arrives — the editor is still open with the work in it — so the
     * error line is left alone and the dialog carries the message instead.
     */
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
            // Two merge failures have something left to try, and the backend says which files.
            // Everything else is a sentence and nothing to offer.
            setMergeOffered(mergeOffer(failure))
        }
    }

    /**
     * Hands the conflict to the agent.
     *
     * The backend brings the project's branch into this task, so the clashing files are sitting in
     * the worktree holding both versions — which is a file to edit, the thing the agent is for,
     * rather than a merge somebody has to drive. The turn that follows names them and says what
     * done looks like. Nothing can be committed until every one of them is resolved, so a turn that
     * gives up leaves the task no worse than the aborted merge did.
     */
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

    /**
     * Throws the unfinished merge away.
     *
     * The only state this feature can leave behind that the user cannot get out of: a resolution
     * the agent stopped part-way refuses every merge after it, and the file it gave up on is not
     * something anyone fixes by pressing Merge again. Discarding puts the task back where the failed
     * merge had already left it, which is the same place "Leave it to me" would have.
     */
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

    const usage = messageUsage(messages)
    const supportsImages = Boolean(settings?.ai.input.includes('image'))

    /**
     * Swaps in the drawn-on picture, keeping the original and the strokes beside it.
     *
     * The id does not change, so the thumbnail stays where it was rather than jumping to the end of
     * the drawer. `annotation.src` is only taken from the current preview the first time: after that
     * the preview is a flattened picture, and drawing on a drawing would bake the strokes in.
     */
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

    /**
     * Hands the typed ask to the brief instead of to a turn.
     *
     * The composer is emptied, because the ask has been taken: the plan holds it from here, and a
     * plan that fails offers it back rather than leaving a copy behind to be sent twice. The
     * pictures go with it. A user who pastes a screenshot and presses this has said "plan THIS",
     * and left in the drawer the picture reached neither the plan nor the turn the specification
     * starts — the whole run was written about a sentence describing a screen nobody looked at.
     */
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

    /*
     * The image on the system clipboard, asked for because the paste event did not carry it.
     *
     * WebKitGTK gives a paste event an empty `clipboardData` when the clipboard holds an image, so
     * the composer has nothing to read and has to ask the backend instead. A clipboard holding
     * anything else answers with nothing, which is why a paste of plain text is not an error here.
     */
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

    const composerValue: Composer = {
        state: {
            draft,
            draftAttachments,
            selectedModel: settings?.ai.modelName ?? settings?.ai.model ?? 'Loading model…',
            thinkingLevel: settings?.ai.thinkingLevel ?? 'off',
            usage,
            ...(streamError && {streamError})
        },
        actions: {
            applyModel,
            applyThinkingLevel,
            attachClipboardImage,
            changeDraft: setDraft,
            editAttachment,
            plan: planMessage,
            removeAttachment,
            selectAttachments,
            stop: isBriefRunning ? stopBrief : stop,
            submit: submitMessage
        },
        meta: {
            canAttachImages: supportsImages && !isBusy && !isSavingAttachments && isTauri(),
            contextWindow: settings?.ai.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            isSavingAttachments,
            // The chat has to have been read before this can mean anything: an unread task reports
            // no messages, which is the same shape as a task that genuinely has none.
            isPlanOffered: isChatLoaded && !hasConversation && !isPlanStarted,
            isStreaming: isBusy,
            models,
            supportsImages,
            thinkingLevels: settings?.ai.reasoning ? ALL_THINKING_LEVELS : NO_THINKING_LEVELS,
            ...(settings && {settings})
        }
    }

    // Every panel below the header can name what it shows in the message being written.
    const references = useMemo(
        () => ({
            add: (reference: ChatReference) => {
                setDraft(previous => appendReference(previous, reference))
            },
            // A paragraph of its own, and once. A pasted block is a document, not a phrase: joined
            // onto the sentence somebody is mid-way through it would be neither readable nor
            // separable again. The first line is what identifies it, so that is what a repeat is
            // recognised by — comparing the whole block would miss nothing and cost kilobytes.
            paste: (text: string) => {
                setDraft(previous => {
                    const caption = text.split('\n', 1)[0] ?? text
                    if (previous.includes(caption)) return previous
                    return previous.trim() === '' ? text : `${previous.trimEnd()}\n\n${text}`
                })
            }
        }),
        [setDraft]
    )

    const chatColumn: ChatColumnValue = {
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
    }

    return (
        <ComposerContext value={composerValue}>
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
                            <InspectorWorkspace
                                chat={CHAT_COLUMN}
                                onError={report}
                            />
                        </ChatReferenceContext.Provider>
                    </StackItem>
                    <ToolApprovalDialog
                        onRespond={respondToApproval}
                        {...(approvals[0] && {prompt: approvals[0]})}
                    />
                    <UserQuestionDialog
                        onAnswer={design.answer}
                        isRedrawing={design.isRedrawing}
                        {...(design.prompt && {prompt: design.prompt})}
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
        </ComposerContext>
    )
}
