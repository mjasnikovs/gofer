import {strict as assert} from 'node:assert'
import test from 'node:test'
import {piThinkingLevel, piThinkingLevelMap} from './thinking-level.mjs'

test('a level the server named is sent as written, and one it did not is out of reach', () => {
    const map = piThinkingLevelMap(['low', 'medium', 'high'])
    assert.equal(map.low, 'low')
    assert.equal(map.high, 'high')
    assert.equal(map.xhigh, null)
    assert.equal(map.max, null)
    assert.equal(map.minimal, null)
})

test('off stays unmapped where the model named no word for it', () => {
    const map = piThinkingLevelMap(['low', 'medium', 'high'])
    assert.equal(Object.hasOwn(map, 'off'), false)
})

test('off carries the model own word for stopping where it has one', () => {
    const map = piThinkingLevelMap(['low', 'medium', 'high'], 'none')
    assert.equal(map.off, 'none')
    assert.equal(map.low, 'low')
})

test('a server that named no efforts gets no map, whatever word it offered for off', () => {
    assert.equal(piThinkingLevelMap([]), undefined)
    assert.equal(piThinkingLevelMap([], 'none'), undefined)
    assert.equal(piThinkingLevelMap(undefined, 'none'), undefined)
})

test('a model that cannot stop thinking is asked for the least it will do', () => {
    assert.equal(
        piThinkingLevel('off', {
            reasoningMandatory: true,
            thinkingLevels: ['high', 'medium', 'low']
        }),
        'low'
    )
    assert.equal(piThinkingLevel('off', {reasoningMandatory: true, thinkingLevels: []}), 'medium')
    assert.equal(
        piThinkingLevel('off', {reasoningMandatory: false, thinkingLevels: ['low']}),
        'off'
    )
})

test('on is a level pi-ai has no word for, so it becomes one above off', () => {
    assert.equal(piThinkingLevel('on', {}), 'medium')
})
