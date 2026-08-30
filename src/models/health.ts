export type HealthStatus = 'ok' | 'degraded' | 'blocked'

export type WorkspaceSource = 'environment' | 'configured' | 'working-directory'

export type RemedyAction =
    | 'choose-workspace'
    | 'initialize-git-repository'
    | 'set-git-identity'
    | 'commit-project-files'
    | 'stop-tracking-editor-cache'
    | 'create-godot-project'
    | 'locate-godot-binary'

export type RemedyInput = 'none' | 'directory' | 'file'

export type HealthRemedy = Readonly<{
    action: RemedyAction
    label: string
    description: string
    input: RemedyInput
}>

export type HealthCheck = Readonly<{
    id: string
    title: string
    status: HealthStatus
    detail: string
    remedy?: HealthRemedy
}>

export type HealthReport = Readonly<{
    workspace: string
    workspaceSource: WorkspaceSource
    checks: readonly HealthCheck[]
    isReady: boolean
}>

export type HealthRemedyRequest = Readonly<{
    action: RemedyAction
    path?: string | undefined
}>

export function statusVariant(status: HealthStatus) {
    if (status === 'ok') return 'success' as const
    if (status === 'degraded') return 'warning' as const
    return 'error' as const
}

export function statusLabel(status: HealthStatus) {
    if (status === 'ok') return 'Ready'
    if (status === 'degraded') return 'Limited'
    return 'Blocked'
}

export function blockingChecks(report: HealthReport) {
    return report.checks.filter(check => check.status === 'blocked')
}

export function blockingSummary(report: HealthReport) {
    const blocking = blockingChecks(report)
    if (blocking.length === 0) return 'Everything Gofer needs is in place.'
    if (blocking.length === 1) return `${blocking[0]?.title ?? 'One check'} needs your attention.`
    return `${String(blocking.length)} things need your attention before Gofer can work here.`
}
