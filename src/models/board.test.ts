import {describe, expect, it} from 'vitest'
import {laneCards} from './board'
import type {Card} from './board'

function card(id: string, status: Card['status'], updatedAt: number): Card {
    return {
        id,
        number: 1,
        title: id,
        body: '',
        owner: 'user',
        status,
        taskId: null,
        commentCount: 0,
        createdAt: 0,
        updatedAt
    }
}

describe('laneCards', () => {
    it('puts the card finished last on top of Done, whatever changed on the others since', () => {
        const cards = [
            card('first', 'done', 9),
            card('second', 'done', 1),
            card('third', 'done', 5)
        ]
        expect(laneCards(cards, 'done').map(one => one.id)).toEqual(['third', 'second', 'first'])
    })

    it('keeps the board order everywhere else', () => {
        const cards = [card('first', 'ready', 1), card('second', 'ready', 3)]
        expect(laneCards(cards, 'ready').map(one => one.id)).toEqual(['first', 'second'])
    })
})
