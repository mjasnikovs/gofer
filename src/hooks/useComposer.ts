import {createContext, use} from 'react'
import type {DraftAttachment} from '../models/chat'
import type {AiModelOption, GoferSettings, ThinkingLevel} from '../models/settings'

export type ComposerTokenCounts = Readonly<{
    context: number
    total: number
}>

/** What the user has typed and attached, and what the last turn cost. */
export type ComposerState = Readonly<{
    draft: string
    draftAttachments: readonly DraftAttachment[]
    selectedModel: string
    streamError?: string | undefined
    thinkingLevel: ThinkingLevel
    usage: ComposerTokenCounts
}>

/** Everything the composer can ask the workspace to do. */
export type ComposerActions = Readonly<{
    applyModel: (model: AiModelOption, previous?: GoferSettings) => Promise<void>
    applyThinkingLevel: (level: ThinkingLevel, previous?: GoferSettings) => Promise<void>
    changeDraft: (value: string) => void
    removeAttachment: (attachmentId: string) => void
    selectAttachments: (files: FileList | null) => Promise<void>
    stop: () => void
    submit: (value: string) => Promise<void>
}>

/** What the connection allows and what the turn is doing, which decide what is enabled. */
export type ComposerMeta = Readonly<{
    canAttachImages: boolean
    contextWindow: number
    isSavingAttachments: boolean
    isStreaming: boolean
    models: readonly AiModelOption[]
    settings?: GoferSettings | undefined
    supportsImages: boolean
    thinkingLevels: readonly ThinkingLevel[]
}>

export type Composer = Readonly<{
    state: ComposerState
    actions: ComposerActions
    meta: ComposerMeta
}>

/**
 * The composer's own state, held where the composer is rather than relayed through it.
 *
 * The input, the attachment drawer, the model menu and the usage readout are four pieces of one
 * control that happen to be rendered in one file; passing each of them what it needs made the
 * component a twenty-two-parameter relay for values derived twenty lines above it. Every piece
 * reads what it uses from here instead, and the workspace publishes it once.
 */
export const ComposerContext = createContext<Composer | undefined>(undefined)

export function useComposer(): Composer {
    const composer = use(ComposerContext)
    if (!composer) throw new Error('A composer piece was rendered outside ComposerContext')
    return composer
}
