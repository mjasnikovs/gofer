export type CommandError = Readonly<{
    code: string
    message: string
    retryable: boolean
    readiness?: string | undefined
    details?: Readonly<Record<string, unknown>> | undefined
}>
