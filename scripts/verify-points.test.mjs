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
    assert.deepEqual(verifyPointsIn([{sender: 'assistant', text: SPEC}]), null)
    assert.equal(verifyPointsIn([{sender: 'user', text: 'no block here'}]), null)
    assert.equal(verifyPointsIn([]), null)
})

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
    assert.match(report, /Do not edit or delete the check/u)
})

test('a finished answer carries its own verdict, and says nothing when everything passed', () => {
    const results = [
        {name: 'the boss moves', command: 'make boss', passed: false, output: 'actual=0'},
        {name: 'it still starts', command: 'make start', passed: true, output: ''}
    ]

    const summary = verifySummary(results)
    assert.match(summary, /Verification failed: 1 of 2 points/u)
    assert.match(summary, /FAIL {2}the boss moves/u)
    assert.match(summary, /PASS {2}it still starts/u)

    assert.equal(verifySummary([{name: 'a', command: 'a', passed: true, output: ''}]), undefined)
    assert.equal(verifySummary([]), undefined)
    assert.equal(verifySummary(undefined), undefined)
})

test('a point that reaches outside the workspace is refused, not run', async () => {
    const env = {
        ran: [],
        exec: command => {
            env.ran.push(command)
            return Promise.resolve({ok: true, value: {stdout: '', stderr: '', exitCode: 0}})
        }
    }
    const spec =
        'VERIFY\n```sh\n'
        + '# reaches out of the workspace\n'
        + 'godot --headless --script /etc/passwd\n'
        + '# stays inside it\n'
        + 'godot --headless --script .gofer/checks/boss.gd\n'
        + '```\n'

    const results = await runVerifyPoints({
        points: verifyPointsIn([{sender: 'user', text: spec}]),
        env,
        emit: () => {}
    })

    assert.equal(results[0].passed, false)
    assert.match(results[0].output, /absolute path/u)
    assert.match(results[0].output, /godot_runtime \{"ops"/u)
    assert.deepEqual(env.ran, ['godot --headless --script .gofer/checks/boss.gd'])
    assert.equal(results[1].passed, true)
})

const TOOL_SPEC =
    'VERIFY\n```sh\n'
    + '# the bullet is in the running tree\n'
    + 'godot_runtime {"ops": [{"op": "run"}, {"op": "get_tree"}], "contains": "Bullet"}\n'
    + '```\n'

function hostAnswering(result) {
    const calls = []
    return {
        calls,
        call: (tool, params) => {
            calls.push({tool, params})
            return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
        }
    }
}

test('a point that names a godot tool is called, not put through the shell', async () => {
    const env = {exec: () => assert.fail('a tool point must not reach the shell')}
    const host = hostAnswering({ops: [{op: 'get_tree', result: {children: ['Bullet']}}]})

    const results = await runVerifyPoints({
        points: verifyPointsIn([{sender: 'user', text: TOOL_SPEC}]),
        env,
        host,
        emit: () => {}
    })

    assert.deepEqual(host.calls, [
        {tool: 'godot_runtime', params: {ops: [{op: 'run'}, {op: 'get_tree'}]}}
    ])
    assert.equal(results[0].passed, true)
    assert.equal(results[0].name, 'the bullet is in the running tree')
})

test('`contains` is the assertion: the call answering is not enough', async () => {
    const host = hostAnswering({ops: [{op: 'get_tree', result: {children: []}}]})

    const results = await runVerifyPoints({
        points: verifyPointsIn([{sender: 'user', text: TOOL_SPEC}]),
        env: {exec: () => assert.fail('a tool point must not reach the shell')},
        host,
        emit: () => {}
    })

    assert.equal(results[0].passed, false)
    assert.match(results[0].output, /Bullet/u)
})

test('a tool point that cannot be called fails by saying so, not by crashing', async () => {
    const points = verifyPointsIn([{sender: 'user', text: TOOL_SPEC}])
    const env = {exec: () => assert.fail('a tool point must not reach the shell')}

    const refused = await runVerifyPoints({
        points,
        env,
        host: hostAnswering(new Error('session_closed: no editor is running')),
        emit: () => {}
    })
    assert.equal(refused[0].passed, false)
    assert.match(refused[0].output, /session_closed/u)

    const unreachable = await runVerifyPoints({points, env, emit: () => {}})
    assert.equal(unreachable[0].passed, false)
    assert.match(unreachable[0].output, /no channel to the editor/u)
})

test('a tool line the shell would refuse is never handed to the shell', async () => {
    const spec =
        'VERIFY\n```sh\n'
        + '# the scene the shell rule will not name\n'
        + 'godot_runtime {"ops": [{"op": "run", "scene": "scenes/main.tscn"}]}\n'
        + '```\n'
    const host = hostAnswering({ops: [{op: 'run', result: {playing: true}}]})

    const results = await runVerifyPoints({
        points: verifyPointsIn([{sender: 'user', text: spec}]),
        env: {exec: () => assert.fail('a tool point must not reach the shell')},
        host,
        emit: () => {}
    })

    assert.equal(results[0].passed, true)
    assert.equal(host.calls[0].params.ops[0].scene, 'scenes/main.tscn')
})
