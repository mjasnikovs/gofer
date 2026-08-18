/**
 * The one shape a rejected desktop command comes back in.
 *
 * Tauri hands a serialized `Err` straight to the promise rejection, so an object carrying a string
 * `code` and `message` is the backend's own structured failure and anything else — a thrown
 * `Error`, a transport fault, a renderer bug — is not. `code` is what the UI is allowed to branch
 * on; `message` is the only part a user ever reads.
 */
export type CommandError = Readonly<{
    code: string
    message: string
    retryable: boolean
    readiness?: string | undefined
    details?: Readonly<Record<string, unknown>> | undefined
}>
