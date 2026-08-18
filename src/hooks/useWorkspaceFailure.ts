import {createContext, use} from 'react'

/**
 * Where a panel inside the frame says that something went wrong.
 *
 * There is one answer to "where does a workspace failure appear", and it is the frame's: its own
 * banner, and the conversation afterwards. That decision belongs to `InspectorFrame`, which is the
 * only thing that can see both places — so it is provided here rather than handed down, because a
 * panel given a reporting function as a prop cannot tell which of the two it received.
 *
 * It was two. The frame built a `report` that set its banner and forwarded to the conversation, and
 * then drilled the unforwarded one five components further down beside it. Monaco failing to load
 * wrote into the chat composer, which mounts only while the chat tab is open — and the editor that
 * raised it renders only while the scripts tab is. The message could not be on screen at the moment
 * it was written, and nothing said so.
 */
export type WorkspaceFailureSink = (message: string) => void

export const WorkspaceFailureContext = createContext<WorkspaceFailureSink | undefined>(undefined)

/**
 * The frame's failure sink.
 *
 * Like the editor session, there is no sensible reading of "no sink provided": a panel that cannot
 * report is a panel whose failures vanish. So this throws where the wiring is missing rather than
 * swallowing the message three renders later.
 */
export function useWorkspaceFailure(): WorkspaceFailureSink {
    const report = use(WorkspaceFailureContext)
    if (!report) throw new Error('This panel must be rendered inside a workspace failure sink.')
    return report
}
