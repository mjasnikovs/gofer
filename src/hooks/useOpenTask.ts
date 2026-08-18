import {createContext, use} from 'react'

/** Sends the window to another task, and makes it the one the backend works in. */
export type OpenTask = (taskId: string) => void

/**
 * How something deep in the frame offers to switch tasks.
 *
 * The sidebar is the ordinary way, and it owns the route. But a failure inside the workspace can be
 * *about* another task — the editor session belongs to one — and naming that task without offering
 * to go there leaves the user to find it in a list by hand, which is the part they were stuck on.
 *
 * Absent means there is no route to move: a panel test mounts one panel alone, and a control that
 * cannot navigate is left undrawn rather than drawn broken.
 */
export const OpenTaskContext = createContext<OpenTask | undefined>(undefined)

export function useOpenTask(): OpenTask | undefined {
    return use(OpenTaskContext)
}
