import {invoke} from './desktop'
import type {ChatAttachment, StoredChat} from '../models/chat'

/**
 * The renderer's half of the chat commands: the durable conversation, its attachments, the tool
 * approvals, and the one control that stops a run.
 *
 * Named functions rather than command strings in components, so a test hands the caller a real
 * fake instead of replacing the whole IPC module — which is the seam every one of these bugs has
 * lived in.
 */

export function loadChat() {
    return invoke('load_chat')
}

export function saveChat(chat: StoredChat) {
    return invoke('save_chat', {chat})
}

/** Moves a conversation the browser build left in `localStorage` into the project's database. */
export function importLegacyChat(chat: StoredChat) {
    return invoke('import_legacy_chat', {chat})
}

/** Stores one attachment's bytes. The message referring to it is saved separately. */
export function saveChatAttachment(attachment: ChatAttachment, data: string) {
    return invoke('save_chat_attachment', {request: {attachment, data}})
}

export function readChatAttachment(attachment: ChatAttachment) {
    return invoke('read_chat_attachment', {attachment})
}

export function respondToolApproval(approvalId: string, approved: boolean) {
    return invoke('respond_tool_approval', {request: {approvalId, approved}})
}

export function cancelAiRequest(requestId: number) {
    return invoke('cancel_ai_request', {requestId})
}
