import assert from 'node:assert/strict'
import test from 'node:test'
import {BRIEF_PHASES, runBrief} from './run.mjs'

const SPEC = 'GOAL\nA pause menu.\n\nVERIFY\n```sh\nnpm run check\n```'

const worldSaying = text => ({
    createModelContext: () => ({
        models: {},
        model: 'fake',
        subagent: {model: 'fake', thinkingLevel: 'none'},
        streamOptions: {}
    }),
    createChildTools: () => ({tools: [], env: {cleanup: async () => undefined}}),
    probeTools: async () => undefined,
    runSubagentOutcome: async ({prompt}) => ({
        kind: 'ok',
        text: typeof text === 'function' ? text(prompt) : text,
        usage: {input: 10, output: 5}
    })
})

const run = (overrides = {}) => {
    const events = []
    const promise = runBrief({
        prompt: 'add a pause menu',
        workspacePath: '/nowhere',
        host: {call: async () => ({answer: ''})},
        emit: event => events.push(event),
        world: worldSaying(SPEC),
        ...overrides
    })
    return {events, promise}
}

const endingOf = events => {
    const endings = events.filter(
        event => event.type === 'brief-failed' || event.type === 'brief-stopped'
    )
    assert.equal(endings.length, 1, `expected one ending, got ${JSON.stringify(endings)}`)
    return endings[0]
}

test('every worker reports what it is doing, through a sink the loop did not write', async () => {
    const world = worldSaying(SPEC)
    world.runSubagentOutcome = async ({progress}) => {
        progress({line: 'bash: rg -n Main', steps: 1, count: 1})
        return {kind: 'ok', text: SPEC, usage: {input: 10, output: 5}}
    }
    const {events, promise} = run({world})
    await promise

    const steps = events.filter(event => event.type === 'brief-worker-step')
    assert.ok(steps.length >= 4, `expected a step from every worker, got ${steps.length}`)
    assert.equal(steps[0].line, 'bash: rg -n Main')
    assert.ok(
        steps.some(step => step.label === 'worker:files'),
        JSON.stringify(steps)
    )
})

test('a run that finishes announces every phase and delivers the specification', async () => {
    const {events, promise} = run()
    assert.equal(await promise, SPEC)

    assert.deepEqual(
        events.filter(event => event.type === 'brief-phase').map(event => event.field),
        BRIEF_PHASES.map(phase => phase.field),
        'each phase announces the field it fills, in order'
    )
    assert.equal(events[0].type, 'brief-started', 'and says it exists before anything slow happens')
    assert.equal(
        events.filter(e => e.type === 'brief-failed' || e.type === 'brief-stopped').length,
        0
    )
})

test('a probe that fails ends the run out loud', async () => {
    const world = worldSaying(SPEC)
    world.probeTools = async () => {
        throw new Error('the read tool answered with nothing')
    }
    const {events, promise} = run({world})
    await assert.rejects(promise, /the read tool answered with nothing/u)

    const ending = endingOf(events)
    assert.equal(ending.type, 'brief-failed')
    assert.match(ending.reason, /the read tool answered with nothing/u)
    assert.equal(ending.phase, 'startup', 'and says the run never reached a phase')
})

test('a question the backend refuses ends the run out loud', async () => {
    const world = worldSaying(prompt =>
        prompt.includes('ANSWER:') ?
            'UNKNOWN: a person has to decide'
        :   'QUESTION: how should the menu close?\nA: Escape\nB: a button\nWHY: it decides the input map'
    )
    const {events, promise} = run({
        world,
        host: {
            call: async () => {
                throw new Error('there is no window to ask')
            }
        }
    })
    await assert.rejects(promise, /there is no window to ask/u)

    const ending = endingOf(events)
    assert.equal(ending.type, 'brief-failed')
    assert.match(ending.reason, /there is no window to ask/u)
    assert.equal(ending.phase, 'grill', 'and says where it was when it broke')
})

test('a stop while a plan waits on the user ends it as stopped, not as broken', async () => {
    const world = worldSaying(prompt =>
        prompt.includes('ANSWER:') ?
            'UNKNOWN: a person has to decide'
        :   'QUESTION: how should the menu close?\nA: Escape\nB: a button\nWHY: it decides the input map'
    )
    const stopping = new AbortController()
    const {events, promise} = run({
        world,
        signal: stopping.signal,
        host: {
            call: async () => {
                stopping.abort()
                throw new Error('The tool call was cancelled')
            }
        }
    })
    assert.equal(await promise, null, 'a stop is not a fault, so the worker exits cleanly')

    const ending = endingOf(events)
    assert.equal(ending.type, 'brief-stopped')
    assert.equal(ending.phase, 'grill')
})

test('a phase that cannot finish ends the run without breaking the worker', async () => {
    const {events, promise} = run({world: worldSaying('no verify block anywhere in here')})
    assert.equal(await promise, null)

    const ending = endingOf(events)
    assert.equal(ending.type, 'brief-failed')
    assert.equal(ending.phase, 'compose')
})

test('the deadline ends a run inside a phase, not only between two', async () => {
    let clock = 0
    const world = worldSaying(SPEC)
    world.runSubagentOutcome = async () => {
        clock += 5 * 60 * 1000
        return {kind: 'ok', text: SPEC, usage: {input: 1, output: 1}}
    }
    const {events, promise} = run({world, now: () => clock, deadlineMs: 12 * 60 * 1000})
    assert.equal(await promise, null)

    const ending = endingOf(events)
    assert.equal(ending.type, 'brief-failed')
    assert.equal(ending.phase, 'research', 'the phase it was inside, not the next one')
    assert.match(ending.reason, /still on research after \d+ minutes/u)
})

test('a run held up by a person is not a runaway', async () => {
    let clock = 0
    const world = worldSaying(prompt =>
        prompt.includes('ANSWER:') ? 'UNKNOWN: a person has to decide'
        : prompt.includes('QUESTION') ? 'NONE'
        : SPEC
    )
    const {events, promise} = run({
        world,
        now: () => clock,
        deadlineMs: 10 * 60 * 1000,
        host: {
            call: async () => {
                clock += 60 * 60 * 1000
                return {answer: 'Escape'}
            }
        }
    })
    assert.equal(await promise, SPEC)
    assert.equal(
        events.filter(e => e.type === 'brief-failed' || e.type === 'brief-stopped').length,
        0
    )
})

test('a brief with nothing to plan never starts', async () => {
    const events = []
    await assert.rejects(
        runBrief({prompt: '   ', emit: event => events.push(event), world: worldSaying(SPEC)}),
        /no task to work from/u
    )
    assert.deepEqual(events, [])
})

test('the pictures the ask came with reach the phase that reads the ask', async () => {
    const world = worldSaying(SPEC)
    world.createModelContext = () => ({
        models: {},
        model: 'fake',
        subagent: {model: {input: ['text', 'image']}, thinkingLevel: 'none'},
        streamOptions: {}
    })
    const shown = []
    world.runSubagentOutcome = async ({prompt, images}) => {
        shown.push({images, prompt})
        return {kind: 'ok', text: SPEC, usage: {input: 10, output: 5}}
    }

    const {promise} = run({world, images: [{data: 'aGk=', mimeType: 'image/png'}]})
    await promise

    const withPictures = shown.filter(call => call.images.length > 0)
    assert.equal(withPictures.length, 1, 'exactly one worker is shown the pictures')
    assert.deepEqual(withPictures[0].images, [{type: 'image', data: 'aGk=', mimeType: 'image/png'}])
    assert.match(withPictures[0].prompt, /1 attached image/u)
})

test('a plan whose model cannot read a picture says so instead of failing', async () => {
    const world = worldSaying(SPEC)
    world.createModelContext = () => ({
        models: {},
        model: 'fake',
        subagent: {model: {input: ['text']}, thinkingLevel: 'none'},
        streamOptions: {}
    })
    const shown = []
    world.runSubagentOutcome = async ({images}) => {
        shown.push(images)
        return {kind: 'ok', text: SPEC, usage: {input: 10, output: 5}}
    }

    const {events, promise} = run({world, images: [{data: 'aGk=', mimeType: 'image/png'}]})
    await promise

    assert.ok(
        shown.every(images => images.length === 0),
        'no worker is handed a picture its model cannot read'
    )
    const logs = events.filter(event => event.type === 'brief-log')
    assert.ok(
        logs.some(event => /cannot read images/u.test(event.message)),
        `expected the run to say the pictures were left out, got ${JSON.stringify(logs)}`
    )
})
