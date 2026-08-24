import {AlertDialog} from '@astryxdesign/core/AlertDialog'

/**
 * Which of the two merge failures the user is looking at.
 *
 * `clashed` is a merge Git would not start: both branches changed the same files and nothing has
 * happened yet. `unfinished` is a resolution that was started and stopped part-way, so the task is
 * sitting on an open merge whose files still hold both versions. They read alike and the way out of
 * each is the opposite of the other's — hand it to the agent, or throw it away.
 */
export type MergeConflictMode = 'clashed' | 'unfinished'

type MergeConflictDialogProps = Readonly<{
    /** The files that clashed. An empty list is no dialog at all. */
    conflicts: readonly string[]
    mode: MergeConflictMode
    onResolve: () => void
    onDiscard: () => void
    onDismiss: () => void
}>

/** At most this many paths are named before the list stops being readable. */
const NAMED_CONFLICTS = 6

function namedConflicts(conflicts: readonly string[]) {
    const shown = conflicts.slice(0, NAMED_CONFLICTS).join(', ')
    const rest = conflicts.length - NAMED_CONFLICTS
    return rest > 0 ? `${shown} and ${String(rest)} more` : shown
}

/**
 * The way out of a merge Git could not do on its own.
 *
 * A conflict is not a fault: the task and the project both did real work on the same file, and
 * somebody has to say which wins. Before this the user was told that and nothing else — the merge
 * had already been aborted, and the only thing left to try was pressing Merge again, which fails
 * identically. The agent is the somebody: accepting brings the project's branch into the task, so
 * the clashing files land in the worktree holding both versions, and asks it to reconcile them.
 *
 * Rejecting leaves the task exactly as it was, which is what the aborted merge already left behind.
 *
 * A resolution that then stops part-way is the state this feature can create and nothing else can,
 * so the same window has to answer for it: every later merge is refused, and the file the agent
 * gave up on is not something a user is going to fix by pressing Merge again. Discarding puts the
 * task back where it started, which is where the failed merge had already left it.
 */
export function MergeConflictDialog({
    conflicts,
    mode,
    onResolve,
    onDiscard,
    onDismiss
}: MergeConflictDialogProps) {
    if (conflicts.length === 0) return null
    const unfinished = mode === 'unfinished'
    return (
        <AlertDialog
            isOpen
            title={unfinished ? 'Discard the unfinished merge?' : 'Let Gofer resolve the merge?'}
            description={
                unfinished ?
                    `This task is part-way through a merge and ${namedConflicts(conflicts)} still hold both versions. Nothing can be committed or merged until they are resolved. Discarding puts the task back exactly where it was before the merge started.`
                :   `The task and the project both changed ${namedConflicts(conflicts)}. Gofer can bring the project's branch into this task and reconcile them, then you can merge again. Nothing is committed while a file still holds both versions.`
            }
            actionLabel={unfinished ? 'Discard the merge' : 'Let Gofer resolve it'}
            // Only one of these two branches throws work away. Left at the default both were
            // destructive, so bringing the project's branch in — which commits nothing — was
            // painted exactly like discarding a merge in progress.
            actionVariant={unfinished ? 'destructive' : 'primary'}
            cancelLabel={unfinished ? 'Leave it open' : 'Leave it to me'}
            onAction={unfinished ? onDiscard : onResolve}
            onOpenChange={isOpen => {
                if (!isOpen) onDismiss()
            }}
        />
    )
}
