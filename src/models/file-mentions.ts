import {isGeneratedSidecar} from './file-kinds'

export type FileMention = Readonly<{
    path: string
    name: string
    directory: string
    isDirectory: boolean
}>

export const FILE_MENTION_LIMIT = 20

export function mentionValue(path: string) {
    return path.includes(' ') ? `@"${path}"` : `@${path}`
}

function split(path: string, isDirectory: boolean): FileMention {
    const cut = path.lastIndexOf('/')
    if (cut === -1) return {path, name: path, directory: '', isDirectory}
    return {path, name: path.slice(cut + 1), directory: path.slice(0, cut), isDirectory}
}

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
        if (base !== '' && !lower.startsWith(base)) continue
        const rest = lower.slice(base.length)
        const found = score(mention.name.toLowerCase(), rest, needle)
        if (found === undefined) continue
        scored.push({mention, score: found, depth: depth(rest)})
    }
    scored.sort(
        (left, right) =>
            right.score - left.score
            || left.depth - right.depth
            || Number(right.mention.isDirectory) - Number(left.mention.isDirectory)
            || left.mention.path.localeCompare(right.mention.path)
    )
    return scored.slice(0, limit).map(entry => entry.mention)
}

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
