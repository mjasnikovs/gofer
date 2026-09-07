import assert from 'node:assert/strict'
import test from 'node:test'
import {
    extractToolingCommands,
    parseVerifyToolingOutput,
    replaceToolingWithVerified
} from './tooling.mjs'

const research = [
    'CONTEXT',
    '- it is a project',
    '',
    'TOOLING',
    '  godot --headless --import  every asset resolves',
    '  godot --headless --quit-after 600  the project boots',
    '  (this section is a claim, not a reading)',
    '',
    'APIS',
    '  Node.ready()'
].join('\n')

test('a command is the first column, and the section stops at the next heading', () => {
    assert.deepEqual(extractToolingCommands(research), [
        'godot --headless --import',
        'godot --headless --quit-after 600'
    ])
    assert.deepEqual(extractToolingCommands('CONTEXT\n- nothing here'), [])
})

test('the verified list replaces the claimed one, and the rest of the research is untouched', () => {
    const out = replaceToolingWithVerified(research, ['godot --headless --import  0 errors'])
    assert.match(out, /TOOLING\n {2}godot --headless --import {2}0 errors\n/u)
    assert.doesNotMatch(out, /quit-after/u)
    assert.match(out, /APIS\n {2}Node\.ready\(\)/u)
    assert.match(out, /- it is a project/u)
})

test('nothing verified says so, because a blank section reads as "nobody looked"', () => {
    assert.match(
        replaceToolingWithVerified(research, []),
        /\(none — every command this task named failed/u
    )
})

test('the verdict is two lists, and an unclassified line is not verified', () => {
    const verdict = parseVerifyToolingOutput(
        [
            'VERIFIED',
            '  npm test  the suite runs',
            '',
            'REJECTED',
            '  make build  no such target',
            ''
        ].join('\n')
    )
    assert.deepEqual(verdict.verified, ['npm test  the suite runs'])
    assert.deepEqual(verdict.rejected, ['make build  no such target'])
    assert.deepEqual(parseVerifyToolingOutput('I ran them all and they were fine').verified, [])
})
