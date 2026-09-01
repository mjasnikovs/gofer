import {fileKind, isGeneratedSidecar} from './file-kinds'
import type {FileKind} from './file-kinds'

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'typeChanged' | 'other'

export type ChangedFile = Readonly<{
    path: string
    status: ChangeStatus
    fromPath?: string | null
    isBinary: boolean
    added: number
    removed: number
    isConflicted: boolean
}>

export type TaskChanges = Readonly<{
    files: readonly ChangedFile[]
    dropped: number
    isMerging: boolean
}>

export type FileDiff = Readonly<{
    path: string
    original: string
    modified: string
    isText: boolean
    isTooLarge: boolean
    isSubmodule: boolean
}>

export const NO_CHANGES: TaskChanges = {files: [], dropped: 0, isMerging: false}

/** The kinds worth offering as a filter, in the order a game is usually read. */
export const FILTER_KINDS: readonly FileKind[] = [
    'script',
    'scene',
    'resource',
    'image',
    'audio',
    'font',
    'text',
    'config',
    'file'
]

export const KIND_LABELS: Readonly<Record<FileKind, string>> = {
    folder: 'Folders',
    script: 'Scripts',
    scene: 'Scenes',
    resource: 'Resources',
    image: 'Images',
    audio: 'Audio',
    font: 'Fonts',
    text: 'Text',
    config: 'Config',
    file: 'Other'
}

export const STATUS_LABELS: Readonly<Record<ChangeStatus, string>> = {
    added: 'Added',
    modified: 'Modified',
    deleted: 'Deleted',
    renamed: 'Renamed',
    typeChanged: 'Type changed',
    other: 'Changed'
}

export function changedFileKind(file: ChangedFile): FileKind {
    return fileKind(file.path, false)
}

/**
 * Godot rewrites a `.import` or `.uid` beside every asset it touches, so they outnumber the work
 * they belong to. Hidden behind a toggle rather than dropped: a listing that quietly omits a
 * tracked change is worse than a noisy one.
 */
export function isGenerated(file: ChangedFile): boolean {
    return isGeneratedSidecar(file.path)
}

export function filterChanges(
    files: readonly ChangedFile[],
    kinds: readonly FileKind[],
    showGenerated: boolean
): readonly ChangedFile[] {
    return files.filter(file => {
        if (!showGenerated && isGenerated(file)) return false
        return kinds.length === 0 || kinds.includes(changedFileKind(file))
    })
}

export function countByKind(
    files: readonly ChangedFile[],
    showGenerated: boolean
): ReadonlyMap<FileKind, number> {
    const counts = new Map<FileKind, number>()
    for (const file of files) {
        if (!showGenerated && isGenerated(file)) continue
        const kind = changedFileKind(file)
        counts.set(kind, (counts.get(kind) ?? 0) + 1)
    }
    return counts
}
