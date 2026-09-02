import {useMemo} from 'react'
import {createStaticSource} from '@astryxdesign/core/Typeahead'
import type {ChatComposerTrigger} from '@astryxdesign/core/Chat'

// The whole slash surface, spelled once. `Workspace` reads the same constant to spend it.
export const COMPACT_COMMAND = '/compact'

const COMMANDS = [
    {id: COMPACT_COMMAND, label: COMPACT_COMMAND, description: 'Summarise the conversation now'}
]

// The menu only writes text into the draft — a trigger cannot run an action. Submitting the
// finished line is what compacts, which is why the intercept lives beside the send instead.
export function useCompactCommandTrigger(): ChatComposerTrigger {
    return useMemo<ChatComposerTrigger>(
        () => ({
            character: '/',
            searchSource: createStaticSource(COMMANDS),
            menuLabel: 'Chat commands',
            emptySearchResultsText: 'No command matches',
            onSelect: item => item.id
        }),
        []
    )
}
