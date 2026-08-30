import assert from 'node:assert/strict'
import test from 'node:test'
import {frozenPathsIn, refuseFrozenShellWrite, refuseFrozenWrite} from './frozen-paths.mjs'

const SPEC =
    'GOAL\nFix the wreck frame.\n\n'
    + 'CONSTRAINTS\n'
    + '- Change `resources/enemies/hornet.tres` only.\n'
    + '- Do not modify `DESIGN.md` or `GRAYZONE.md`.\n\n'
    + 'STEPS\n1. Set the destroyed frame.\n\n'
    + 'VERIFY\n```sh\n# it boots\ngodot --headless --quit-after 120\n```\n'

test('the frozen list comes out of the newest specification the user sent', () => {
    assert.deepEqual(frozenPathsIn([{sender: 'user', text: SPEC}]), ['DESIGN.md', 'GRAYZONE.md'])
    assert.deepEqual(frozenPathsIn([{sender: 'assistant', text: SPEC}]), [])
    assert.deepEqual(
        frozenPathsIn([{sender: 'user', text: 'CONSTRAINTS\n- Change `main.gd` only.\n'}]),
        []
    )
    assert.deepEqual(frozenPathsIn([]), [])
})

test('the freeze reads only its own section and only its own wording', () => {
    const after = 'CONSTRAINTS\n- Be brief.\n\nSTEPS\n1. Do not modify `main.gd` by hand.\n'
    assert.deepEqual(frozenPathsIn([{sender: 'user', text: after}]), [])
    for (const verb of ['Do not modify', 'do not edit', '- Do NOT change'])
        assert.deepEqual(
            frozenPathsIn([{sender: 'user', text: `CONSTRAINTS\n${verb} \`DESIGN.md\`.\n`}]),
            ['DESIGN.md']
        )
})

test('a write to a frozen path is refused, and a read of it is not', () => {
    const frozen = ['DESIGN.md', 'docs/spec.md']

    for (const tool of ['write', 'edit'])
        assert.throws(
            () => refuseFrozenWrite(tool, 'DESIGN.md', frozen),
            /specification freezes DESIGN\.md/u
        )
    assert.throws(
        () => refuseFrozenWrite('edit', '/work/tree/docs/spec.md', frozen),
        /freezes docs\/spec\.md/u
    )
    assert.doesNotThrow(() => refuseFrozenWrite('read', 'DESIGN.md', frozen))
    assert.doesNotThrow(() => refuseFrozenWrite('bash', 'DESIGN.md', frozen))
    assert.doesNotThrow(() => refuseFrozenWrite('write', 'MY-DESIGN.md', frozen))
    assert.doesNotThrow(() => refuseFrozenWrite('write', 'scripts/main.gd', frozen))
})

test('a shell command that writes a frozen path is refused, and one that reads it is not', () => {
    const frozen = ['DESIGN.md']

    for (const command of [
        'echo x > DESIGN.md',
        'cat notes >> DESIGN.md',
        'sed -i "s/a/b/" DESIGN.md',
        'printf x | tee DESIGN.md',
        'cp /dev/null DESIGN.md',
        'mv other.md DESIGN.md',
        'perl -i -pe "s/a/b/" DESIGN.md'
    ])
        assert.throws(() => refuseFrozenShellWrite(command, frozen), /freezes DESIGN\.md/u, command)

    for (const command of [
        'grep -n "wreck" DESIGN.md',
        'head -40 DESIGN.md',
        'wc -l DESIGN.md',
        'git diff -- DESIGN.md',
        'grep -c x DESIGN.md > count.txt'
    ])
        assert.doesNotThrow(() => refuseFrozenShellWrite(command, frozen), command)

    assert.doesNotThrow(() => refuseFrozenShellWrite('echo x > NOTES.md', frozen))
    assert.doesNotThrow(() => refuseFrozenShellWrite('echo x > DESIGN.md', []))
})
