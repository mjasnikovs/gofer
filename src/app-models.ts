export type Page = 'workspace' | 'settings'

type TaskWorktreeSummary = Readonly<{
    branchName: string
    worktreePath: string
    baseCommit: string
    headCommit?: string
    mergedCommit?: string
}>

export type TaskSummary = Readonly<{
    id: string
    title: string
    status: 'active' | 'completed'
    isCurrent: boolean
    createdAt: number
    updatedAt: number
    worktree?: TaskWorktreeSummary
}>

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTaskWorktreeSummary(value: unknown): value is TaskWorktreeSummary {
    if (!isRecord(value)) return false
    return (
        typeof value['branchName'] === 'string'
        && typeof value['worktreePath'] === 'string'
        && typeof value['baseCommit'] === 'string'
        && (value['headCommit'] === undefined || typeof value['headCommit'] === 'string')
        && (value['mergedCommit'] === undefined || typeof value['mergedCommit'] === 'string')
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
        && (value['worktree'] === undefined || isTaskWorktreeSummary(value['worktree']))
    )
}
