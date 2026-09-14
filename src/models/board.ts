export const CARD_STATUSES = ['backlog', 'ready', 'doing', 'review', 'done'] as const

export type CardStatus = (typeof CARD_STATUSES)[number]

export const CARD_STATUS_LABELS: Readonly<Record<CardStatus, string>> = {
    backlog: 'Backlog',
    ready: 'Ready',
    doing: 'Doing',
    review: 'Review',
    done: 'Done'
}

export type Card = Readonly<{
    id: string
    title: string
    body: string
    owner: string
    status: CardStatus
    taskId: string | null
    commentCount: number
    createdAt: number
    updatedAt: number
}>

export type CardComment = Readonly<{
    id: string
    cardId: string
    author: string
    body: string
    createdAt: number
}>

export type CardDetail = Readonly<{
    card: Card
    comments: readonly CardComment[]
}>

export type CardEdit = Readonly<{
    title?: string
    body?: string
    owner?: string
}>

export function cardsIn(cards: readonly Card[], status: CardStatus): readonly Card[] {
    return cards.filter(card => card.status === status)
}
