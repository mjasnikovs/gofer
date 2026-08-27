import {deepEqual, equal} from 'node:assert/strict'
import {test} from 'node:test'
import {turnContextText, withTurnContext} from './turn-context.mjs'

test('the three blocks are sent in the order the prompt describes them', () => {
    equal(
        turnContextText({
            memoryContext: 'a memory',
            sessionContext: 'a session',
            inventory: 'a.gd'
        }),
        'Relevant persistent project memory:\na memory\n\na session\n\na.gd'
    )
})

test('a block the turn does not know is not announced', () => {
    equal(turnContextText({sessionContext: 'a session'}), 'a session')
    equal(
        turnContextText({memoryContext: 'a memory'}),
        'Relevant persistent project memory:\na memory'
    )
    equal(turnContextText({inventory: 'a.gd'}), 'a.gd')
})

test('a turn that knows none of it sends nothing rather than an empty heading', () => {
    equal(turnContextText({}), undefined)
    equal(turnContextText(), undefined)
    equal(turnContextText({memoryContext: '', sessionContext: '', inventory: ''}), undefined)
})

test('the context goes on the last thing the user said', () => {
    deepEqual(
        withTurnContext(
            [
                {role: 'user', content: 'first'},
                {role: 'assistant', content: 'an answer'},
                {role: 'user', content: 'second'},
                {role: 'toolResult', content: 'a result'}
            ],
            'CONTEXT'
        ),
        [
            {role: 'user', content: 'first'},
            {role: 'assistant', content: 'an answer'},
            {role: 'user', content: 'second\n\nCONTEXT'},
            {role: 'toolResult', content: 'a result'}
        ]
    )
})

test('a message carrying pictures keeps them where they were', () => {
    deepEqual(
        withTurnContext(
            [
                {
                    role: 'user',
                    content: [
                        {type: 'text', text: 'look'},
                        {type: 'image', data: 'x'}
                    ]
                }
            ],
            'CONTEXT'
        ),
        [
            {
                role: 'user',
                content: [
                    {type: 'text', text: 'look'},
                    {type: 'image', data: 'x'},
                    {type: 'text', text: 'CONTEXT'}
                ]
            }
        ]
    )
})

test('a message whose content is neither words nor parts is left alone', () => {
    deepEqual(withTurnContext([{role: 'user', content: undefined}], 'CONTEXT'), [
        {role: 'user', content: undefined}
    ])
})

test('a transcript compaction left with no prompt is given one, in a fixed place', () => {
    deepEqual(withTurnContext([{role: 'compactionSummary', content: 'earlier'}], 'CONTEXT'), [
        {role: 'user', content: 'CONTEXT'},
        {role: 'compactionSummary', content: 'earlier'}
    ])

    // And it stays in that place while the turn goes on, which is the whole point of the position:
    // nothing can anchor a message that is made fresh every request, so it has to be somewhere the
    // growing tail cannot push it.
    const anchor = {}
    const head = {role: 'compactionSummary', content: 'earlier'}
    deepEqual(withTurnContext([head], 'CONTEXT', anchor).slice(0, 2), [
        {role: 'user', content: 'CONTEXT'},
        head
    ])
    deepEqual(
        withTurnContext([head, {role: 'toolResult', content: 'a result'}], 'CONTEXT', anchor).slice(
            0,
            2
        ),
        [{role: 'user', content: 'CONTEXT'}, head]
    )
})

test('nothing to say, and nothing to say it to, are both left untouched', () => {
    const messages = [{role: 'user', content: 'hi'}]
    equal(withTurnContext(messages, undefined), messages)
    equal(withTurnContext(messages, ''), messages)
    equal(withTurnContext(undefined, 'CONTEXT'), undefined)
})

test('the stored messages are not written to', () => {
    const stored = [{role: 'user', content: 'hi'}]
    const sent = withTurnContext(stored, 'CONTEXT')
    equal(stored[0].content, 'hi')
    equal(sent[0].content, 'hi\n\nCONTEXT')
})

test('a second question mid-turn does not move the block off the first', () => {
    const anchor = {}
    const asked = {role: 'user', content: 'Build the level'}
    const first = [asked]
    deepEqual(withTurnContext(first, 'CONTEXT', anchor), [
        {role: 'user', content: 'Build the level\n\nCONTEXT'}
    ])

    // What a red verify report does: a second prompt, in the same turn, behind the work.
    const later = [
        asked,
        {role: 'toolResult', content: 'a result'},
        {role: 'user', content: 'Fix it'}
    ]
    deepEqual(withTurnContext(later, 'CONTEXT', anchor), [
        {role: 'user', content: 'Build the level\n\nCONTEXT'},
        {role: 'toolResult', content: 'a result'},
        {role: 'user', content: 'Fix it'}
    ])
})

test('a compaction that replaced the messages anchors afresh', () => {
    const anchor = {}
    withTurnContext([{role: 'user', content: 'Build the level'}], 'CONTEXT', anchor)
    // Compaction hands back new objects, so the message the turn anchored to is no longer there.
    deepEqual(
        withTurnContext(
            [
                {role: 'compactionSummary', content: 'earlier'},
                {role: 'user', content: 'Fix it'}
            ],
            'CONTEXT',
            anchor
        ),
        [
            {role: 'compactionSummary', content: 'earlier'},
            {role: 'user', content: 'Fix it\n\nCONTEXT'}
        ]
    )
})
