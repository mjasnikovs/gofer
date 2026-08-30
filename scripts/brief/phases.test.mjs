import assert from 'node:assert/strict'
import test from 'node:test'
import {
    PhaseFailed,
    PhaseStopped,
    RESEARCH_WORKERS,
    compose,
    declaresNoCommands,
    formatAnswers,
    grill,
    parseAutoAnswer,
    parseQuestion,
    parseVerifyBlock,
    parseVerifyPoints,
    refine,
    research,
    stripPreamble
} from './phases.mjs'
import {scopedGoal} from './prompts.mjs'

const ok = text => ({kind: 'ok', text, usage: {}, turns: 1})
const failed = (cause, reason = 'because') => ({kind: 'failed', cause, reason, attempts: 1})
const stopped = {kind: 'stopped', reason: 'the turn was stopped'}

function scriptedWorker(answers) {
    const calls = []
    return {
        calls,
        run: async spec => {
            calls.push(spec)
            const answer = answers[calls.length - 1] ?? answers.at(-1)
            return typeof answer === 'function' ? answer(spec) : answer
        }
    }
}

const REFINED = 'GOAL\nAdd a pause menu.\n\nCONSTRAINTS\n- keep the existing input map\n'

test('refine sharpens the ask, and falls back to it rather than ending the run', async () => {
    const sharp = scriptedWorker([ok(REFINED)])
    assert.equal(await refine('pause menu pls', {runWorker: sharp.run}), REFINED)
    assert.deepEqual(sharp.calls[0].toolNames, ['read'])

    const silent = scriptedWorker([failed('no-answer')])
    assert.equal(await refine('pause menu pls', {runWorker: silent.run}), 'pause menu pls')
})

test('an optional block left out leaves the prompt byte-identical', async () => {
    const bare = scriptedWorker([ok(REFINED)])
    await refine('do a thing', {runWorker: bare.run})
    const withEmpty = scriptedWorker([ok(REFINED)])
    await refine('do a thing', {runWorker: withEmpty.run, planContext: '   ', existingFiles: ''})
    assert.equal(bare.calls[0].prompt, withEmpty.calls[0].prompt)

    const withBlock = scriptedWorker([ok(REFINED)])
    await refine('do a thing', {runWorker: withBlock.run, planContext: 'step two does the HUD'})
    assert.notEqual(bare.calls[0].prompt, withBlock.calls[0].prompt)
    assert.match(withBlock.calls[0].prompt, /step two does the HUD/u)
})

test('research assembles its four sections in a fixed order', async () => {
    const worker = scriptedWorker([
        ok('FILES\n  a.gd  changed'),
        ok('APIS\n  Node.ready()'),
        ok('CONTEXT\n- it is a project'),
        ok('TOOLING\n  npm test  runs')
    ])
    const text = await research(REFINED, {runWorker: worker.run})

    assert.deepEqual(
        worker.calls.map(call => call.label),
        ['worker:files', 'worker:apis', 'worker:context', 'worker:tooling']
    )
    assert.ok(text.indexOf('FILES') < text.indexOf('APIS'))
    assert.ok(text.indexOf('APIS') < text.indexOf('CONTEXT'))
    assert.ok(text.indexOf('CONTEXT') < text.indexOf('TOOLING'))
})

test('a worker with nothing to say is retried once, then recorded as empty', async () => {
    const worker = scriptedWorker([
        failed('no-answer'),
        failed('no-answer'),
        ok('APIS\n  x'),
        ok('CONTEXT\n- y'),
        ok('TOOLING\n  z')
    ])
    const text = await research(REFINED, {runWorker: worker.run})

    assert.equal(worker.calls.length, 5)
    assert.match(worker.calls[1].prompt, /^STOP\. Your previous attempt returned an EMPTY answer/u)
    assert.match(text, /\(none — the FILES worker ran and reported nothing/u)
})

test('the empty retry is taken when it answers', async () => {
    const worker = scriptedWorker([
        failed('no-answer'),
        ok('FILES\n  found on the second look'),
        ok('APIS'),
        ok('CONTEXT'),
        ok('TOOLING')
    ])
    const text = await research(REFINED, {runWorker: worker.run})
    assert.match(text, /found on the second look/u)
})

test('a worker cut off mid-explore degrades and the rest still run', async () => {
    const worker = scriptedWorker([
        ok('FILES\n  a.gd'),
        spec =>
            spec.label === 'worker:apis' ? failed('step-ceiling', 'ran out of steps') : ok('x'),
        ok('CONTEXT\n- y'),
        ok('TOOLING\n  z')
    ])
    const text = await research(REFINED, {runWorker: worker.run})
    assert.match(text, /\(degraded: the APIS worker ran out of steps/u)
    assert.match(text, /CONTEXT/u)
    assert.match(text, /TOOLING/u)
})

test('a reported cause ends the phase instead of being laundered into a section', async () => {
    const worker = scriptedWorker([ok('FILES'), failed('model-error', 'the endpoint refused')])
    await assert.rejects(research(REFINED, {runWorker: worker.run}), error => {
        assert.ok(error instanceof PhaseFailed)
        assert.equal(error.phase, 'research')
        assert.match(error.reason, /endpoint refused/u)
        return true
    })
})

test('a stop is never degraded past', async () => {
    const worker = scriptedWorker([ok('FILES'), stopped])
    await assert.rejects(research(REFINED, {runWorker: worker.run}), error => {
        assert.ok(error instanceof PhaseStopped)
        return true
    })
})

test('only the APIS worker reaches past the worktree, and only when search is configured', async () => {
    const withSearch = scriptedWorker([ok('a'), ok('b'), ok('c'), ok('d')])
    await research(REFINED, {runWorker: withSearch.run, canSearch: true})
    const tools = Object.fromEntries(withSearch.calls.map(call => [call.label, call.toolNames]))
    assert.deepEqual(tools['worker:apis'], ['read', 'bash', 'godot_docs_search', 'web_search'])
    assert.deepEqual(tools['worker:files'], ['read', 'bash'])
    assert.deepEqual(tools['worker:context'], ['read', 'bash'])
    assert.deepEqual(tools['worker:tooling'], ['read', 'bash'])

    const offline = scriptedWorker([ok('a'), ok('b'), ok('c'), ok('d')])
    await research(REFINED, {runWorker: offline.run, canSearch: false})
    assert.deepEqual(offline.calls[1].toolNames, ['read', 'bash', 'godot_docs_search'])
})

test('the APIS worker is handed the finished FILES map', async () => {
    const worker = scriptedWorker([ok('FILES\n  src/player.gd  moves'), ok('b'), ok('c'), ok('d')])
    await research(REFINED, {runWorker: worker.run})
    assert.match(worker.calls[1].prompt, /src\/player\.gd {2}moves/u)
})

test('the tooling worker is not shown the per-file checklist', () => {
    const bulleted = 'GOAL\nMake the HUD work.\n- edit a.gd\n- edit b.gd\n\nCONSTRAINTS\n- none\n'
    assert.equal(scopedGoal(bulleted), 'Make the HUD work.')
    assert.equal(scopedGoal('no headings at all'), 'no headings at all')
})

const QUESTION =
    'QUESTION: Where does the menu live?\nA: its own scene\nB: inside the HUD\nWHY: it changes the tree'

test('a question is parsed, and NONE ends the round', () => {
    assert.deepEqual(parseQuestion(QUESTION), {
        question: 'Where does the menu live?',
        options: ['its own scene', 'inside the HUD'],
        why: 'it changes the tree'
    })
    assert.equal(parseQuestion('NONE'), null)
    assert.equal(parseQuestion('  '), null)
    assert.equal(parseQuestion('I have no questions for you.'), null)
})

test('only an ANSWER tag settles a question', () => {
    assert.equal(
        parseAutoAnswer('ANSWER: its own scene, like every other menu'),
        'its own scene, like every other menu'
    )
    assert.equal(parseAutoAnswer('UNKNOWN: the project does not say'), null)
    assert.equal(parseAutoAnswer('probably its own scene?'), null)
})

test('grill answers from research where it can and asks the user where it cannot', async () => {
    const worker = scriptedWorker([
        ok(QUESTION),
        ok('ANSWER: its own scene, matching src/ui/'),
        ok(QUESTION.replace('Where does', 'When does')),
        ok('UNKNOWN: nothing in the project decides this'),
        ok('NONE')
    ])
    const asked = []
    const settled = await grill(REFINED, 'RESEARCH', {
        runWorker: worker.run,
        askUser: question => {
            asked.push(question.question)
            return 'inside the HUD'
        }
    })

    assert.equal(settled.length, 2)
    assert.equal(settled[0].from, 'research')
    assert.equal(settled[0].answer, 'its own scene, matching src/ui/')
    assert.equal(settled[1].from, 'user')
    assert.equal(settled[1].answer, 'inside the HUD')
    assert.deepEqual(asked, ['When does the menu live?'])
})

test('what has been asked already travels into the next question', async () => {
    const worker = scriptedWorker([ok(QUESTION), ok('ANSWER: yes'), ok('NONE')])
    await grill(REFINED, 'RESEARCH', {runWorker: worker.run})
    assert.doesNotMatch(worker.calls[0].prompt, /ALREADY ASKED/u)
    assert.match(worker.calls[2].prompt, /ALREADY ASKED/u)
    assert.match(worker.calls[2].prompt, /Where does the menu live\?/u)
})

test('a skip is recorded as a decision, not as a missing answer', async () => {
    const worker = scriptedWorker([ok(QUESTION), ok('UNKNOWN: nope'), ok('NONE')])
    const settled = await grill(REFINED, 'RESEARCH', {runWorker: worker.run, askUser: () => null})
    assert.equal(settled[0].from, 'skipped')
    assert.match(settled[0].answer, /skipped/u)
})

test('with nobody to ask, a question is recorded open rather than blocking', async () => {
    const worker = scriptedWorker([ok(QUESTION), ok('UNKNOWN: nope'), ok('NONE')])
    const settled = await grill(REFINED, 'RESEARCH', {runWorker: worker.run})
    assert.equal(settled[0].from, 'open')
})

test('grill stops asking rather than asking forever', async () => {
    const worker = scriptedWorker([spec => ok(spec.label === 'grill' ? QUESTION : 'ANSWER: sure')])
    const settled = await grill(REFINED, 'RESEARCH', {runWorker: worker.run})
    assert.equal(settled.length, 6)
})

const SPEC =
    'GOAL\nA pause menu.\n\nCONSTRAINTS\n- keep the input map\n\nSTEPS\n1. add src/ui/pause.tscn\n\n'
    + 'VERIFY\n```sh\nnpm run test:godot\n```\n'

test('a verify block is parsed only when it is actually closed', () => {
    assert.deepEqual(parseVerifyBlock(SPEC), ['npm run test:godot'])
    assert.deepEqual(parseVerifyBlock('VERIFY\n```\nnpm test\n```'), ['npm test'])
    assert.equal(parseVerifyBlock('VERIFY\nnpm run test:godot\n'), null)
    assert.equal(parseVerifyBlock('VERIFY\n```sh\nnpm test\n\nSTEPS\n1. more'), null)
    assert.equal(parseVerifyBlock('VERIFY\n```sh\n# only a comment\n```'), null)
})

test('a spec that declares no commands is verifiable, and the sentinel is not a command', () => {
    const none = 'GOAL\nA thing.\n\nVERIFY\n```sh\n(none)\n```\n'
    assert.equal(declaresNoCommands(none), true)
    assert.equal(parseVerifyBlock(none), null)
    assert.equal(declaresNoCommands(SPEC), false)
    assert.equal(declaresNoCommands('GOAL\nA thing.\n\nVERIFY\nnone\n'), false)
    const both = 'VERIFY\n```sh\n(none)\nmake test\n```'
    assert.equal(declaresNoCommands(both), false)
    assert.deepEqual(parseVerifyBlock(both), ['make test'])
})

test('a verify point takes its name from the comment above it', () => {
    const named =
        'GOAL\nA boss.\n\nVERIFY\n```sh\n'
        + '# the boss registers every part it builds\n'
        + 'godot --headless --script .gofer/checks/centipede.gd\n'
        + '# the project still starts\n'
        + 'godot --headless --quit-after 600\n'
        + '```\n'

    assert.deepEqual(parseVerifyPoints(named), [
        {
            name: 'the boss registers every part it builds',
            command: 'godot --headless --script .gofer/checks/centipede.gd'
        },
        {name: 'the project still starts', command: 'godot --headless --quit-after 600'}
    ])
    assert.deepEqual(parseVerifyBlock(named), [
        'godot --headless --script .gofer/checks/centipede.gd',
        'godot --headless --quit-after 600'
    ])
})

test('a point with no comment names itself, and a gap ends a name', () => {
    assert.deepEqual(parseVerifyPoints('VERIFY\n```sh\n# both\nmake a\nmake b\n```'), [
        {name: 'both', command: 'make a'},
        {name: 'make b', command: 'make b'}
    ])
    assert.deepEqual(parseVerifyPoints('VERIFY\n```sh\n# stale\n\nmake test\n```'), [
        {name: 'make test', command: 'make test'}
    ])
    assert.deepEqual(parseVerifyPoints('VERIFY\n```sh\n###   hashes trimmed\nmake test\n```'), [
        {name: 'hashes trimmed', command: 'make test'}
    ])
})

test('a block that declares no commands declares no points', () => {
    assert.equal(parseVerifyPoints('GOAL\nA thing.\n\nVERIFY\n```sh\n(none)\n```\n'), null)
    assert.equal(parseVerifyPoints('VERIFY\n```sh\n# nothing to run\n(none)\n```'), null)
    assert.equal(parseVerifyPoints('VERIFY\n```sh\n# only a comment\n```'), null)
    assert.equal(parseVerifyPoints('VERIFY\n```sh\nmake test\n\nSTEPS\n1. more'), null)
    assert.equal(parseVerifyPoints('GOAL\nA thing.\n'), null)
})

test('compose accepts a spec whose project has no command to run', async () => {
    const none = 'GOAL\nA thing.\n\nVERIFY\n```sh\n(none)\n```'
    const worker = scriptedWorker([ok(none)])
    assert.equal(await compose(REFINED, 'RESEARCH', [], {runWorker: worker.run}), none)
    assert.equal(worker.calls.length, 1)
})

test('narration before the spec is dropped, and a spec with none is untouched', () => {
    assert.equal(stripPreamble(`Here is the spec you asked for.\n\n${SPEC}`), SPEC.trim())
    assert.equal(stripPreamble(SPEC), SPEC.trim())
})

test('compose asks again for a spec it cannot verify, then gives up typed', async () => {
    const noVerify =
        'GOAL\nA thing.\n\nCONSTRAINTS\n- one\n\nSTEPS\n1. do it\n\nVERIFY\nrun the tests\n'
    const recovering = scriptedWorker([ok(noVerify), ok(SPEC)])
    assert.equal(await compose(REFINED, 'RESEARCH', [], {runWorker: recovering.run}), SPEC.trim())
    assert.match(recovering.calls[1].prompt, /^STOP\. Your previous draft had no VERIFY block\./u)

    const hopeless = scriptedWorker([ok(noVerify)])
    await assert.rejects(compose(REFINED, 'RESEARCH', [], {runWorker: hopeless.run}), error => {
        assert.ok(error instanceof PhaseFailed)
        assert.equal(error.phase, 'compose')
        return true
    })
    assert.equal(hopeless.calls.length, 2)
})

test('a first draft that verifies costs exactly one call', async () => {
    const worker = scriptedWorker([ok(SPEC)])
    await compose(REFINED, 'RESEARCH', [], {runWorker: worker.run})
    assert.equal(worker.calls.length, 1)
    assert.deepEqual(worker.calls[0].toolNames, [])
})

test('every settled decision reaches compose', async () => {
    const worker = scriptedWorker([ok(SPEC)])
    await compose(REFINED, 'RESEARCH', [{question: 'Where?', answer: 'its own scene'}], {
        runWorker: worker.run
    })
    assert.match(worker.calls[0].prompt, /DECISIONS/u)
    assert.match(worker.calls[0].prompt, /its own scene/u)

    const bare = scriptedWorker([ok(SPEC)])
    await compose(REFINED, 'RESEARCH', [], {runWorker: bare.run})
    assert.doesNotMatch(bare.calls[0].prompt, /DECISIONS/u)
})

test('the answers block names every question and its answer', () => {
    assert.equal(
        formatAnswers([
            {question: 'Where?', answer: 'here'},
            {question: 'When?', answer: 'now'}
        ]),
        '- Where?\n  here\n- When?\n  now'
    )
})

test('the worker list and the assembly order are the same list', () => {
    assert.deepEqual(
        RESEARCH_WORKERS.map(worker => worker.section),
        ['FILES', 'APIS', 'CONTEXT', 'TOOLING']
    )
})
