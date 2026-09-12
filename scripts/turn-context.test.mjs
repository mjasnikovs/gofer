import {deepEqual, equal} from 'node:assert/strict'
import {test} from 'node:test'
import {
    carriedText,
    carryTurnContext,
    scratchLine,
    turnContextText,
    withTurnContext
} from './turn-context.mjs'

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

test('the scratch directory is named after the session and before the inventory', () => {
    equal(
        turnContextText({
            sessionContext: 'a session',
            scratchPath: '/tmp/gofer/scratch/abc',
            inventory: 'a.gd'
        }),
        `a session\n\n${scratchLine('/tmp/gofer/scratch/abc')}\n\na.gd`
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

test('the context goes on the question the turn was asked', () => {
    deepEqual(withTurnContext({role: 'user', content: 'second'}, 'CONTEXT'), {
        role: 'user',
        content: 'second\n\nCONTEXT'
    })
})

test('a message carrying pictures keeps them where they were', () => {
    deepEqual(
        withTurnContext(
            {
                role: 'user',
                content: [
                    {type: 'text', text: 'look'},
                    {type: 'image', data: 'x'}
                ]
            },
            'CONTEXT'
        ),
        {
            role: 'user',
            content: [
                {type: 'text', text: 'look'},
                {type: 'image', data: 'x'},
                {type: 'text', text: 'CONTEXT'}
            ]
        }
    )
})

test('a message whose content is neither words nor parts is left alone', () => {
    deepEqual(withTurnContext({role: 'user', content: undefined}, 'CONTEXT'), {
        role: 'user',
        content: undefined
    })
})

test('nothing to say, and nothing to say it to, are both left untouched', () => {
    const message = {role: 'user', content: 'hi'}
    equal(withTurnContext(message, undefined), message)
    equal(withTurnContext(message, ''), message)
    equal(withTurnContext(undefined, 'CONTEXT'), undefined)
})

test('the question it was handed is not written to', () => {
    const asked = {role: 'user', content: 'hi'}
    equal(withTurnContext(asked, 'CONTEXT').content, 'hi\n\nCONTEXT')
    equal(asked.content, 'hi')
})

test('a transcript that arrived without the block is given it, on its question', () => {
    deepEqual(
        carryTurnContext(
            [
                {role: 'user', content: 'Build the level'},
                {role: 'assistant', content: 'Starting'}
            ],
            'CONTEXT'
        ),
        [
            {role: 'user', content: 'Build the level\n\nCONTEXT'},
            {role: 'assistant', content: 'Starting'}
        ]
    )
})

/** A second copy is the rewrite the whole design exists to avoid: the prefix has to stay put. */
test('a transcript that already carries the block is handed back untouched', () => {
    const messages = [
        {role: 'user', content: 'Build the level\n\nCONTEXT'},
        {role: 'assistant', content: 'Starting'}
    ]
    equal(carryTurnContext(messages, 'CONTEXT'), messages)
})

test('a transcript with no question left to carry it is left alone', () => {
    const messages = [{role: 'compactionSummary', content: 'earlier'}]
    equal(carryTurnContext(messages, 'CONTEXT'), messages)
    equal(carryTurnContext(messages, undefined), messages)
    equal(carryTurnContext(undefined, 'CONTEXT'), undefined)
})

test('the file list is not sent a second time when the conversation already carries it', () => {
    const carried = 'Build the level\n\nEditor: offline\n\nTRACKED\na.gd\nb.gd'
    equal(
        turnContextText(
            {sessionContext: 'Editor: running', inventory: 'TRACKED\na.gd\nb.gd'},
            carried
        ),
        'Editor: running'
    )
})

/** The session line flips back and forth, so an older copy of it says nothing about now. */
test('the session line is sent again even when the same words are already up there', () => {
    equal(
        turnContextText({sessionContext: 'Editor: offline'}, 'Editor: offline'),
        'Editor: offline'
    )
})

test('a file list that has changed is sent', () => {
    equal(
        turnContextText({inventory: 'TRACKED\na.gd\nb.gd'}, 'TRACKED\na.gd'),
        'TRACKED\na.gd\nb.gd'
    )
})

test('a question that came with pictures still reads as the words in it', () => {
    equal(
        carriedText([
            {
                role: 'user',
                content: [
                    {type: 'text', text: 'look'},
                    {type: 'image', data: 'x'}
                ]
            },
            {role: 'assistant', content: undefined}
        ]),
        'look'
    )
    equal(carriedText(undefined), '')
})
