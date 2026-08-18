import {useCallback} from 'react'
import {invoke} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {useSettledQueue} from './useSettledQueue'
import type {ToolApprovalPrompt} from '../models/chat'

type ToolApprovalOptions = Readonly<{
    onError: (message: string) => void
}>

const keyOf = (prompt: ToolApprovalPrompt) => prompt.approvalId

/**
 * Tracks the AI tool calls waiting for the user.
 *
 * A prompt is a paused agent: the backend blocks the tool call that raised it until this hook
 * answers, so the queue is kept in arrival order and answered one at a time. Prompts also settle
 * without an answer — the backend times them out and cancels them with their turn — which is why the
 * queue follows `ai-approval-settled` rather than only the answers sent from here.
 *
 * The queue itself is [`useSettledQueue`], shared with the question surface. What is left here is
 * the part that is actually about approvals: which events, and what answering one means.
 */
export function useToolApprovals({onError}: ToolApprovalOptions) {
    const {queue: approvals, settle} = useSettledQueue<ToolApprovalPrompt>({
        requestEvent: 'ai-approval-request',
        settledEvent: 'ai-approval-settled',
        keyOf
    })

    const respond = useCallback(
        (approvalId: string, approved: boolean) => {
            // Dropped here as well as on the settled event: the tool call resumes the moment the
            // backend has the answer, and the dialog must not outlive that.
            settle(approvalId)
            void invoke('respond_tool_approval', {request: {approvalId, approved}}).catch(
                (error: unknown) => {
                    onError(`The approval could not be sent: ${commandErrorMessage(error)}`)
                }
            )
        },
        [onError, settle]
    )

    return {approvals, respond}
}
