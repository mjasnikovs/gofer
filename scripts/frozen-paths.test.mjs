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

/**
 * The failure this closes, from one project's own history: a task could not make the Hornet's wreck
 * frame work, reverted its own code change, and edited `DESIGN.md` to call the missing frame a
 * deliberate exception — while line 175 of the same file still listed it as an open defect.
 */
test('the frozen list comes out of the newest specification the user sent', () => {
    assert.deepEqual(frozenPathsIn([{sender: 'user', text: SPEC}]), ['DESIGN.md', 'GRAYZONE.md'])
    // An assistant writing the rule into its own answer is describing it, not being given it.
    assert.deepEqual(frozenPathsIn([{sender: 'assistant', text: SPEC}]), [])
    // A constraint that names a file to CHANGE is not a freeze.
    assert.deepEqual(
        frozenPathsIn([{sender: 'user', text: 'CONSTRAINTS\n- Change `main.gd` only.\n'}]),
        []
    )
    assert.deepEqual(frozenPathsIn([]), [])
})

test('the freeze reads only its own section and only its own wording', () => {
    // A later heading ends CONSTRAINTS, so a STEPS line quoting the same words cannot freeze a file.
    const after = 'CONSTRAINTS\n- Be brief.\n\nSTEPS\n1. Do not modify `main.gd` by hand.\n'
    assert.deepEqual(frozenPathsIn([{sender: 'user', text: after}]), [])
    // The three spellings compose is allowed, and nothing else.
    for (const verb of ['Do not modify', 'do not edit', '- Do NOT change'])
        assert.deepEqual(
            frozenPathsIn([{sender: 'user', text: `CONSTRAINTS\n${verb} \`DESIGN.md\`.\n`}]),
            ['DESIGN.md']
        )
})

/**
 * A red check has two cures and only one of them is honest. This closes the other one.
 */
test('a write to a frozen path is refused, and a read of it is not', () => {
    const frozen = ['DESIGN.md', 'docs/spec.md']

    for (const tool of ['write', 'edit'])
        assert.throws(
            () => refuseFrozenWrite(tool, 'DESIGN.md', frozen),
            /specification freezes DESIGN\.md/u
        )
    // Named as the specification names it, because that is the line the caller has to go and find.
    assert.throws(
        () => refuseFrozenWrite('edit', '/work/tree/docs/spec.md', frozen),
        /freezes docs\/spec\.md/u
    )
    // Reading is how a task learns what it is held to; only writing is refused.
    assert.doesNotThrow(() => refuseFrozenWrite('read', 'DESIGN.md', frozen))
    assert.doesNotThrow(() => refuseFrozenWrite('bash', 'DESIGN.md', frozen))
    // A file that merely ends with the same letters is a different file.
    assert.doesNotThrow(() => refuseFrozenWrite('write', 'MY-DESIGN.md', frozen))
    assert.doesNotThrow(() => refuseFrozenWrite('write', 'scripts/main.gd', frozen))
})

/**
 * `confineTool` answers bash in a branch of its own that returns before the file rules run, so a
 * rule covering only `write` and `edit` left `sed -i` wide open. A rule with a door in it is not a
 * rule.
 */
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

    // Reading it is how a task learns what binds it — the live run grepped it on the way to the
    // right answer, and refusing that would have refused the work.
    for (const command of [
        'grep -n "wreck" DESIGN.md',
        'head -40 DESIGN.md',
        'wc -l DESIGN.md',
        'git diff -- DESIGN.md',
        'grep -c x DESIGN.md > count.txt'
    ])
        assert.doesNotThrow(() => refuseFrozenShellWrite(command, frozen), command)

    // A file the specification never named is not this rule's business.
    assert.doesNotThrow(() => refuseFrozenShellWrite('echo x > NOTES.md', frozen))
    assert.doesNotThrow(() => refuseFrozenShellWrite('echo x > DESIGN.md', []))
})
