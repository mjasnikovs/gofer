import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import type {ToolApprovalPrompt} from '../../models/chat'

type ToolApprovalDialogProps = Readonly<{
    prompt?: ToolApprovalPrompt | undefined
    onRespond: (approvalId: string, approved: boolean) => void
}>

/** The parameter that says what the operation would act on, so the dialog names it. */
function approvalTarget(params: Readonly<Record<string, unknown>>) {
    const named = ['path', 'from', 'setting', 'plugin', 'name']
        .map(key => params[key])
        .find(value => typeof value === 'string' && value.length > 0)
    if (typeof named !== 'string') return undefined
    const destination = params['to']
    return typeof destination === 'string' ? `${named} → ${destination}` : named
}

/**
 * Asks the user about one AI tool call the safety model stopped.
 *
 * Only the oldest pending prompt is shown: the agent's other tool calls keep running, but a stack
 * of dialogs would make approving the wrong one too easy. Dismissing counts as a refusal, because
 * the blocked call has to be told something either way.
 */
export function ToolApprovalDialog({prompt, onRespond}: ToolApprovalDialogProps) {
    if (!prompt) return null
    const target = approvalTarget(prompt.params)
    const operation = `${prompt.tool} ${prompt.op.replace(/_/gu, ' ')}`
    return (
        <AlertDialog
            isOpen
            title={`Approve ${operation}?`}
            description={`${prompt.reason} The agent is waiting to run ${operation}${target ? ` on ${target}` : ''}.`}
            actionLabel='Approve'
            cancelLabel='Reject'
            onAction={() => {
                onRespond(prompt.approvalId, true)
            }}
            onOpenChange={isOpen => {
                if (!isOpen) onRespond(prompt.approvalId, false)
            }}
        />
    )
}
