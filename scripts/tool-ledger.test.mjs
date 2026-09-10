import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {
    callsFromEvents,
    catalogueOperations,
    codeOf,
    contractRefusals,
    loadTaskBank,
    need,
    openLedger,
    opStats,
    opsFromLedger,
    rankTasks,
    recordRun,
    repeatsWithinRuns,
    setVerdict
} from './tool-ledger.mjs'

const event = (type, body) => JSON.stringify({event: {type, ...body}, requestId: 1})

const EVENTS = [
    event('thinking-delta', {delta: 'x'}),
    event('tool-start', {id: 'a', name: 'read', target: 'scripts/main.gd', startedAt: 10}),
    event('tool-end', {id: 'a', output: '1\textends Node2D', isError: false, endedAt: 15}),
    event('tool-start', {
        id: 'b',
        name: 'godot',
        target: 'debug.await_stop, debug.continue',
        startedAt: 20
    }),
    event('tool-end', {
        id: 'b',
        output: 'must_be_alone: debug.await_stop has to be alone',
        isError: true,
        endedAt: 21
    }),
    event('tool-start', {id: 'c', name: 'godot', target: 'scene.open', startedAt: 30}),
    event('tool-end', {
        id: 'c',
        output: 'Validation failed for tool "godot": ops[0] path',
        isError: true,
        endedAt: 32
    }),
    event('tool-start', {id: 'd', name: 'godot', target: 'scene.open', startedAt: 40}),
    event('tool-end', {id: 'd', output: {opened: true}, isError: false, endedAt: 48}),
    ''
]

const LEDGER = [
    JSON.stringify({
        op: 'scene.open',
        code: null,
        message: null,
        ms: 7,
        params: {path: 'res://scenes/main.tscn'}
    }),
    JSON.stringify({
        op: 'node.rename',
        code: 'not_found',
        message: 'no Foo',
        ms: 1,
        params: {node: 'Foo'}
    }),
    JSON.stringify({
        op: 'node.rename',
        code: 'not_found',
        message: 'no Foo',
        ms: 1,
        params: {node: 'Foo'}
    }),
    ''
]

const BANK = {
    tasks: [
        {
            id: 'open',
            fixture: 'live-project',
            ops: ['scene.open', 'scene.get_tree'],
            task: 'open it'
        },
        {id: 'rename', fixture: 'live-project', ops: ['node.rename'], task: 'rename it'},
        {
            id: 'debug',
            fixture: 'live-project',
            ops: ['debug.launch', 'debug.await_stop'],
            task: 'debug it'
        }
    ]
}

function freshDb() {
    const directory = mkdtempSync(join(tmpdir(), 'tool-ledger-'))
    return openLedger(join(directory, 'ledger.sqlite'))
}

test('the code of a refusal is its first word, and a pi-ai schema refusal is schema', () => {
    assert.equal(codeOf('anything', false), null)
    assert.equal(codeOf('must_be_alone: x', true), 'must_be_alone')
    assert.equal(codeOf('Validation failed for tool "godot"', true), 'schema')
    assert.equal(codeOf('Something odd', true), 'unknown')
})

test('calls come from the events, paired by id, with the code and the wall time', () => {
    const calls = callsFromEvents(EVENTS)
    assert.deepEqual(
        calls.map(c => [c.tool, c.target, c.isError, c.code, c.ms]),
        [
            ['read', 'scripts/main.gd', false, null, 5],
            ['godot', 'debug.await_stop, debug.continue', true, 'must_be_alone', 1],
            ['godot', 'scene.open', true, 'schema', 2],
            ['godot', 'scene.open', false, null, 8]
        ]
    )
    assert.equal(calls[3].output, '{"opened":true}')
})

test('ops come from the ledger with their params kept as text', () => {
    const ops = opsFromLedger(LEDGER)
    assert.equal(ops.length, 3)
    assert.equal(ops[0].op, 'scene.open')
    assert.equal(ops[0].code, null)
    assert.equal(ops[1].code, 'not_found')
    assert.equal(ops[1].params, '{"node":"Foo"}')
})

test('a run is recorded once by name, and its stats, refusals and repeats read back', () => {
    const db = freshDb()
    const run = {
        name: 'r1',
        taskId: 'rename',
        task: 'rename it',
        fixture: 'live-project',
        model: 'local',
        startedAt: 1,
        seconds: 2
    }
    recordRun(db, run, callsFromEvents(EVENTS), opsFromLedger(LEDGER))
    recordRun(db, run, callsFromEvents(EVENTS), opsFromLedger(LEDGER))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ops').get().n, 3)

    const stats = opStats(db, ['scene.open', 'node.rename', 'debug.launch'])
    const byOp = Object.fromEntries(stats.map(s => [s.op, s]))
    assert.deepEqual(
        [byOp['scene.open'].calls, byOp['scene.open'].errors, byOp['scene.open'].runs],
        [1, 0, 1]
    )
    assert.deepEqual(
        [byOp['node.rename'].calls, byOp['node.rename'].errors, byOp['node.rename'].open],
        [2, 2, 2]
    )
    assert.equal(byOp['debug.launch'].calls, 0)

    assert.deepEqual(
        contractRefusals(db).map(r => [r.code, r.target, Number(r.n)]),
        [
            ['must_be_alone', 'debug.await_stop, debug.continue', 1],
            ['schema', 'scene.open', 1]
        ]
    )
    assert.deepEqual(
        repeatsWithinRuns(db).map(r => [r.op, r.code, Number(r.n)]),
        [['node.rename', 'not_found', 2]]
    )

    setVerdict(db, 'node.rename', 'not_found', 'model', 'it guessed a node name')
    setVerdict(db, 'node.rename', 'not_found', 'gofer', 'no, the tree hid it')
    const judged = Object.fromEntries(opStats(db, ['node.rename']).map(s => [s.op, s]))
    assert.equal(judged['node.rename'].open, 0)
    assert.equal(judged['node.rename'].verdicts.not_found, 'gofer')
    db.close()
})

test('need ranks an untouched op above a rarely run one, and an open failure above both', () => {
    assert.equal(need({calls: 0, open: 0, runs: 0}), 3)
    assert.equal(need({calls: 5, open: 1, runs: 5}), 4)
    assert.equal(need({calls: 2, open: 0, runs: 2}), 1)
    assert.equal(need({calls: 9, open: 0, runs: 3}), 0)
})

test('tasks rank by what their ops need, then by how seldom they ran', () => {
    const stats = [
        {op: 'scene.open', calls: 9, errors: 0, runs: 3, open: 0},
        {op: 'scene.get_tree', calls: 9, errors: 0, runs: 3, open: 0},
        {op: 'node.rename', calls: 2, errors: 2, runs: 1, open: 2},
        {op: 'debug.launch', calls: 0, errors: 0, runs: 0, open: 0}
    ]
    const ranked = rankTasks(stats, BANK.tasks, new Map([['rename', 2]]))
    assert.deepEqual(
        ranked.map(t => t.id),
        ['debug', 'rename', 'open']
    )
    assert.deepEqual(ranked[0].wanted, ['debug.launch', 'debug.await_stop'])
    assert.deepEqual(ranked[1].wanted, ['node.rename'])
    assert.deepEqual(ranked[2].wanted, [])
    assert.equal(ranked[1].ran, 2)
})

test('the task bank refuses two tasks with one id, and the shipped bank names only catalogue ops', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tool-ledger-'))
    const twice = join(directory, 'twice.json')
    writeFileSync(twice, JSON.stringify({tasks: [BANK.tasks[0], BANK.tasks[0]]}))
    assert.throws(() => loadTaskBank(twice), /names open twice/u)

    const catalogue = new Set(catalogueOperations())
    const shipped = loadTaskBank()
    for (const task of shipped)
        for (const op of task.ops)
            assert.ok(
                catalogue.has(op),
                `${task.id} aims at ${op}, which the catalogue does not have`
            )
    const aimed = new Set(shipped.flatMap(task => task.ops))
    const unaimed = [...catalogue].filter(op => !aimed.has(op))
    assert.deepEqual(unaimed, [], 'every catalogue op needs a task that aims at it')
})
