import {createContext, use} from 'react'

// The addition is measured against the live document, and is nothing when that document already
// carries the text.
export type ComposerAddition = (value: string) => string | undefined

export type ComposerAppend = (addition: ComposerAddition) => void

export interface ComposerAppendRef {
    current: ComposerAppend | null
}

// The input owns the live document. Writing through the controlled value instead makes the composer
// rewrite that document as plain text, and every chip already in it is lost.
export const ComposerAppendContext = createContext<ComposerAppendRef | undefined>(undefined)

export function useComposerAppendRef(): ComposerAppendRef | undefined {
    return use(ComposerAppendContext)
}
