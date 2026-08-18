import {createContext, use} from 'react'
import type {AnnotationShape} from '../models/annotation'
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
    /** Attaches the clipboard's image, for the paste the webview delivers empty. */
    attachClipboardImage: () => Promise<void>
    applyThinkingLevel: (level: ThinkingLevel, previous?: GoferSettings) => Promise<void>
    changeDraft: (value: string) => void
    /** Replaces one attachment's bytes with the drawn-on version, keeping the strokes beside them. */
    editAttachment: (
        attachmentId: string,
        file: File,
        shapes: readonly AnnotationShape[]
    ) => Promise<void>
    /**
     * Plans what is typed instead of sending it.
     *
     * Offered only for a task's first message, and only until one has been sent — see
     * `meta.isPlanOffered`. The attached images go with it, the same way Send takes them: the plan
     * is asked about the picture, and the turn its specification starts is sent the picture too.
     */
    plan: (value: string) => Promise<void>
    removeAttachment: (attachmentId: string) => void
    /** Takes a `FileList` from the picker and a plain array from a paste, which has no list. */
    selectAttachments: (files: FileList | readonly File[] | null) => Promise<void>
    stop: () => void
    submit: (value: string) => Promise<void>
}>

/** What the connection allows and what the turn is doing, which decide what is enabled. */
export type ComposerMeta = Readonly<{
    canAttachImages: boolean
    contextWindow: number
    isSavingAttachments: boolean
    /**
     * Whether planning is still on the table.
     *
     * True only while the task has no messages, no plan has been started, and the stored chat has
     * been read. The first message settles it either way: send one and the control goes, plan one
     * and it goes with the run it started.
     */
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
