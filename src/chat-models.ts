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

export type GodotProcessEvent = Readonly<{
    runId: string
    eventType: 'started' | 'line' | 'finished'
    level?: 'info' | 'warning' | 'error'
    message?: string
    exitCode?: number
}>
