import type {SearchSource, SearchableItem} from '@astryxdesign/core/Typeahead'
import {mentionEntries, rankFileMentions} from '../models/file-mentions'
import type {FileMention} from '../models/file-mentions'
import {listWorkspaceFiles} from './workspace-files'

export type FileMentionItem = SearchableItem<FileMention>

type Listing = () => Promise<readonly {path: string}[]>

const LISTING_REUSE_MS = 5_000

function item(mention: FileMention): FileMentionItem {
    return {
        id: mention.isDirectory ? `${mention.path}/` : mention.path,
        label: mention.name,
        auxiliaryData: mention
    }
}

export function createFileMentionSource(
    list: Listing = listWorkspaceFiles,
    now: () => number = Date.now
): SearchSource<FileMentionItem> {
    let entries: readonly FileMention[] | undefined
    let readAt = Number.NEGATIVE_INFINITY
    let reading: Promise<void> | undefined
    let ranked = new Map<string, FileMentionItem[]>()

    const read = async () => {
        try {
            entries = mentionEntries((await list()).map(entry => entry.path))
        } catch {
            entries ??= []
        }
        readAt = now()
        ranked = new Map()
        reading = undefined
    }

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
        if (entries === undefined) return (first ?? Promise.resolve()).then(() => rank(query))
        return rank(query)
    }

    return {bootstrap: () => search(''), search}
}
