import {useCallback, useEffect, useRef} from 'react'
import type {RefObject} from 'react'
import type {ChatComposerInputHandle} from '@astryxdesign/core/Chat'
import {useComposerAppendRef} from './useComposerAppend'

/**
 * Claims the append channel for whichever field is on screen, and gives it back on the way out.
 *
 * A waiting question replaces the composer, so without the handover a reference the user asked for
 * lands in a draft nobody can see. Returns the root ref the field has to be given.
 */
export function useAppendTarget(handle: RefObject<ChatComposerInputHandle | null>) {
    const appendRef = useComposerAppendRef()
    const root = useRef<HTMLDivElement | null>(null)
    const keepRoot = useCallback((node: HTMLDivElement | null) => {
        root.current = node
    }, [])

    useEffect(() => {
        if (!appendRef) return
        const previous = appendRef.current
        appendRef.current = (addition, takesCaret) => {
            const input = handle.current
            const editable = root.current?.querySelector<HTMLElement>('[contenteditable="true"]')
            // React nulls a ref before it runs this effect's cleanup, so the caller has to be told
            // the document is gone rather than have its text quietly dropped.
            if (!input || !editable) return false
            const added = addition(input.getValue())
            if (added !== undefined) {
                const resume = takesCaret ? undefined : caretNow(editable)
                input.focus()
                caretToEnd(editable)
                input.insertText(added)
                editable.dispatchEvent(new Event('input', {bubbles: true}))
                resume?.()
            }
            return true
        }
        return () => {
            appendRef.current = previous
        }
    }, [appendRef, handle])

    return keepRoot
}

/**
 * Remembers where the caret and the focus are, for text arriving on its own rather than because
 * the user asked for it. The addition lands past everything already written, so an offset taken
 * before it survives it.
 */
function caretNow(editable: HTMLElement): (() => void) | undefined {
    const focused = document.activeElement
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return undefined
    const range = selection.getRangeAt(0).cloneRange()
    if (!editable.contains(range.startContainer)) return undefined
    return () => {
        selection.removeAllRanges()
        selection.addRange(range)
        if (focused instanceof HTMLElement && focused !== editable) focused.focus()
    }
}

// insertText writes at the live caret and deletes whatever is selected. The addition is measured
// against the end of the document, so the caret has to be there before it lands.
function caretToEnd(editable: HTMLElement) {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(editable)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
}
