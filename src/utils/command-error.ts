import type {CommandError} from '../models/errors'

/**
 * Restores the structured failure the backend rejected with.
 *
 * Anything that is not one — a thrown `Error`, a transport fault — becomes `command_failed`, so a
 * caller always has a code to branch on and a sentence to show, and never has to ask which kind of
 * failure it is holding.
 */
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

/**
 * The sentence to show the user.
 *
 * `String(error)` on a structured rejection prints `[object Object]`, which is what every one of
 * these call sites did before the commands started answering with a code.
 */
export function commandErrorMessage(error: unknown): string {
    return toCommandError(error).message
}
