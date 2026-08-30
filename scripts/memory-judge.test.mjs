import assert from 'node:assert/strict'
import test from 'node:test'
import {JUDGE_TOOL_NAMES, judgePrompt, parseVerdict, runMemoryJudge} from './memory-judge.mjs'

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

const endingOf = events => {
    const endings = events.filter(event =>
        ['judge-verdict', 'judge-failed', 'judge-stopped'].includes(event.type)
    )
    assert.equal(endings.length, 1, `expected one ending, got ${JSON.stringify(endings)}`)
    return endings[0]
}

test('an answer that carries no verdict is not read as one', () => {
    assert.equal(
        parseVerdict('The file is definitely still there and everything holds.').verdict,
        'unclear'
    )
    assert.equal(parseVerdict('').verdict, 'unclear')
    assert.equal(parseVerdict('VERDICT: probably\nit seems fine').verdict, 'unclear')
    assert.equal(parseVerdict(undefined).verdict, 'unclear')
})

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

test('the verdict line is read however the model cased it', () => {
    assert.equal(parseVerdict('verdict:  Holds \nfine').verdict, 'holds')
})

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
