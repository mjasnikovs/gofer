import {useCallback, useEffect, useMemo} from 'react'
import type {KeyboardEvent} from 'react'
import type {ChatComposerTrigger} from '@astryxdesign/core/Chat'
import {FileMentionRow} from '../components/workspace/FileMentionRow'
import {mentionValue} from '../models/file-mentions'
import {createFileMentionSource} from '../services/file-mentions'

const NBSP = '\u00A0'

export type FileMentionTrigger = Readonly<{
    trigger: ChatComposerTrigger
    onKeyDown: (event: KeyboardEvent) => void
}>

export function useFileMentionTrigger(): FileMentionTrigger {
    const trigger = useMemo<ChatComposerTrigger>(
        () => ({
            character: '@',
            searchSource: createFileMentionSource(),
            menuLabel: 'Workspace files and folders',
            emptySearchResultsText: 'No file or folder matches',
            renderItem: item => <FileMentionRow item={item} />,
            onSelect: item => {
                if (item.id.endsWith('/') && !item.id.includes(' ')) {
                    reopenMenu()
                    return `@${item.id}`
                }
                return {value: mentionValue(item.id), label: item.id}
            }
        }),
        []
    )

    useEffect(() => {
        void trigger.searchSource.bootstrap()
    }, [trigger])

    // The composer parks a non-breaking space behind every chip, and its own scan for the trigger
    // counts only a plain space as a word boundary. Typing that space is what lets a mention start
    // straight off the chip before it, instead of needing a character typed between the two.
    const onKeyDown = useCallback(
        (event: KeyboardEvent) => {
            if (event.key !== trigger.character) return
            // AltGr types @ on German, Polish, Spanish and Nordic layouts, and the browser reports
            // it as ctrl+alt, so those two cannot simply be ruled out.
            if (event.metaKey) return
            if ((event.altKey || event.ctrlKey) && !event.getModifierState('AltGraph')) return
            const editable = event.currentTarget
            if (!(editable instanceof HTMLElement)) return
            const selection = window.getSelection()
            if (!selection?.isCollapsed || selection.rangeCount === 0) return
            const range = selection.getRangeAt(0)
            if (!editable.contains(range.startContainer)) return
            if (!followsChip(range)) return
            event.preventDefault()
            insertAtCaret(range, ` ${trigger.character}`)
            editable.dispatchEvent(new Event('input', {bubbles: true}))
        },
        [trigger]
    )

    return {trigger, onKeyDown}
}

// The browser writes the same non-breaking space for a space typed at the end of a line, so the
// space alone does not say a chip is behind the caret. Only the one the composer parked does.
function followsChip(range: Range): boolean {
    const {startContainer, startOffset} = range
    const isText = startContainer.nodeType === Node.TEXT_NODE
    if (isText && startOffset !== 1) return false
    const space = isText ? startContainer : startContainer.childNodes[startOffset - 1]
    if (space?.nodeType !== Node.TEXT_NODE || space.textContent !== NBSP) return false
    const chip = space.previousSibling
    return chip instanceof HTMLElement && chip.hasAttribute('data-astryx-token')
}

function insertAtCaret(range: Range, text: string) {
    const inserted = document.createTextNode(text)
    range.insertNode(inserted)
    const moved = document.createRange()
    moved.setStart(inserted, inserted.length)
    moved.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(moved)
}

function reopenMenu() {
    setTimeout(() => {
        const editable = document.activeElement
        if (!(editable instanceof HTMLElement)) return
        if (editable.getAttribute('contenteditable') !== 'true') return
        collapseIntoInsertedText()
        editable.dispatchEvent(new Event('input', {bubbles: true}))
    }, 0)
}

function collapseIntoInsertedText() {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (range.startContainer.nodeType === Node.TEXT_NODE) return
    const inserted = range.startContainer.childNodes[range.startOffset - 1]
    if (inserted?.nodeType !== Node.TEXT_NODE) return
    const moved = document.createRange()
    moved.setStart(inserted, inserted.textContent?.length ?? 0)
    moved.collapse(true)
    selection.removeAllRanges()
    selection.addRange(moved)
}
