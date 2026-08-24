import assert from 'node:assert/strict'
import test from 'node:test'
import {JUDGE_TOOL_NAMES, judgePrompt, parseVerdict, runMemoryJudge} from './memory-judge.mjs'

/** A world where the child answers with `text` and nothing reaches a provider. */
const worldSaying = text => ({
    createModelContext: () => ({
        models: {},
        model: {id: 'the-parent', name: 'The Parent'},
        subagent: {model: {id: 'the-child', name: 'The Child'}, thinkingLevel: 'off'},
        streamOptions: {}
    }),
    createChildTools: () => ({tools: [], env: {cleanup: async () => undefined}}),
    probeTools: async () => undefined,
    runSubagentOutcome: async () => ({
        kind: 'ok',
        text: typeof text === 'function' ? text() : text,
        usage: {input: 10, output: 5}
    })
})

const MEMORY = {
    id: 'one',
    content: 'User request: delete GRAYZONE.md\nOutcome: deleted it.',
    anchors: [{named: 'GRAYZONE.md'}]
}

const judge = (overrides = {}) => {
    const events = []
    const promise = runMemoryJudge({
        workspacePath: '/nowhere',
        memory: MEMORY,
        emit: event => events.push(event),
        world: worldSaying('VERDICT: holds\nGRAYZONE.md is still absent from the checkout.'),
        ...overrides
    })
    return {events, promise}
}

/** The single ending event a judgement emitted, and a failure when it emitted none or several. */
const endingOf = events => {
    const endings = events.filter(event =>
        ['judge-verdict', 'judge-failed', 'judge-stopped'].includes(event.type)
    )
    assert.equal(endings.length, 1, `expected one ending, got ${JSON.stringify(endings)}`)
    return endings[0]
}

/*
 * An answer with no verdict line is unclear, never holds.
 *
 * This is the same rule a verification point keeps: the exit code decides and nothing else, because
 * reading the output to guess at a verdict is how you get a check that passes on the word ERROR in
 * a filename. A judge has no exit code, so the marker is it. Defaulting the other way would turn
 * every model that ignored the format — a small one, a stalled one, one that wrote an essay — into
 * a memory confirmed by a machine that never confirmed it.
 */
test('an answer that carries no verdict is not read as one', () => {
    assert.equal(
        parseVerdict('The file is definitely still there and everything holds.').verdict,
        'unclear'
    )
    assert.equal(parseVerdict('').verdict, 'unclear')
    assert.equal(parseVerdict('VERDICT: probably\nit seems fine').verdict, 'unclear')
    assert.equal(parseVerdict(undefined).verdict, 'unclear')
})

/** What the model did write is kept, so an unreadable answer can still be looked at. */
test('an unreadable answer is quoted rather than thrown away', () => {
    const {reason} = parseVerdict('Everything checks out fine.')

    assert.match(reason, /did not answer with a verdict line/u)
    assert.match(reason, /Everything checks out fine\./u)
})

test('a marked verdict is read with the sentence under it', () => {
    const {verdict, reason} = parseVerdict(
        'VERDICT: broken\nscripts/placement.gd no longer has a roster; it was rewritten as a grid.'
    )

    assert.equal(verdict, 'broken')
    assert.equal(reason, 'scripts/placement.gd no longer has a roster; it was rewritten as a grid.')
})

/** Case and stray spacing are the model's, not the contract's. */
test('the verdict line is read however the model cased it', () => {
    assert.equal(parseVerdict('verdict:  Holds \nfine').verdict, 'holds')
})

/*
 * What the path check already settled is handed over rather than left to be rediscovered.
 *
 * A child told nothing spends its first steps running find for a file the caller already knows is
 * gone. Saying so costs one line and is the difference between three steps and one.
 */
test('the child is told which of the memory’s files are already known to be missing', () => {
    const prompt = judgePrompt({
        content: 'deleted it',
        anchors: [{named: 'gone.md'}, {named: 'a.gd', resolved: 'src/a.gd'}]
    })

    assert.match(prompt, /NOT in this checkout: gone\.md/u)
    assert.match(prompt, /exist here: src\/a\.gd/u)
    assert.match(prompt, /do not spend steps confirming it/u)
})

test('a memory naming no file is put to the child without notes about files', () => {
    const prompt = judgePrompt({content: 'we discussed two layouts'})

    assert.doesNotMatch(prompt, /exist here/u)
    assert.doesNotMatch(prompt, /NOT in this checkout/u)
    assert.match(prompt, /--- MEMORY BEGINS ---/u)
})

/** A judgement says how it ended on exactly one event, whichever way it ended. */
test('a verdict reaches the backend with what it cost', async () => {
    const {events, promise} = judge()
    await promise

    const ending = endingOf(events)
    assert.equal(ending.type, 'judge-verdict')
    assert.equal(ending.verdict, 'holds')
    assert.match(ending.reason, /still absent/u)
    assert.equal(ending.input, 10)
    assert.equal(ending.output, 5)
})

/*
 * The verdict is filed under the model that reached it, which is the child's and not the parent's.
 *
 * The two are allowed to differ and usually do: a large model drives the conversation while a small
 * local one does the reading. The same sentence is worth different things from each, so a verdict
 * with the wrong name against it is a verdict nobody can weigh.
 */
test('a verdict is attributed to the model that actually reached it', async () => {
    const {events, promise} = judge()
    await promise

    assert.equal(endingOf(events).model, 'The Child')
})

test('a stopped judgement is reported as the user’s doing, not as a fault', async () => {
    const world = worldSaying('')
    world.runSubagentOutcome = async () => ({kind: 'stopped', reason: 'the turn was stopped'})
    const {events, promise} = judge({world})

    assert.equal(await promise, null)
    assert.equal(endingOf(events).type, 'judge-stopped')
})

/*
 * A stop that lands in the probe is the same stop as one that lands in the child.
 *
 * The abort signal became live for the first time in this build — the worker had always passed
 * `undefined` — and only the child's own verdict was ever told apart from a fault. Everything before
 * it throws instead: `withDeadline` rejects a stopped probe with "the turn was stopped", which the
 * catch reported as `judge-failed`, so pressing Stop left the row reading "Judging failed" for the
 * most ordinary way there is to cancel one. Rust sends `judge-stopped` afterwards and loses, because
 * the panel keeps the first ending it is given.
 */
test('a stop before the child answers is a stop, not a failure', async () => {
    const controller = new AbortController()
    const world = worldSaying('')
    world.probeTools = async () => {
        controller.abort()
        throw new Error('the turn was stopped')
    }
    const {events, promise} = judge({world, signal: controller.signal})

    assert.equal(await promise, null, 'a stop is not rethrown, so the worker exits cleanly')
    assert.equal(endingOf(events).type, 'judge-stopped')
})

test('a child that could not answer ends the judgement rather than leaving it running', async () => {
    const world = worldSaying('')
    world.runSubagentOutcome = async () => ({kind: 'failed', reason: 'it used all of its steps'})
    const {events, promise} = judge({world})

    assert.equal(await promise, null)
    assert.equal(endingOf(events).reason, 'it used all of its steps')
})

/*
 * A probe that refuses is an ending too.
 *
 * It used to be the same thing to the window as a judgement still running: nothing, for ever. A
 * dead read tool looks exactly like a model that chose not to read anything, so the judgement it
 * would have produced is a confident verdict formed without opening a file.
 */
test('a tool that cannot answer ends the judgement before a model is reached', async () => {
    const world = worldSaying('')
    world.probeTools = async () => {
        throw new Error('read could not answer')
    }
    world.runSubagentOutcome = async () => {
        throw new Error('the model must not be reached')
    }
    const {events, promise} = judge({world})

    await assert.rejects(promise, /read could not answer/u)
    assert.equal(endingOf(events).reason, 'read could not answer')
})

/** A judge that could write is a judge that can make its own verdict true. */
test('the child is given reading tools and nothing else', async () => {
    let asked
    const world = worldSaying('VERDICT: holds\nfine')
    world.createChildTools = (_path, options) => {
        asked = options.toolNames
        return {tools: [], env: {cleanup: async () => undefined}}
    }
    const {promise} = judge({world})
    await promise

    assert.deepEqual(asked, ['read', 'bash'])
    assert.deepEqual(JUDGE_TOOL_NAMES, ['read', 'bash'])
})

test('a memory with nothing in it is refused before anything is built', async () => {
    await assert.rejects(
        runMemoryJudge({memory: {id: 'one', content: '  '}, emit: () => undefined}),
        /no memory to check/u
    )
})
