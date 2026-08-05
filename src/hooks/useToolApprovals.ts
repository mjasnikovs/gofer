import {useCallback, useEffect, useState} from 'react'
import {invoke, isTauri, listen} from '../services/desktop'
import type {ToolApprovalPrompt} from '../models/chat'

type ToolApprovalOptions = Readonly<{
    onError: (message: string) => void
}>

/**
 * Tracks the AI tool calls waiting for the user.
 *
 * A prompt is a paused agent: the backend blocks the tool call that raised it until this hook
 * answers, so the queue is kept in arrival order and answered one at a time. Prompts also settle
 * without an answer — the backend times them out and cancels them with their turn — which is why
 * the queue follows `ai-approval-settled` rather than only the answers sent from here.
 */
export function useToolApprovals({onError}: ToolApprovalOptions) {
    const [approvals, setApprovals] = useState<readonly ToolApprovalPrompt[]>([])

    useEffect(() => {
        if (!isTauri()) return
        let isCancelled = false
        const disposers: (() => void)[] = []
        const track = (pending: Promise<() => void>) => {
            void pending.then(dispose => {
                if (isCancelled) dispose()
                else disposers.push(dispose)
            })
        }
        track(
            listen('ai-approval-request', event => {
                if (isCancelled) return
                setApprovals(previous =>
                    previous.some(prompt => prompt.approvalId === event.payload.approvalId) ?
                        previous
                    :   [...previous, event.payload]
                )
            })
        )
        track(
            listen('ai-approval-settled', event => {
                if (isCancelled) return
                setApprovals(previous =>
                    previous.filter(prompt => prompt.approvalId !== event.payload.approvalId)
                )
            })
        )
        return () => {
            isCancelled = true
            for (const dispose of disposers) dispose()
        }
    }, [])

    const respond = useCallback(
        (approvalId: string, approved: boolean) => {
            // Dropped here as well as on the settled event: the tool call resumes the moment the
            // backend has the answer, and the dialog must not outlive that.
            setApprovals(previous => previous.filter(prompt => prompt.approvalId !== approvalId))
            void invoke('respond_tool_approval', {request: {approvalId, approved}}).catch(
                (error: unknown) => {
                    onError(`The approval could not be sent: ${String(error)}`)
                }
            )
        },
        [onError]
    )

    return {approvals, respond}
}
