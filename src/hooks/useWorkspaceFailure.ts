import {createContext, use} from 'react'

export type WorkspaceFailureSink = (message: string) => void

export const WorkspaceFailureContext = createContext<WorkspaceFailureSink | undefined>(undefined)

export function useWorkspaceFailure(): WorkspaceFailureSink {
    const report = use(WorkspaceFailureContext)
    if (!report) throw new Error('This panel must be rendered inside a workspace failure sink.')
    return report
}
