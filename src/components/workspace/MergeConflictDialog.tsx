import {AlertDialog} from '@astryxdesign/core/AlertDialog'

export type MergeConflictMode = 'clashed' | 'unfinished'

type MergeConflictDialogProps = Readonly<{
    conflicts: readonly string[]
    mode: MergeConflictMode
    onResolve: () => void
    onDiscard: () => void
    onDismiss: () => void
}>

const NAMED_CONFLICTS = 6

function namedConflicts(conflicts: readonly string[]) {
    const shown = conflicts.slice(0, NAMED_CONFLICTS).join(', ')
    const rest = conflicts.length - NAMED_CONFLICTS
    return rest > 0 ? `${shown} and ${String(rest)} more` : shown
}

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
            actionVariant={unfinished ? 'destructive' : 'primary'}
            cancelLabel={unfinished ? 'Leave it open' : 'Leave it to me'}
            onAction={unfinished ? onDiscard : onResolve}
            onOpenChange={isOpen => {
                if (!isOpen) onDismiss()
            }}
        />
    )
}
