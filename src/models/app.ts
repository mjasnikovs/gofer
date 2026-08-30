export type Page = 'workspace' | 'settings'

type Absent = null | undefined

type TaskWorktreeSummary = Readonly<{
    branchName: string
    worktreePath: string
    baseCommit: string
    headCommit?: string | Absent
    mergedCommit?: string | Absent
}>

export type TaskSummary = Readonly<{
    id: string
    title: string
    status: 'active' | 'completed'
    isCurrent: boolean
    createdAt: number
    updatedAt: number
    worktree?: TaskWorktreeSummary | Absent
}>

export type PendingChange = Readonly<{
    path: string
    isNew: boolean
}>

export function isPendingChange(value: unknown): value is PendingChange {
    if (!isRecord(value)) return false
    return typeof value['path'] === 'string' && typeof value['isNew'] === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionalText(value: unknown) {
    return value === undefined || value === null || typeof value === 'string'
}

function isTaskWorktreeSummary(value: unknown): value is TaskWorktreeSummary {
    if (!isRecord(value)) return false
    return (
        typeof value['branchName'] === 'string'
        && typeof value['worktreePath'] === 'string'
        && typeof value['baseCommit'] === 'string'
        && isOptionalText(value['headCommit'])
        && isOptionalText(value['mergedCommit'])
    )
}

export function isTaskSummary(value: unknown): value is TaskSummary {
    if (!isRecord(value)) return false
    return (
        typeof value['id'] === 'string'
        && typeof value['title'] === 'string'
        && (value['status'] === 'active' || value['status'] === 'completed')
        && typeof value['isCurrent'] === 'boolean'
        && typeof value['createdAt'] === 'number'
        && typeof value['updatedAt'] === 'number'
        && (value['worktree'] === undefined
            || value['worktree'] === null
            || isTaskWorktreeSummary(value['worktree']))
    )
}
