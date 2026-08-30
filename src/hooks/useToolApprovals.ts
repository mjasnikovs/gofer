import {useCallback} from 'react'
import {invoke} from '../services/desktop'
import {commandErrorMessage} from '../utils/command-error'
import {useSettledQueue} from './useSettledQueue'
import type {ToolApprovalPrompt} from '../models/chat'

type ToolApprovalOptions = Readonly<{
    onError: (message: string) => void
}>

const keyOf = (prompt: ToolApprovalPrompt) => prompt.approvalId

export function useToolApprovals({onError}: ToolApprovalOptions) {
    const {queue: approvals, settle} = useSettledQueue<ToolApprovalPrompt>({
        requestEvent: 'ai-approval-request',
        settledEvent: 'ai-approval-settled',
        keyOf
    })

    const respond = useCallback(
        (approvalId: string, approved: boolean) => {
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
