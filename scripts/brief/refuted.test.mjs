import assert from 'node:assert/strict'
import test from 'node:test'
import {applyRefutations, refutedTokens, sectionLines} from './refuted.mjs'

const refined = [
    'GOAL',
    'Place a unit from a menu.',
    '',
    'CONSTRAINTS',
    '- the panel reads `flow.field` fresh on every click',
    '- placement calls `is_open` to refuse a cell',
    '- the menu lives on the `CanvasLayer`',
    '',
    'KNOWN-UNKNOWNS',
    '- the panel width'
].join('\n')

const context = bullets =>
    ['FILES', '  a.gd', '', 'CONTEXT', ...bullets, '', 'TOOLING', '  x'].join('\n')

test('a section ends at the next bare heading, not at the end of the text', () => {
    assert.deepEqual(sectionLines(context(['- one', '- two']), 'CONTEXT'), ['- one', '- two', ''])
    assert.deepEqual(sectionLines(refined, 'NOWHERE'), [])
})

test('a need-negation around a token refutes the constraint naming it', () => {
    const research = context(['- no `is_open` check is needed; every cell accepts a unit'])
    const {refined: out, trail} = applyRefutations(refined, research)

    assert.equal(trail.length, 1)
    assert.match(trail[0], /no-x-needed/u)
    assert.doesNotMatch(out, /is_open/u)
    assert.match(out, /flow\.field/u)
    assert.match(out, /CanvasLayer/u)
})

test('all three shapes are recognised, and only inside the negation', () => {
    const found = refutedTokens(
        context([
            '- no `a` dependency is required',
            '- `b` is not necessary',
            '- no need to call `c`',
            '- no `d` needed — we use `e` instead'
        ])
    )
    assert.deepEqual([...found.keys()].sort(), ['`a`', '`b`', '`c`', '`d`'])
})

test('a fact about the tree is not a refutation', () => {
    const research = context([
        '- the project has no `unit_placement_panel.gd`; the task creates it',
        '- `is_open` does not exist yet'
    ])
    assert.deepEqual(applyRefutations(refined, research).trail, [])
})

test('only CONSTRAINTS is cut — the goal and the unknowns keep their words', () => {
    const research = context(['- no `CanvasLayer` is needed here'])
    const {refined: out} = applyRefutations(
        'GOAL\nUse the `CanvasLayer`.\n\nCONSTRAINTS\n- put it on the `CanvasLayer`\n',
        research
    )
    assert.match(out, /GOAL\nUse the `CanvasLayer`\./u)
    assert.doesNotMatch(out, /put it on/u)
})

test('nothing to refute leaves the task byte-identical', () => {
    assert.equal(applyRefutations(refined, context(['- it is a project'])).refined, refined)
    assert.equal(applyRefutations(refined, '').refined, refined)
})
