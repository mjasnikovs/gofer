import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import type {ToolApprovalCall, ToolApprovalPrompt} from '../../models/chat'

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

/** One gated operation as a line the user reads: what it is, and what it would act on. */
function approvalLine(tool: string, call: ToolApprovalCall) {
    const target = approvalTarget(call.params)
    return `${tool} ${call.op.replace(/_/gu, ' ')}${target ? ` on ${target}` : ''}`
}

/**
 * Asks the user about one AI tool call the safety model stopped.
 *
 * A call holds a list of operations, so the dialog names every gated one it holds. Asking per
 * operation would put a list of ten deletions in front of the user as ten dialogs, of which only
 * the ones already shown could be refused — the rest would have run while they read.
 *
 * Only the oldest pending prompt is shown: the agent's other tool calls keep running, but a stack
 * of dialogs would make approving the wrong one too easy. Dismissing counts as a refusal, because
 * the blocked call has to be told something either way.
 */
export function ToolApprovalDialog({prompt, onRespond}: ToolApprovalDialogProps) {
    if (!prompt) return null
    const [first, ...rest] = prompt.calls
    if (!first) return null
    // The reasons, each said once. Ten deletions share one sentence, and a mixed call says both.
    const reasons = [...new Set(prompt.calls.map(call => call.reason))].join(' ')
    const waitingFor =
        rest.length === 0 ?
            approvalLine(prompt.tool, first)
        :   `${String(prompt.calls.length)} operations: ${prompt.calls
                .map(call => approvalLine(prompt.tool, call))
                .join(', ')}`
    const title =
        rest.length === 0 ?
            `Approve ${prompt.tool} ${first.op.replace(/_/gu, ' ')}?`
        :   `Approve ${String(prompt.calls.length)} ${prompt.tool} operations?`
    return (
        <AlertDialog
            isOpen
            title={title}
            description={`${reasons} The agent is waiting to run ${waitingFor}.`}
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
