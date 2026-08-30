import {AlertDialog} from '@astryxdesign/core/AlertDialog'
import type {ToolApprovalCall, ToolApprovalPrompt} from '../../models/chat'

type ToolApprovalDialogProps = Readonly<{
    prompt?: ToolApprovalPrompt | undefined
    onRespond: (approvalId: string, approved: boolean) => void
}>

function approvalTarget(params: Readonly<Record<string, unknown>>) {
    const named = ['path', 'from', 'setting', 'plugin', 'name']
        .map(key => params[key])
        .find(value => typeof value === 'string' && value.length > 0)
    if (typeof named !== 'string') return undefined
    const destination = params['to']
    return typeof destination === 'string' ? `${named} → ${destination}` : named
}

function approvalLine(tool: string, call: ToolApprovalCall) {
    const target = approvalTarget(call.params)
    return `${tool} ${call.op.replace(/_/gu, ' ')}${target ? ` on ${target}` : ''}`
}

export function ToolApprovalDialog({prompt, onRespond}: ToolApprovalDialogProps) {
    if (!prompt) return null
    const [first, ...rest] = prompt.calls
    if (!first) return null
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
            actionVariant='primary'
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
