import {createContext, use} from 'react'
import type {AnnotationShape} from '../models/annotation'
import type {DraftAttachment} from '../models/chat'
import type {AiModelOption, GoferSettings, ThinkingLevel} from '../models/settings'

export type ComposerTokenCounts = Readonly<{
    context: number
    total: number
}>

export type ComposerState = Readonly<{
    draft: string
    draftAttachments: readonly DraftAttachment[]
    selectedModel: string
    streamError?: string | undefined
    thinkingLevel: ThinkingLevel
    usage: ComposerTokenCounts
}>

export type ComposerActions = Readonly<{
    applyModel: (model: AiModelOption, previous?: GoferSettings) => Promise<void>
    attachClipboardImage: () => Promise<void>
    applyThinkingLevel: (level: ThinkingLevel, previous?: GoferSettings) => Promise<void>
    changeDraft: (value: string) => void
    editAttachment: (
        attachmentId: string,
        file: File,
        shapes: readonly AnnotationShape[]
    ) => Promise<void>
    plan: (value: string) => Promise<void>
    removeAttachment: (attachmentId: string) => void
    selectAttachments: (files: FileList | readonly File[] | null) => Promise<void>
    stop: () => void
    submit: (value: string) => Promise<void>
}>

export type ComposerMeta = Readonly<{
    canAttachImages: boolean
    contextWindow: number
    isSavingAttachments: boolean
    isPlanOffered: boolean
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

export const ComposerContext = createContext<Composer | undefined>(undefined)

export function useComposer(): Composer {
    const composer = use(ComposerContext)
    if (!composer) throw new Error('A composer piece was rendered outside ComposerContext')
    return composer
}
