import type {CommandError} from '../models/errors'

export function toCommandError(error: unknown): CommandError {
    if (typeof error === 'object' && error !== null && 'code' in error && 'message' in error) {
        const candidate = error as Partial<CommandError>
        if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
            return {
                code: candidate.code,
                message: candidate.message,
                retryable: candidate.retryable === true,
                details: candidate.details ?? {}
            }
        }
    }
    return {code: 'command_failed', message: String(error), retryable: false, details: {}}
}

export function commandErrorMessage(error: unknown): string {
    return toCommandError(error).message
}
