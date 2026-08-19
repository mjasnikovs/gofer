import {useEffect, useMemo} from 'react'
import type {ChatComposerTrigger} from '@astryxdesign/core/Chat'
import {FileMentionRow} from '../components/workspace/FileMentionRow'
import {createFileMentionSource} from '../services/file-mentions'

/**
 * `@` names a file or a folder in the worktree, the way `pi`'s own `@` does.
 *
 * The message the agent receives holds the path as plain text — `@docs/TASK_CHECKLIST.md` — which
 * is the shape every tool in the catalogue already takes and the shape the model has read a
 * thousand times. Nothing is attached and nothing is read here: naming the file is the whole job,
 * and the agent decides whether to open it.
 *
 * Picking a folder inserts `@scripts/` and no more, so the next row is what lives in `scripts/` and
 * the one after that is what lives inside that. Picking a file ends it. That is the browsing the
 * old menu had no way to do, because it was never offered a folder to step into.
 *
 * The row shows the file's kind — a thumbnail for a picture, an icon for everything else — over
 * the folder holding it, because a worktree holds `game.gd` three times (`FileMentionRow`).
 *
 * The worktree is listed at mount rather than at the first `@`, because the menu can only stay off
 * its loading state while the source can answer without waiting (`services/file-mentions.ts`).
 */

/**
 * A path with a space in it is quoted, so the agent reads one argument rather than two.
 *
 * The menu can offer such a path but the composer can never be typed towards one: Astryx's
 * `findActiveTrigger` abandons the trigger at the first space, so `@my ` closes the menu. Quoting
 * fixes the message; it does not make a folder with a space in its name steppable.
 */
function mentionValue(path: string) {
    return path.includes(' ') ? `@"${path}"` : `@${path}`
}

export function useFileMentionTrigger(): ChatComposerTrigger {
    const trigger = useMemo<ChatComposerTrigger>(
        () => ({
            character: '@',
            searchSource: createFileMentionSource(),
            menuLabel: 'Workspace files and folders',
            emptySearchResultsText: 'No file or folder matches',
            renderItem: item => <FileMentionRow item={item} />,
            onSelect: item => {
                // A folder's id carries the trailing slash, which is both the mark of a folder and
                // the text that scopes the next search. One holding a space cannot be stepped into
                // at all, so it ends the mention the way a file does rather than leaving behind
                // text the reopened menu will refuse and the agent cannot resolve.
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

/**
 * Opens the menu again after a folder has been stepped into.
 *
 * Astryx closes it on every pick — `useTriggerMenu.selectItem` ends in `reset()` — and only looks
 * for a trigger again on the editable's `input` event, which `insertTextAtCursor` never raises. So
 * the event is dispatched by hand, a turn of the task queue later so the close has already landed:
 * reopening into a menu still marked open updates the query and leaves the popover hidden.
 *
 * The editable is the focused element because it never stopped being one — Astryx cancels the
 * mousedown on a row for exactly that reason, and a pick made with Enter never moved focus at all.
 */
function reopenMenu() {
    setTimeout(() => {
        const editable = document.activeElement
        if (!(editable instanceof HTMLElement)) return
        if (editable.getAttribute('contenteditable') !== 'true') return
        collapseIntoInsertedText()
        editable.dispatchEvent(new Event('input', {bubbles: true}))
    }, 0)
}

/**
 * Puts the caret back inside the text that was just inserted.
 *
 * `insertTextAtCursor` ends on `range.setStartAfter(textNode)`, which leaves the caret in the
 * editable *element* at the index past that node rather than in the node itself. Astryx's own
 * `getTextBeforeCursor` reads text nodes only and gives up on anything else, so the reopened menu
 * would find no trigger and stay shut. Stepping the caret back one child fixes it, and that child
 * is always the text just written.
 */
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
