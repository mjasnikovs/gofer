/**
 * Which worktree files an `@` in the composer offers, and in what order.
 *
 * A file mention is typed from memory, not from a listing: someone reaching for
 * `docs/TASK_CHECKLIST.md` types `taskch`, and someone reaching for a script they saw once types
 * `enemybase`. A substring filter on the whole path answers neither, so the match is a subsequence
 * — every character of the query in order, anywhere in the path — and the ordering is what makes
 * that useful rather than noisy.
 *
 * Kept as plain functions over strings so the ranking is held to a test rather than to a screenshot.
 */

/** One offered file: the path it inserts, split for the row that shows it. */
export type FileMention = Readonly<{
    path: string
    /** The file's own name, which is what the eye looks for first. */
    name: string
    /** The directory holding it, or `''` at the top level. */
    directory: string
}>

/** How many suggestions a menu shows before it stops being a menu and becomes a listing. */
export const FILE_MENTION_LIMIT = 20

const WORD_BOUNDARIES = new Set(['/', '_', '-', '.', ' '])

export function splitMentionPath(path: string): FileMention {
    const cut = path.lastIndexOf('/')
    if (cut === -1) return {path, name: path, directory: ''}
    return {path, name: path.slice(cut + 1), directory: path.slice(0, cut)}
}

/**
 * What one path scores against one query, or `undefined` when it does not match at all.
 *
 * The bonuses are the whole ranking, and each one is a way a person types a path they remember:
 * they type consecutive characters (`contiguous`), they type the starts of the words
 * (`boundary` — after `/`, `_`, `-` or `.`), and they type the file's own name far more often than
 * the folders above it (`basename`). Length breaks ties towards the shorter path, so `game.gd`
 * comes before `addons/vendor/game.gd` when both match equally well.
 */
function score(path: string, query: string): number | undefined {
    const haystack = path.toLowerCase()
    const basenameFrom = haystack.lastIndexOf('/') + 1
    let total = 0
    let cursor = 0
    let previous = -2
    for (const wanted of query) {
        const found = haystack.indexOf(wanted, cursor)
        if (found === -1) return undefined
        total += 1
        if (found === previous + 1) total += 8
        if (found === 0 || WORD_BOUNDARIES.has(haystack.charAt(found - 1))) total += 6
        if (found >= basenameFrom) total += 4
        previous = found
        cursor = found + 1
    }
    return total - path.length / 100
}

/**
 * The files an `@` query offers, best first.
 *
 * An empty query is the menu the user sees before typing anything, so it is ordered by depth and
 * then by name: the project's own files first, and whatever a package manager or the engine left in
 * a nested directory last.
 */
export function rankFileMentions(
    paths: readonly string[],
    query: string,
    limit: number = FILE_MENTION_LIMIT
): readonly FileMention[] {
    const wanted = query.toLowerCase().replaceAll(' ', '')
    if (wanted === '') {
        return [...paths]
            .sort((left, right) => depth(left) - depth(right) || left.localeCompare(right))
            .slice(0, limit)
            .map(splitMentionPath)
    }
    const scored: {path: string; score: number}[] = []
    for (const path of paths) {
        const found = score(path, wanted)
        if (found !== undefined) scored.push({path, score: found})
    }
    scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    return scored.slice(0, limit).map(entry => splitMentionPath(entry.path))
}

function depth(path: string) {
    let count = 0
    for (const character of path) if (character === '/') count += 1
    return count
}
