import type {DownloadProgress} from '@mjasnikovs/gofer-rag'

export type Message = Readonly<{
    id: number
    sender: 'user' | 'assistant'
    text: string
    timestamp: number
    thinking?: string
    tools?: readonly ToolActivity[]
    usage?: TokenUsage
    model?: string
    status?: 'streaming' | 'complete' | 'error' | 'aborted'
    /**
     * What the turn is doing while it has nothing to show yet. Named in place of the generic
     * spinner label, so a long silent step reads as work rather than as a hang.
     */
    activity?: string
    attachments?: readonly ChatAttachment[]
}>

export type ChatAttachment = Readonly<{
    id: string
    name: string
    mimeType: string
    size: number
}>

export type DraftAttachment = ChatAttachment
    & Readonly<{
        data: string
        previewUrl: string
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
    output?: string
    status: 'pending' | 'running' | 'complete' | 'error'
    startedAt: number
    endedAt?: number
}>

export type AiStreamEvent =
    | Readonly<{type: 'text-delta'; delta: string}>
    | Readonly<{type: 'thinking-delta'; delta: string}>
    | Readonly<{type: 'tool-start'; id: string; name: string; target?: string; startedAt: number}>
    | Readonly<{type: 'tool-update'; id: string; output: string}>
    | Readonly<{type: 'tool-end'; id: string; output: string; isError: boolean; endedAt: number}>
    | Readonly<{type: 'usage'; usage: TokenUsage; model: string}>
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
export type ToolApprovalPrompt = Readonly<{
    approvalId: string
    tool: string
    op: string
    reason: string
    params: Readonly<Record<string, unknown>>
}>

/** Emitted when a prompt stops waiting — answered, timed out, or cancelled with its turn. */
export type ToolApprovalSettled = Readonly<{
    approvalId: string
    approved: boolean
}>
