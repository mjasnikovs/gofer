import assert from 'node:assert/strict'
import test from 'node:test'
import {runVerifyPoints, verifyPointsIn, verifyReport, verifySummary} from './verify-points.mjs'

const SPEC =
    'GOAL\nA boss.\n\nVERIFY\n```sh\n'
    + '# the boss registers every part it builds\n'
    + 'godot --headless --script check.gd\n'
    + '# the project still starts\n'
    + 'godot --headless --quit-after 600\n'
    + '```\n'

function envReturning(codes) {
    const ran = []
    return {
        ran,
        exec: (command, options) => {
            ran.push({command, timeout: options?.timeout})
            const exitCode = codes[ran.length - 1]
            if (exitCode === 'broken')
                return Promise.resolve({ok: false, error: {message: 'no such command'}})
            return Promise.resolve({
                ok: true,
                value: {stdout: `ran ${command}`, stderr: '', exitCode}
            })
        }
    }
}

/**
 * The points are read out of the conversation, not handed in. A planned task's specification is its
 * first user message, so the transcript already carries the block and nothing has to reach into the
 * Rust job to find it.
 */
test('the points come from the newest specification the user sent', () => {
    const older = 'GOAL\nOld.\n\nVERIFY\n```sh\n# old\nmake old\n```\n'
    const messages = [
        {sender: 'user', text: older},
        {sender: 'assistant', text: 'VERIFY\n```sh\n# mine\nmake mine\n```'},
        {sender: 'user', text: SPEC}
    ]

    assert.deepEqual(verifyPointsIn(messages), [
        {
            name: 'the boss registers every part it builds',
            command: 'godot --headless --script check.gd'
        },
        {name: 'the project still starts', command: 'godot --headless --quit-after 600'}
    ])
    // An assistant writing a VERIFY block is describing what it did, not agreeing to be held to it.
    assert.deepEqual(verifyPointsIn([{sender: 'assistant', text: SPEC}]), null)
    assert.equal(verifyPointsIn([{sender: 'user', text: 'no block here'}]), null)
    assert.equal(verifyPointsIn([]), null)
})

/**
 * Every point runs even after one has failed. A run that stopped at the first red would report one
 * broken thing where there are two, and naming the points is the whole reason to have them.
 */
test('every point runs, and the exit code is what decides', async () => {
    const env = envReturning([1, 0])
    const seen = []
    const points = verifyPointsIn([{sender: 'user', text: SPEC}])

    const results = await runVerifyPoints({points, env, emit: event => seen.push(event)})

    assert.deepEqual(
        results.map(result => [result.name, result.passed]),
        [
            ['the boss registers every part it builds', false],
            ['the project still starts', true]
        ]
    )
    assert.equal(env.ran.length, 2)
    assert.equal(env.ran[0].timeout, 120)
    assert.deepEqual(
        seen.map(event => event.status),
        ['running', 'error', 'running', 'complete']
    )
    // A failing point carries its output; a passing one has nothing to explain.
    assert.match(seen[1].output, /ran godot --headless --script check\.gd/u)
    assert.equal(seen[3].output, '')
})

test('a command that could not run at all is a failure, not a crash', async () => {
    const env = envReturning(['broken', 0])
    const points = verifyPointsIn([{sender: 'user', text: SPEC}])

    const results = await runVerifyPoints({points, env, emit: () => {}})

    assert.equal(results[0].passed, false)
    assert.match(results[0].output, /no such command/u)
    assert.equal(results[1].passed, true)
})

/**
 * The report is the user's next word to a model that has just called itself finished, so it names
 * the green points as well as the red: a report listing only the failure invites a fix that breaks
 * something that was working.
 */
test('a report is written only when something failed, and it names every point', () => {
    const green = [{name: 'a', command: 'make a', passed: true, output: ''}]
    assert.equal(verifyReport(green), undefined)
    assert.equal(verifyReport([]), undefined)

    const mixed = [
        {name: 'the boss moves', command: 'make boss', passed: false, output: 'actual=0'},
        {name: 'it still starts', command: 'make start', passed: true, output: ''}
    ]
    const report = verifyReport(mixed)
    assert.match(report, /1 of 2 verification points/u)
    assert.match(report, /FAIL {2}the boss moves/u)
    assert.match(report, /PASS {2}it still starts/u)
    assert.match(report, /actual=0/u)
    // The one thing it must forbid, because it is the cheapest way to turn a check green.
    assert.match(report, /Do not edit or delete the check/u)
})

/**
 * Measured live on this code: a point failed twice, the model was handed the report and asked
 * again, and the turn still ended with "The verification passes. The code is already correct." The
 * red was on the transcript and nowhere near the sentence anyone reads.
 */
test('a finished answer carries its own verdict, and says nothing when everything passed', () => {
    const results = [
        {name: 'the boss moves', command: 'make boss', passed: false, output: 'actual=0'},
        {name: 'it still starts', command: 'make start', passed: true, output: ''}
    ]

    const summary = verifySummary(results)
    assert.match(summary, /Verification failed: 1 of 2 points/u)
    assert.match(summary, /FAIL {2}the boss moves/u)
    // Every point is named, so the summary cannot be read as being about something else.
    assert.match(summary, /PASS {2}it still starts/u)

    assert.equal(verifySummary([{name: 'a', command: 'a', passed: true, output: ''}]), undefined)
    assert.equal(verifySummary([]), undefined)
    assert.equal(verifySummary(undefined), undefined)
})
