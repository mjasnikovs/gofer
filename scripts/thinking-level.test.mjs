import {strict as assert} from 'node:assert'
import test from 'node:test'
import {piThinkingLevel, piThinkingLevelMap} from './thinking-level.mjs'

/*
 * What pi-ai does with the map this builds, which is why each rule below is load-bearing:
 * a level mapped to `null` is put out of reach of `clampThinkingLevel` entirely, a level mapped to
 * itself is sent as written, and a mapped `off` is read as an instruction of its own — pi-ai writes
 * that word into `reasoning_effort` rather than leaving the field out.
 */

test('a level the server named is sent as written, and one it did not is out of reach', () => {
    const map = piThinkingLevelMap(['low', 'medium', 'high'])
    assert.equal(map.low, 'low')
    assert.equal(map.high, 'high')
    // Not `high`. Unmapped, pi-ai clamps `xhigh` onto the nearest level it believes in, and a
    // template with no word for the result answers HTTP 500 to every request of the turn.
    assert.equal(map.xhigh, null)
    assert.equal(map.max, null)
    assert.equal(map.minimal, null)
})

test('off stays unmapped where the model named no word for it', () => {
    // Every driver but Cerebras. Unmapped, `off` sends no effort field at all, which is what it has
    // always meant here — and what it must go on meaning for the local server and OpenRouter.
    const map = piThinkingLevelMap(['low', 'medium', 'high'])
    assert.equal(Object.hasOwn(map, 'off'), false)
})

test('off carries the model own word for stopping where it has one', () => {
    // Cerebras `gemma-4-31b` takes `reasoning_effort: "none"` and comes back having thought about
    // nothing. Without this the same request leaves the field out and the model thinks anyway.
    const map = piThinkingLevelMap(['low', 'medium', 'high'], 'none')
    assert.equal(map.off, 'none')
    assert.equal(map.low, 'low')
})

test('a server that named no efforts gets no map, whatever word it offered for off', () => {
    // That connection has one level, `on`, and the effort field never leaves the building — so a
    // word for stopping would have nowhere to be written.
    assert.equal(piThinkingLevelMap([]), undefined)
    assert.equal(piThinkingLevelMap([], 'none'), undefined)
    assert.equal(piThinkingLevelMap(undefined, 'none'), undefined)
})

test('a model that cannot stop thinking is asked for the least it will do', () => {
    // `off` on such a model is not a quieter setting, it is a request that fails. The cheapest
    // effort it named is the nearest thing to what was asked for.
    assert.equal(
        piThinkingLevel('off', {
            reasoningMandatory: true,
            thinkingLevels: ['high', 'medium', 'low']
        }),
        'low'
    )
    // By Gofer's order, never the provider's: taking the first of the list above would answer a
    // request for no thinking at all with the most expensive setting there is.
    assert.equal(piThinkingLevel('off', {reasoningMandatory: true, thinkingLevels: []}), 'medium')
    assert.equal(
        piThinkingLevel('off', {reasoningMandatory: false, thinkingLevels: ['low']}),
        'off'
    )
})

test('on is a level pi-ai has no word for, so it becomes one above off', () => {
    assert.equal(piThinkingLevel('on', {}), 'medium')
})
