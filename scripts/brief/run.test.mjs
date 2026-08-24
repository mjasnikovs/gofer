import assert from 'node:assert/strict'
import test from 'node:test'
import {BRIEF_PHASES, runBrief} from './run.mjs'

/*
 * The pipeline itself, driven end to end with no provider behind it.
 *
 * What is pinned here is not what a phase writes — `phases.test.mjs` owns that — but how a run ENDS.
 * Every way out used to be its own path, and three of them emitted nothing at all: a probe that
 * threw, a question the backend refused, and any fault in the file itself. The window draws its
 * panel from these events, so a run with no ending sat on a spinner and then vanished, taking the
 * way out of a failed plan with it.
 */

/** A spec good enough to pass compose's VERIFY gate. */
const SPEC = 'GOAL\nA pause menu.\n\nVERIFY\n```sh\nnpm run check\n```'

/** A world where every child answers with `text`, and nothing reaches a provider. */
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

/** The single ending event a run emitted, and a failure when it emitted none or several. */
const endingOf = events => {
    const endings = events.filter(
        event => event.type === 'brief-failed' || event.type === 'brief-stopped'
    )
    assert.equal(endings.length, 1, `expected one ending, got ${JSON.stringify(endings)}`)
    return endings[0]
}

/*
 * The panel's live line comes out of the delegation, not out of this loop.
 *
 * What is proved here is the wiring rather than the wording: the loop hands every worker a sink it
 * did not write, and whatever the sub-agent puts through it arrives as an event the panel knows,
 * named after the worker it belongs to. Before this the loop reported which of seven delegations was
 * running and nothing else, so the four minutes inside one of them looked identical to a hang.
 */
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
    // Named after the worker, because four of them run one after another and a line with no worker
    // on it cannot be drawn beside the one it belongs to.
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

/*
 * The probe runs before the first phase, so a dead tool is named in seconds rather than eight
 * minutes in. It threw straight out of the function, past the only place that emits an ending.
 */
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

/*
 * The question surface is an ordinary tool call over the backend's channel. A backend that refuses
 * it — no window, a turn already gone — rejected inside grill, which is nowhere near a phase's own
 * failure type.
 */
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

/*
 * The other way a question ends: the user presses Stop while the plan is waiting on them.
 *
 * `host.call` rejects an aborted call with a plain `Error`, because the host has never heard of a
 * phase — so this took the failure arm above and the panel reported a broken plan, for the most
 * ordinary way there is to cancel one. A stop is an outcome of a run that worked.
 */
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

// A phase that cannot produce anything trustworthy is an outcome of a run that worked, so the run
// answers with nothing rather than throwing — but it still says so on the same event.
test('a phase that cannot finish ends the run without breaking the worker', async () => {
    const {events, promise} = run({world: worldSaying('no verify block anywhere in here')})
    assert.equal(await promise, null)

    const ending = endingOf(events)
    assert.equal(ending.type, 'brief-failed')
    assert.equal(ending.phase, 'compose')
})

/*
 * The ceiling is checked before every worker, not only at a phase boundary. Research runs up to
 * eight workers between two boundaries and compose two whole drafts, so a boundary alone let a
 * runaway spend most of a run past its deadline.
 */
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

// Time spent waiting for a person is not time the run spent working, so a slow answer never trips
// the ceiling. The clock only moves while the user is being asked.
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

// Nothing to plan is refused before a run exists at all, so there is no panel and no row to close.
test('a brief with nothing to plan never starts', async () => {
    const events = []
    await assert.rejects(
        runBrief({prompt: '   ', emit: event => events.push(event), world: worldSaying(SPEC)}),
        /no task to work from/u
    )
    assert.deepEqual(events, [])
})

/*
 * A picture pasted with the ask is part of the ask.
 *
 * Only refine is shown it, and that is the design rather than a shortcut: the three phases after it
 * read the text it wrote, so the step that reads the raw ask is the only one that can look at what
 * the ask is about. It is also the only step that can write down what it saw — see `picturesNote`.
 */
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
    // And it is told they are there, because nothing after it can see them.
    assert.match(withPictures[0].prompt, /1 attached image/u)
})

/*
 * A model that cannot read a picture is not handed one.
 *
 * The sub-agent's model is the user's own choice and need not be the model the composer offered the
 * paperclip for. A text-only model does not ignore an image — the provider refuses the request — so
 * an unchecked picture would end the first phase of a fifteen-minute run. Said out loud, because a
 * plan written without the screenshot it was asked about is wrong in a way only the user can see.
 */
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
