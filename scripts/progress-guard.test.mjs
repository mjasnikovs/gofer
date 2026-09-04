import assert from 'node:assert/strict'
import test from 'node:test'
import {
    NO_NEW_GROUND_LIMIT,
    REFUSALS_BEFORE_ENDING,
    SAME_CALL_LIMIT,
    createProgressGuard,
    normalisedKey,
    resultDigest
} from './progress-guard.mjs'

const WORDS =
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(
        ' '
    )

// Digits fold inside the guard, so a fixture that wants distinct calls names them with words.
function word(index) {
    return `${WORDS[index % WORDS.length]}-${WORDS[Math.floor(index / WORDS.length) % WORDS.length]}`
}

function answering(name, answer = params => JSON.stringify(params)) {
    return {
        name,
        execute: async (_id, params) => ({content: [{type: 'text', text: answer(params)}]})
    }
}

async function call(tool, params, signal) {
    try {
        return {ok: await tool.execute('id', params, signal)}
    } catch (error) {
        return {refused: error.message}
    }
}

async function repeat(tool, params, times) {
    const outcomes = []
    for (let index = 0; index < times; index += 1) outcomes.push(await call(tool, params))
    return outcomes
}

test('the eighth identical call in a row is refused and named', async () => {
    const guard = createProgressGuard()
    const bash = guard.decorate(answering('bash', () => 'game-launched\n'))

    const outcomes = await repeat(bash, {command: 'echo game-launched'}, SAME_CALL_LIMIT)
    assert.ok(outcomes.slice(0, -1).every(outcome => outcome.ok))
    const refusal = outcomes.at(-1).refused
    assert.match(refusal, /^Refused: this is the 8th bash call in a row/u)
    assert.match(refusal, /"command":"echo game-launched"/u)
    assert.match(refusal, /2 more will end this turn/u)
    assert.equal(guard.verdict(), undefined)
})

test('a digit that changes between calls does not make a different call', async () => {
    const guard = createProgressGuard()
    const read = guard.decorate(answering('read'))
    const outcomes = []
    for (let offset = 1; offset <= SAME_CALL_LIMIT; offset += 1)
        outcomes.push(await call(read, {path: 'a.gd', offset: offset % 2 === 0 ? 80 : 300}))
    assert.match(outcomes.at(-1).refused, /8th read call in a row/u)

    assert.equal(normalisedKey('read', {a: 1, b: 2}), normalisedKey('read', {b: 2, a: 1}))
    assert.equal(
        normalisedKey('bash', {command: 'sleep 10'}),
        normalisedKey('bash', {command: 'sleep   2'})
    )
    assert.notEqual(normalisedKey('read', {path: 'a.gd'}), normalisedKey('read', {path: 'b.gd'}))
})

test('an ack between two pieces of work never counts', async () => {
    const guard = createProgressGuard()
    const stop = guard.decorate(answering('godot_runtime', () => '{"op":"stopped"}'))
    const read = guard.decorate(answering('read'))

    for (let index = 0; index < 40; index += 1) {
        assert.ok((await call(stop, {ops: [{op: 'stop'}]})).ok)
        assert.ok((await call(read, {path: `${word(index)}.gd`})).ok)
    }
    assert.equal(guard.verdict(), undefined)
})

test('ten results already seen end the streak, one new result resets it', async () => {
    const guard = createProgressGuard()
    let index = 0
    const read = guard.decorate(answering('read', () => `same bytes`))
    const fresh = guard.decorate(answering('read', () => `fresh ${String((index += 1))}`))

    assert.ok((await call(read, {path: 'seen.gd'})).ok)
    for (let attempt = 0; attempt < NO_NEW_GROUND_LIMIT - 1; attempt += 1)
        assert.ok((await call(read, {path: `again-${word(attempt)}.gd`})).ok)
    assert.ok((await call(fresh, {path: 'new.gd'})).ok)
    for (let attempt = 0; attempt < NO_NEW_GROUND_LIMIT; attempt += 1)
        assert.ok((await call(read, {path: `once-more-${word(attempt)}.gd`})).ok)

    const refusal = (await call(read, {path: 'seen.gd'})).refused
    assert.match(refusal, /^Refused: the last 10 tool results taught you nothing/u)

    const broken = createProgressGuard().decorate({
        name: 'bash',
        execute: () => Promise.reject(new Error('command not found'))
    })
    for (let attempt = 0; attempt < NO_NEW_GROUND_LIMIT; attempt += 1)
        assert.match((await call(broken, {command: word(attempt)})).refused, /not found/u)
    assert.match((await call(broken, {command: word(0)})).refused, /taught you nothing/u)
})

test('a call never made this turn still runs while the streak stands', async () => {
    const guard = createProgressGuard()
    const stale = guard.decorate(answering('read', () => 'same bytes'))
    const fresh = guard.decorate(answering('read', params => `fresh ${params.path}`))
    assert.ok((await call(stale, {path: 'seen.gd'})).ok)
    for (let attempt = 0; attempt < NO_NEW_GROUND_LIMIT; attempt += 1)
        assert.ok((await call(stale, {path: `${word(attempt)}.gd`})).ok)

    assert.match((await call(stale, {path: 'seen.gd'})).refused, /taught you nothing/u)
    assert.ok((await call(fresh, {path: 'never-before.gd'})).ok)
    assert.ok((await call(stale, {path: 'seen.gd'})).ok)
    assert.equal(guard.verdict(), undefined)
})

test('three no-new-ground refusals end the run whichever calls they land on', async () => {
    const guard = createProgressGuard()
    const stale = guard.decorate(answering('read', () => 'same bytes'))
    for (let attempt = 0; attempt <= NO_NEW_GROUND_LIMIT; attempt += 1)
        assert.ok((await call(stale, {path: `${word(attempt)}.gd`})).ok)

    const refused = []
    for (let attempt = 0; attempt < REFUSALS_BEFORE_ENDING; attempt += 1)
        refused.push((await call(stale, {path: `${word(attempt)}.gd`})).refused)
    assert.match(refused[0], /taught you nothing/u)
    assert.match(refused[2], /^it looped: 1[0-9] tool results in a row returned nothing new/u)
    assert.equal(guard.verdict()?.cause, 'loop')
})

test('a reset forgets everything the probes taught it', async () => {
    const guard = createProgressGuard()
    const read = guard.decorate(answering('read', () => 'probe answer'))
    assert.ok((await call(read, {path: 'a.gd'})).ok)
    guard.reset()
    for (let attempt = 0; attempt < SAME_CALL_LIMIT - 1; attempt += 1)
        assert.ok((await call(read, {path: 'a.gd'})).ok)
    assert.match((await call(read, {path: 'a.gd'})).refused, /8th read call/u)
})

test('two screenshots with the same text and different bytes are different results', async () => {
    const shot = data => ({
        content: [
            {type: 'text', text: 'captured 640x360'},
            {type: 'image', data, mimeType: 'image/png'}
        ]
    })
    assert.notEqual(resultDigest(shot('aaaa')), resultDigest(shot('bbbb')))
    assert.equal(resultDigest(shot('aaaa')), resultDigest(shot('aaaa')))
})

test('the third refusal of one key ends the run and says it looped', async () => {
    const guard = createProgressGuard()
    const bash = guard.decorate(answering('bash', () => 'game-launched\n'))
    const outcomes = await repeat(
        bash,
        {command: 'echo game-launched'},
        SAME_CALL_LIMIT + REFUSALS_BEFORE_ENDING - 1
    )

    const refusals = outcomes.filter(outcome => outcome.refused)
    assert.equal(refusals.length, REFUSALS_BEFORE_ENDING)
    assert.match(refusals[1].refused, /One more will end this turn/u)
    assert.match(
        refusals[2].refused,
        /^it looped: bash \{"command":"echo game-launched"\} was made 10 times in a row, was refused 3 times this turn, and was asked for again$/u
    )
    assert.deepEqual(guard.verdict(), {cause: 'loop', reason: refusals[2].refused})

    const other = guard.decorate(answering('read'))
    assert.equal((await call(other, {path: 'a.gd'})).refused, refusals[2].refused)
})

test('an abort passes through the guard untouched', async () => {
    const guard = createProgressGuard()
    const stopped = new AbortController()
    stopped.abort()
    const bash = guard.decorate({
        name: 'bash',
        execute: () => Promise.reject(new Error('aborted'))
    })
    for (let attempt = 0; attempt < NO_NEW_GROUND_LIMIT + 1; attempt += 1)
        assert.equal((await call(bash, {command: 'ls'}, stopped.signal)).refused, 'aborted')

    const fresh = guard.decorate(answering('read'))
    assert.ok((await call(fresh, {path: 'a.gd'})).ok)
})

test('the recorded runaway trips at its 85th call, and the recorded legitimate shapes never do', async () => {
    const runaway = createProgressGuard()
    const work = runaway.decorate(answering('bash'))
    const stuck = runaway.decorate(answering('bash', () => 'game-launched\n'))
    let at = 0
    for (let index = 0; index < 77; index += 1) {
        at += 1
        assert.ok((await call(work, {command: `cat ${word(index)}.gd`})).ok)
    }
    let tripped
    for (let index = 0; index < 274 && tripped === undefined; index += 1) {
        at += 1
        const outcome = await call(stuck, {
            command: 'bash profiler_evidence/run_debug.sh > /dev/null 2>&1 &\necho game-launched'
        })
        if (outcome.refused) tripped = at
    }
    assert.equal(tripped, 85)

    const legitimate = createProgressGuard()
    const undo = legitimate.decorate(answering('godot_session', () => '{"undoDepth":0}'))
    const edit = legitimate.decorate(answering('godot_script'))
    const cont = legitimate.decorate(answering('godot_debug', () => '{"op":"continued"}'))
    const read = legitimate.decorate(answering('read'))
    for (let round = 0; round < 30; round += 1) {
        for (let depth = 0; depth < 4; depth += 1)
            assert.ok((await call(undo, {ops: [{op: 'undo'}]})).ok)
        for (let index = 0; index < 3; index += 1)
            assert.ok((await call(edit, {ops: [{op: 'edit', line: round * 10 + index}]})).ok)
        assert.ok((await call(cont, {ops: [{op: 'continue'}]})).ok)
        assert.ok((await call(read, {path: `${word(round)}.tscn`})).ok)
        for (let index = 0; index < 4; index += 1)
            assert.ok((await call(read, {path: `${word(round)}.tscn`, offset: index})).ok)
    }
    assert.equal(legitimate.verdict(), undefined)
})
