import type {DownloadProgress} from '@mjasnikovs/gofer-rag'
import type {AnnotationShape} from './annotation'

export type MessagePart =
    | Readonly<{kind: 'text'; text: string}>
    | Readonly<{kind: 'thinking'; text: string}>
    | Readonly<{kind: 'tool'; toolId: string}>
    | Readonly<{kind: 'verify'}>

export type Message = Readonly<{
    id: number
    sender: 'user' | 'assistant'
    text: string
    timestamp: number
    thinking?: string
    tools?: readonly ToolActivity[]
    parts?: readonly MessagePart[]
    usage?: TokenUsage
    model?: string
    status?: 'streaming' | 'complete' | 'error' | 'aborted' | 'queued'
    activity?: string
    attachments?: readonly ChatAttachment[]
    verifyPoints?: readonly VerifyPoint[]
    compaction?: MessageCompaction
}>

// A field rather than a row of its own: storage refuses any sender but user and assistant, and
// carries unknown message fields through untouched.
export type MessageCompaction = Readonly<{
    messages: number
    tokensBefore: number
    tokensAfter: number
}>

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
    step?: string
    output?: string
    status: 'pending' | 'running' | 'complete' | 'error'
    startedAt: number
    endedAt?: number
    tokens?: number
}>

export type AiStreamEvent =
    | Readonly<{type: 'text-delta'; delta: string}>
    | Readonly<{type: 'thinking-delta'; delta: string}>
    | Readonly<{type: 'tool-start'; id: string; name: string; target?: string; startedAt: number}>
    | Readonly<{type: 'tool-update'; id: string; output: string; step?: string}>
    | Readonly<{type: 'tool-end'; id: string; output: string; isError: boolean; endedAt: number}>
    | Readonly<{type: 'usage'; usage: TokenUsage; model: string}>
    | Readonly<{type: 'tool-cost'; ids: readonly string[]; tokens: number}>
    | Readonly<{type: 'compaction-start'; tokens: number; contextWindow: number}>
    | Readonly<{type: 'compaction-end'}>
    | Readonly<{
          type: 'compact-done'
          agentMessages: readonly unknown[]
          summarised: number
          tokensBefore: number
          tokensAfter: number
      }>
    | Readonly<{
          type: 'done'
          text: string
          thinking: string
          stopReason?: string
          usage: TokenUsage
          model: string
          agentMessages: readonly unknown[]
      }>
    | Readonly<{
          type: 'verify-point'
          name: string
          command: string
          status: 'running' | 'complete' | 'error'
          index: number
          of: number
          output?: string
      }>
    | Readonly<{type: 'turn-state'; agentMessages: readonly unknown[]}>
    | Readonly<{type: 'context-rebuilt'; messages: number}>
    | Readonly<{
          type: 'retry-scheduled'
          attempt: number
          maxAttempts: number
          delayMs: number
          errorMessage: string
      }>
    | Readonly<{type: 'retry-start'; attempt: number; maxAttempts: number}>
    | Readonly<{type: 'steered'; id: string}>
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

export type ToolApprovalCall = Readonly<{
    op: string
    reason: string
    params: Readonly<Record<string, unknown>>
}>

export type ToolApprovalPrompt = Readonly<{
    approvalId: string
    tool: string
    calls: readonly ToolApprovalCall[]
}>

export type ToolApprovalSettled = Readonly<{
    approvalId: string
    approved: boolean
}>
