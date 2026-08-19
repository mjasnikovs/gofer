import type {SearchSource, SearchableItem} from '@astryxdesign/core/Typeahead'
import {mentionEntries, rankFileMentions} from '../models/file-mentions'
import type {FileMention} from '../models/file-mentions'
import {listWorkspaceFiles} from './workspace-files'

/**
 * One row of the `@` menu.
 *
 * `id` is the path, and a folder's carries a trailing `/`. That is what the row inserts, and it is
 * also what tells a folder from a file without reaching into `auxiliaryData` — two entries can
 * otherwise share a path, since a worktree may hold both a `build` folder and a `build` file.
 */
export type FileMentionItem = SearchableItem<FileMention>

type Listing = () => Promise<readonly {path: string}[]>

/**
 * How long a listing is kept before the next search reads the worktree again.
 *
 * The refresh happens behind the search, not in front of it: a stale listing still answers, and the
 * new one is in place for the next keystroke. A file the agent wrote during the same turn is
 * offered a moment later, which is the trade for a menu that never stops to fetch.
 */
const LISTING_REUSE_MS = 5_000

function item(mention: FileMention): FileMentionItem {
    return {
        id: mention.isDirectory ? `${mention.path}/` : mention.path,
        label: mention.name,
        auxiliaryData: mention
    }
}

/**
 * The `@` menu's search source: the worktree's files, ranked by `rankFileMentions`.
 *
 * Answers synchronously, which is the whole point. Astryx's trigger menu decides per keystroke
 * whether a source is async by calling `search('')` and looking at what comes back
 * (`useTriggerMenu.tsx`); a promise puts it on a 150 ms debounce and replaces the rows with
 * "Searching…" until it resolves. Typing is faster than that, so the menu spent its life on the
 * loading state — flickering, and holding no rows for Enter to choose from, which handed the Enter
 * back to the composer, which sent the half-typed message. An array comes back on the same tick and
 * none of that happens.
 *
 * So the worktree is read once the composer has mounted, through `bootstrap`, and every search
 * after that ranks what is already in memory. Only a search that arrives before that first read has
 * finished waits for it — which is why the composer bootstraps rather than waiting for an `@`.
 *
 * A workspace that cannot be listed answers with no files. There is nothing the user can do about
 * it from inside a typeahead, and an empty menu says "nothing to offer" without taking away the
 * message they were part-way through writing.
 */
export function createFileMentionSource(
    list: Listing = listWorkspaceFiles,
    now: () => number = Date.now
): SearchSource<FileMentionItem> {
    let entries: readonly FileMention[] | undefined
    let readAt = Number.NEGATIVE_INFINITY
    let reading: Promise<void> | undefined
    // Ranked rows for the listing in hand. The menu asks twice per keystroke — once with an empty
    // query to find out whether this source is sync, once with what was typed — so the empty query
    // alone would re-sort the whole worktree on every letter.
    let ranked = new Map<string, FileMentionItem[]>()

    const read = async () => {
        try {
            entries = mentionEntries((await list()).map(entry => entry.path))
        } catch {
            entries = []
        }
        readAt = now()
        ranked = new Map()
        reading = undefined
    }

    // One read at a time, however many searches ask for it.
    const refresh = () => {
        if (reading) return reading
        if (now() - readAt < LISTING_REUSE_MS) return undefined
        reading = read()
        return reading
    }

    const rank = (query: string): FileMentionItem[] => {
        const held = ranked.get(query)
        if (held) return held
        const rows = rankFileMentions(entries ?? [], query).map(item)
        ranked.set(query, rows)
        return rows
    }

    const search = (query: string) => {
        const first = refresh()
        // Nothing has been read yet, so there is nothing to answer with but the read itself.
        if (entries === undefined) return (first ?? Promise.resolve()).then(() => rank(query))
        return rank(query)
    }

    // `bootstrap` is what warms it. Nothing is read while the source is being built: the composer
    // builds it inside a `useMemo`, which StrictMode runs twice, and a read is not a thing to do
    // during a render.
    return {bootstrap: () => search(''), search}
}
