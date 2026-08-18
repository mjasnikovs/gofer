import {useEffect, useMemo} from 'react'
import type {ChatComposerTrigger} from '@astryxdesign/core/Chat'
import {TypeaheadItem} from '@astryxdesign/core/Typeahead'
import {createFileMentionSource} from '../services/file-mentions'
import type {FileMention} from '../models/file-mentions'

/**
 * `@` names a file in the worktree.
 *
 * The message the agent receives holds the path as plain text — `@docs/TASK_CHECKLIST.md` — which
 * is the shape every tool in the catalogue already takes and the shape the model has read a
 * thousand times. Nothing is attached and nothing is read here: naming the file is the whole job,
 * and the agent decides whether to open it.
 *
 * The row shows the name over the directory, because a worktree holds `game.gd` three times and the
 * folder is what tells them apart.
 *
 * The worktree is listed at mount rather than at the first `@`, because the menu can only stay off
 * its loading state while the source can answer without waiting (`services/file-mentions.ts`).
 */
export function useFileMentionTrigger(): ChatComposerTrigger {
    const trigger = useMemo<ChatComposerTrigger>(
        () => ({
            character: '@',
            searchSource: createFileMentionSource(),
            renderItem: item => (
                <TypeaheadItem
                    item={item}
                    // A file at the top of the worktree has no directory to show under its name.
                    description={(item.auxiliaryData as FileMention | undefined)?.directory ?? ''}
                />
            ),
            onSelect: item => ({value: `@${item.id}`, label: item.id})
        }),
        []
    )
    useEffect(() => {
        void trigger.searchSource.bootstrap()
    }, [trigger])
    return trigger
}
