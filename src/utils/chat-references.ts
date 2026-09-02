import {mentionValue} from '../models/file-mentions'

export type ChatReferenceKind = 'node' | 'file' | 'asset'

export type ChatReference = Readonly<{
    kind: ChatReferenceKind
    id: string
    detail?: string | undefined
}>

const KIND_WORD: Readonly<Record<ChatReferenceKind, string>> = {
    node: 'node',
    file: 'file',
    asset: 'asset'
}

export function referenceText(reference: ChatReference): string {
    if (reference.kind === 'file') return mentionValue(reference.id)
    const detail = reference.detail === undefined ? '' : ` (${reference.detail})`
    return `${KIND_WORD[reference.kind]} \`${reference.id}\`${detail}`
}

function names(draft: string, text: string): boolean {
    let at = draft.indexOf(text)
    while (at !== -1) {
        const after = draft[at + text.length]
        if (after === undefined || /\s/.test(after)) return true
        at = draft.indexOf(text, at + 1)
    }
    return false
}

export function referenceInsertion(draft: string, reference: ChatReference): string | undefined {
    const text = referenceText(reference)
    if (names(draft, text)) return undefined
    if (draft === '' || /\s$/.test(draft)) return `${text} `
    return ` ${text} `
}
