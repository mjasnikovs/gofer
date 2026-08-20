import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import type {AnnotationShape} from './annotation'

/**
 * One step of an assistant turn, in the order it happened.
 *
 * A turn narrates, calls a tool, narrates again. `text`, `thinking` and `tools` are the whole-turn
 * totals that the request history and the stored chat need, and they cannot say which came first —
 * only this list can, and it is what the conversation is drawn from.
 */
export type MessagePart =
    | Readonly<{kind: 'text'; text: string}>
    | Readonly<{kind: 'thinking'; text: string}>
    | Readonly<{kind: 'tool'; toolId: string}>

export type Message = Readonly<{
    id: number
    sender: 'user' | 'assistant'
    text: string
    timestamp: number
    thinking?: string
    tools?: readonly ToolActivity[]
    /** Absent on chats stored before the turn recorded its order; see `messageParts`. */
    parts?: readonly MessagePart[]
    usage?: TokenUsage
    model?: string
    status?: 'streaming' | 'complete' | 'error' | 'aborted'
    /**
     * What the turn is doing while it has nothing to show yet. Named in place of the generic
     * spinner label, so a long silent step reads as work rather than as a hang.
     */
    activity?: string
    attachments?: readonly ChatAttachment[]
    /**
     * The task's verification points, as they run and once they have answered.
     *
     * On the turn rather than on the task, because a point is only ever true of one turn's work:
     * the same point is red before a fix and green after it, and a list held per task would show
     * the older answer beside the newer reply that changed it.
     */
    verifyPoints?: readonly VerifyPoint[]
}>

/**
 * One named check from the task's specification, and where it has got to.
 *
 * The statuses are `ChatToolCalls`' own, so the row needs no mapping: a point is a thing the turn
 * did, drawn where the turn's other work is drawn.
 */
export type VerifyPoint = Readonly<{
    name: string
    command: string
    status: 'running' | 'complete' | 'error'
    output?: string
}>

export type ChatAttachment = Readonly<{
    id: string
    name: string
    mimeType: string
    size: number
}>

/**
 * The strokes drawn over an attachment, kept beside the picture they were drawn on.
 *
 * `src` is the image before any of them landed. Saving flattens the two into the bytes the model is
 * sent, and reopening the scratchpad rebuilds from these, so an edit stays editable.
 */
export type DraftAnnotation = Readonly<{
    src: string
    shapes: readonly AnnotationShape[]
}>

export type DraftAttachment = ChatAttachment
    & Readonly<{
        data: string
        previewUrl: string
        annotation?: DraftAnnotation
    }>

export type TokenUsage = Readonly<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning?: number
    totalTokens: number
    cost: Readonly<{total: number}>
}>

export type ToolActivity = Readonly<{
    id: string
    name: string
    target?: string
    /**
     * What this call is doing right now, for the few tools that have an inside to report.
     *
     * Only a delegation has one today: it runs a whole agent, for minutes, and the row said the
     * question and then nothing. Separate from `target` because the question is what tells two
     * delegations dispatched in the same turn apart, and it has to survive on the row beside this.
     */
    step?: string
    output?: string
    status: 'pending' | 'running' | 'complete' | 'error'
    startedAt: number
    endedAt?: number
    /**
     * New tokens the ask that issued this call cost — `input + output`, never `cacheRead`.
     *
     * The model is billed per ask, not per call, so an ask that issued several calls shares its
     * cost evenly between them. That keeps the rows summable: add up every row of a turn and the
     * answer is what the turn's tool work actually cost, with nothing counted twice.
     */
    tokens?: number
}>

export type AiStreamEvent =
    | Readonly<{type: 'text-delta'; delta: string}>
    | Readonly<{type: 'thinking-delta'; delta: string}>
    | Readonly<{type: 'tool-start'; id: string; name: string; target?: string; startedAt: number}>
    | Readonly<{type: 'tool-update'; id: string; output: string; step?: string}>
    | Readonly<{type: 'tool-end'; id: string; output: string; isError: boolean; endedAt: number}>
    | Readonly<{type: 'usage'; usage: TokenUsage; model: string}>
    /**
     * What one ask cost, and which tool calls it issued.
     *
     * `usage` cannot carry this: it reports the turn's running total and the reducer overwrites the
     * previous one, so only the last of a long turn's reports survives. This is per ask, it is
     * addressed to the calls that ask made, and nothing overwrites it.
     */
    | Readonly<{type: 'tool-cost'; ids: readonly string[]; tokens: number}>
    | Readonly<{type: 'compaction-start'; tokens: number; contextWindow: number}>
    | Readonly<{type: 'compaction-end'}>
    | Readonly<{
          type: 'done'
          text: string
          thinking: string
          stopReason: string
          usage: TokenUsage
          model: string
          agentMessages: readonly unknown[]
      }>
    /**
     * One verification point starting, or answering.
     *
     * Sent per point rather than once at the end, because the run is the part worth watching: a
     * point that boots a headless Godot is seconds of silence, and a list that only appears once
     * every point has finished is a list nobody sees while it matters.
     */
    | Readonly<{
          type: 'verify-point'
          name: string
          command: string
          status: 'running' | 'complete' | 'error'
          index: number
          of: number
          output?: string
      }>
    /**
     * The model's memory of this task, as it stands part-way through a turn.
     *
     * Sent at every step rather than only at the end, so a turn that never reaches `done` still
     * leaves behind what it did. It carries no message content: nothing on screen changes when one
     * arrives.
     */
    | Readonly<{type: 'turn-state'; agentMessages: readonly unknown[]}>
    /**
     * The model had no memory of this task, so the conversation on screen was sent in its place.
     *
     * Worth saying out loud: what the agent did with its tools is not in the rebuilt context, only
     * what it wrote about it, so the turn may cover ground it has already covered.
     */
    | Readonly<{type: 'context-rebuilt'; messages: number}>
    /**
     * The turn failed for a reason that may pass, and is waiting before asking again.
     *
     * The turn is still running: nothing has been given up on, and the reply must not be settled or
     * offered a Retry button while one of these is the last thing that arrived.
     */
    | Readonly<{
          type: 'retry-scheduled'
          attempt: number
          maxAttempts: number
          delayMs: number
          errorMessage: string
      }>
    /** The wait is over and the model is being asked again. */
    | Readonly<{type: 'retry-start'; attempt: number; maxAttempts: number}>
    | Readonly<{type: 'aborted'}>

export type AiStreamPayload = Readonly<{
    requestId: number
    event: AiStreamEvent
}>

export type InitializationState =
    | Readonly<{status: 'initializing'; progress?: DownloadProgress}>
    | Readonly<{status: 'error'; message: string}>
    | Readonly<{status: 'ready'}>

export type StoredChat = Readonly<{
    taskId?: string
    messages: readonly Message[]
    agentMessages: readonly unknown[]
}>

/**
 * One AI tool call the backend's safety model would not run unattended. The call is blocked until
 * the user answers, so a prompt on screen is a paused agent, not a notification.
 */
/** One gated operation inside a call: what it would do, and what it would do it to. */
export type ToolApprovalCall = Readonly<{
    op: string
    reason: string
    params: Readonly<Record<string, unknown>>
}>

/**
 * Every gated operation of one tool call, asked as one question.
 *
 * A call is a list of operations, so a prompt is a list too. Asked one at a time, ten deletions
 * would arrive as ten dialogs, and only the ones already shown could be refused.
 */
export type ToolApprovalPrompt = Readonly<{
    approvalId: string
    tool: string
    calls: readonly ToolApprovalCall[]
}>

/** Emitted when a prompt stops waiting — answered, timed out, or cancelled with its turn. */
export type ToolApprovalSettled = Readonly<{
    approvalId: string
    approved: boolean
}>
