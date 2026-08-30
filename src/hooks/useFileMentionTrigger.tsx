import {useEffect, useMemo} from 'react'
import type {ChatComposerTrigger} from '@astryxdesign/core/Chat'
import {FileMentionRow} from '../components/workspace/FileMentionRow'
import {mentionValue} from '../models/file-mentions'
import {createFileMentionSource} from '../services/file-mentions'

export function useFileMentionTrigger(): ChatComposerTrigger {
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

    return trigger
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
