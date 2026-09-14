import {invoke, listen} from './desktop'
import {toCommandError} from '../utils/command-error'
import type {CommandError} from '../models/errors'
import type {Card, CardComment, CardDetail, CardEdit, CardStatus} from '../models/board'
import type {ChatAttachment, DraftAttachment, StoredChat} from '../models/chat'

export function listCards(): Promise<readonly Card[]> {
    return invoke('board_list')
}

export function readCard(id: string): Promise<CardDetail> {
    return invoke('card_read', {id})
}

export function createCard(
    title: string,
    body: string,
    status: CardStatus,
    attachments: readonly ChatAttachment[]
): Promise<Card> {
    return invoke('card_create', {title, body, status, attachments})
}

export function deleteCard(id: string): Promise<void> {
    return invoke('card_delete', {id})
}

/**
 * Puts every picture the card does not have yet where a message's pictures go, and answers with
 * the rows a card points at. The same id twice is the same bytes, so a picture the card already
 * holds is skipped rather than sent again.
 */
export async function storeCardAttachments(
    pictures: readonly DraftAttachment[],
    held: ReadonlySet<string>
): Promise<readonly ChatAttachment[]> {
    await Promise.all(
        pictures
            .filter(picture => !held.has(picture.id))
            .map(picture =>
                invoke('save_chat_attachment', {
                    request: {attachment: toChatAttachment(picture), data: picture.data}
                })
            )
    )
    return pictures.map(toChatAttachment)
}

function toChatAttachment(picture: DraftAttachment): ChatAttachment {
    return {id: picture.id, name: picture.name, mimeType: picture.mimeType, size: picture.size}
}

export function moveCard(id: string, status: CardStatus): Promise<Card> {
    return invoke('card_move', {id, status})
}

export function editCard(id: string, edit: CardEdit): Promise<Card> {
    return invoke('card_edit', {id, edit})
}

export function commentOnCard(id: string, body: string): Promise<CardComment> {
    return invoke('card_comment', {id, body})
}

export function postCardToGofer(id: string, bringChanges: boolean): Promise<StoredChat> {
    return invoke('card_post_to_gofer', {id, bringChanges})
}

/** Fires after any write through any door — the window, the worker, or another agent. */
export function watchBoard(handler: () => void): Promise<() => void> {
    return listen('board-changed', () => {
        handler()
    })
}

export const toBoardError: (error: unknown) => CommandError = toCommandError
