import {createContext, use} from 'react'

// The addition is measured against the live document, and is nothing when that document already
// carries the text.
export type ComposerAddition = (value: string) => string | undefined

/**
 * Writes an addition into the live document, and answers whether it could. A reference the user
 * asked for takes the caret with it; text the app is handing back does not, because the user may
 * be typing when it arrives.
 */
export type ComposerAppend = (addition: ComposerAddition, takesCaret: boolean) => boolean

export interface ComposerAppendRef {
    current: ComposerAppend | null
}

// The input owns the live document. Writing through the controlled value instead makes the composer
// rewrite that document as plain text, and every chip already in it is lost.
export const ComposerAppendContext = createContext<ComposerAppendRef | undefined>(undefined)

export function useComposerAppendRef(): ComposerAppendRef | undefined {
    return use(ComposerAppendContext)
}
