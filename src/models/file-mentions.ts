/**
 * Which worktree entries an `@` in the composer offers, and in what order.
 *
 * This is a port of the autocomplete the `pi` CLI puts behind its own `@`
 * (`@earendil-works/pi-tui`, `dist/autocomplete.js`), because that is the one the user browses with
 * every day. Three things make it feel like browsing rather than guessing:
 *
 * - **Folders are offered too.** The Rust scan only reports files (`src-tauri/src/files.rs`), so
 *   every folder here is derived from the paths above a file. Picking one steps into it.
 * - **A `/` scopes the search.** `@scripts/en` searches inside `scripts/`, and the rows are what
 *   lives there. Without a `/` the whole worktree answers.
 * - **The score is four fixed tiers, not a fuzzy match.** An exact name beats a name that starts
 *   with the query, which beats a name that holds it, which beats a hit anywhere in the path.
 *   What scored the same is ordered by how near it is, and a folder goes above a file beside it.
 *
 * The tiers replaced a subsequence match, which is the ranking the user called unintuitive: `@ge`
 * matched `addons/gut/enemy.gd`, so the rows moved for reasons the typist could not see. Tiers
 * cost the `taskch` → `TASK_CHECKLIST.md` trick and buy a menu whose order can be predicted from
 * the query alone.
 *
 * Kept as plain functions over strings so the ranking is held to a test rather than to a screenshot.
 */

import {isGeneratedSidecar} from './file-kinds'

/** One offered entry: a file, or a folder derived from the files under it. */
export type FileMention = Readonly<{
    /** The worktree-relative path. A folder carries no trailing slash here. */
    path: string
    /** The entry's own name, which is what the eye looks for first. */
    name: string
    /** The folder holding it, or `''` at the top level. */
    directory: string
    isDirectory: boolean
}>

/** How many suggestions a menu shows before it stops being a menu and becomes a listing. */
export const FILE_MENTION_LIMIT = 20

function split(path: string, isDirectory: boolean): FileMention {
    const cut = path.lastIndexOf('/')
    if (cut === -1) return {path, name: path, directory: '', isDirectory}
    return {path, name: path.slice(cut + 1), directory: path.slice(0, cut), isDirectory}
}

/**
 * Every file worth naming, plus every folder that holds one.
 *
 * Godot's own sidecars are dropped here (`isGeneratedSidecar`) — they are half the rows in an asset
 * folder and none of the answers. The folders are still derived from the full listing, because a
 * folder holding one is a folder holding the asset it belongs to.
 *
 * Built once per listing rather than per keystroke: a worktree of a few thousand files yields a few
 * hundred folders, and rebuilding that set on each letter is the difference between a menu that
 * answers on the same tick and one that does not.
 */
export function mentionEntries(files: readonly string[]): readonly FileMention[] {
    const directories = new Set<string>()
    for (const path of files) {
        let cut = path.indexOf('/')
        while (cut !== -1) {
            directories.add(path.slice(0, cut))
            cut = path.indexOf('/', cut + 1)
        }
    }
    const entries: FileMention[] = []
    for (const path of directories) entries.push(split(path, true))
    for (const path of files) {
        if (!isGeneratedSidecar(path)) entries.push(split(path, false))
    }
    return entries
}

/**
 * The entries an `@` query offers, best first.
 *
 * An empty query — the menu the moment `@` is typed, and the listing of a folder just stepped into
 * — scores everything the same, so the sort alone orders it: folders first, then whatever sits
 * closest to the top.
 */
export function rankFileMentions(
    entries: readonly FileMention[],
    query: string,
    limit: number = FILE_MENTION_LIMIT
): readonly FileMention[] {
    const wanted = query.toLowerCase()
    const cut = wanted.lastIndexOf('/')
    if (cut !== -1) {
        const scoped = collect(entries, wanted.slice(0, cut + 1), wanted.slice(cut + 1), limit)
        if (scoped.length > 0) return scoped
    }
    // No `/`, or a folder that is not there. The query is matched against whole paths instead,
    // which is what answers `scripts/game` typed straight through from memory.
    return collect(entries, '', wanted, limit)
}

function collect(
    entries: readonly FileMention[],
    base: string,
    needle: string,
    limit: number
): readonly FileMention[] {
    const scored: {mention: FileMention; score: number; depth: number}[] = []
    for (const mention of entries) {
        const lower = mention.path.toLowerCase()
        // A scoped query offers what is under the folder. The folder itself is already excluded:
        // `base` ends in `/` and no entry path carries one.
        if (base !== '' && !lower.startsWith(base)) continue
        const rest = lower.slice(base.length)
        const found = score(mention.name.toLowerCase(), rest, needle)
        if (found === undefined) continue
        scored.push({mention, score: found, depth: depth(rest)})
    }
    /*
     * Ties break towards what is nearest, then towards folders, then towards the alphabet.
     *
     * Depth outranks the folder preference, and that ordering is the whole of it. `pi` scores a
     * folder +10 outright, which reads fine until a project has thirty `addons/` packages: an empty
     * query then fills all twenty rows with folders from anywhere in the tree and `project.godot`
     * never appears. Sorting by depth first keeps the twenty rows to what is actually nearby, and
     * the folder preference still puts `scripts/` above `main.tscn` where they sit side by side.
     */
    scored.sort(
        (left, right) =>
            right.score - left.score
            || left.depth - right.depth
            || Number(right.mention.isDirectory) - Number(left.mention.isDirectory)
            || left.mention.path.localeCompare(right.mention.path)
    )
    return scored.slice(0, limit).map(entry => entry.mention)
}

/** The four tiers, or `undefined` when the entry does not match at all. */
function score(name: string, rest: string, needle: string): number | undefined {
    if (needle === '') return 1
    if (name === needle) return 100
    if (name.startsWith(needle)) return 80
    if (name.includes(needle)) return 50
    if (rest.includes(needle)) return 30
    return undefined
}

function depth(path: string) {
    let count = 0
    for (const character of path) if (character === '/') count += 1
    return count
}
