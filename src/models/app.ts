export type Page = 'workspace' | 'settings'

/**
 * An optional field of a task, as it arrives.
 *
 * Rust serializes an absent `Option` as `null`, and a task whose branch has never been merged
 * carries exactly that. Typing these as `string | undefined` and checking for `undefined` alone
 * rejected every task Gofer has ever created — which the sidebar showed by listing none of them.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An optional string, absent as either `undefined` or the `null` the backend actually sends. */
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
