import assert from 'node:assert/strict'
import test from 'node:test'
import {
    PhaseFailed,
    PhaseStopped,
    RESEARCH_WORKERS,
    compose,
    critique,
    declaresNoCommands,
    formatAnswers,
    grill,
    parseAutoAnswer,
    parseQuestion,
    parseVerifyBlock,
    parseVerifyPoints,
    refine,
    research,
    stripPreamble,
    verifyTooling
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
        ok('TOOLING\n  npm test  runs'),
        ok('VERIFIED\n  npm test  the suite runs')
    ])
    const text = await research(REFINED, {runWorker: worker.run})

    assert.deepEqual(
        worker.calls.map(call => call.label),
        ['worker:files', 'worker:apis', 'worker:context', 'worker:tooling', 'verify-tooling']
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
        ok('TOOLING\n  z'),
        ok('VERIFIED\n  z  it runs')
    ])
    const text = await research(REFINED, {runWorker: worker.run})

    assert.equal(worker.calls.length, 6)
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
    assert.deepEqual(tools['worker:apis'], [
        'read',
        'bash',
        'godot_docs_search',
        'godot_script',
        'web_search'
    ])
    assert.deepEqual(tools['worker:files'], ['read', 'bash'])
    assert.deepEqual(tools['worker:context'], ['read', 'bash'])
    assert.deepEqual(tools['worker:tooling'], ['read', 'bash'])

    const offline = scriptedWorker([ok('a'), ok('b'), ok('c'), ok('d')])
    await research(REFINED, {runWorker: offline.run, canSearch: false})
    assert.deepEqual(offline.calls[1].toolNames, [
        'read',
        'bash',
        'godot_docs_search',
        'godot_script'
    ])
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

const said = answer => () => ({answer, stopAsking: false})

test('every question reaches the user, because settling them alone is off by default', async () => {
    const worker = scriptedWorker([ok(QUESTION), ok('NONE')])
    const asked = []
    const settled = await grill(REFINED, 'RESEARCH', {
        runWorker: worker.run,
        askUser: question => {
            asked.push(question.question)
            return {answer: 'inside the HUD', stopAsking: false}
        }
    })

    assert.deepEqual(asked, ['Where does the menu live?'])
    assert.equal(settled[0].from, 'user')
    assert.equal(settled[0].answer, 'inside the HUD')
    assert.ok(
        worker.calls.every(call => call.label === 'grill'),
        'nothing asked the model to answer for the user'
    )
})

test('turned on, it answers from research where it can and asks where it cannot', async () => {
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
        answersItsOwnQuestions: true,
        askUser: question => {
            asked.push(question.question)
            return {answer: 'inside the HUD', stopAsking: false}
        }
    })

    assert.equal(settled.length, 2)
    assert.equal(settled[0].from, 'research')
    assert.equal(settled[0].answer, 'its own scene, matching src/ui/')
    assert.equal(settled[1].from, 'user')
    assert.equal(settled[1].answer, 'inside the HUD')
    assert.deepEqual(asked, ['When does the menu live?'])
})

test('the whole Q&A travels into the next question, answers included', async () => {
    const worker = scriptedWorker([ok(QUESTION), ok('NONE')])
    await grill(REFINED, 'RESEARCH', {runWorker: worker.run, askUser: said('inside the HUD')})
    assert.doesNotMatch(worker.calls[0].prompt, /DECISIONS SO FAR/u)
    assert.match(worker.calls[1].prompt, /DECISIONS SO FAR/u)
    assert.match(worker.calls[1].prompt, /Where does the menu live\?/u)
    // The answer is the half that was missing: without it a later question cannot react.
    assert.match(worker.calls[1].prompt, /inside the HUD/u)
})

test('a skip is recorded as a decision, not as a missing answer', async () => {
    const worker = scriptedWorker([ok(QUESTION), ok('NONE')])
    const settled = await grill(REFINED, 'RESEARCH', {
        runWorker: worker.run,
        askUser: said(null)
    })
    assert.equal(settled[0].from, 'skipped')
    assert.match(settled[0].answer, /skipped/u)
})

test('a skip is not a stop: the next question is still asked', async () => {
    const worker = scriptedWorker([
        ok(QUESTION),
        ok(QUESTION.replace('Where does', 'When does')),
        ok('NONE')
    ])
    const settled = await grill(REFINED, 'RESEARCH', {
        runWorker: worker.run,
        askUser: said(null)
    })
    assert.equal(settled.length, 2)
})

test('with nobody to ask, one question is recorded open and the loop ends', async () => {
    const worker = scriptedWorker([ok(QUESTION)])
    const settled = await grill(REFINED, 'RESEARCH', {runWorker: worker.run})
    assert.equal(settled.length, 1)
    assert.equal(settled[0].from, 'open')
})

test('a question already asked ends the grilling, whoever is answering', async () => {
    const worker = scriptedWorker([
        spec => ok(spec.label === 'grill' ? QUESTION : 'ANSWER: its own scene')
    ])
    const settled = await grill(REFINED, 'RESEARCH', {
        runWorker: worker.run,
        answersItsOwnQuestions: true
    })
    assert.equal(settled.length, 1, 'nothing but this check stands between it and forever')
})

test('grill stops when the user says stop asking', async () => {
    const worker = scriptedWorker([spec => ok(spec.label === 'grill' ? QUESTION : 'NONE')])
    const settled = await grill(REFINED, 'RESEARCH', {
        runWorker: worker.run,
        askUser: () => ({answer: null, stopAsking: true})
    })
    assert.equal(settled.length, 1, 'the question on screen is recorded, and nothing follows it')
    assert.equal(settled[0].from, 'skipped')
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

test('a verification line naming a godot tool is parsed as a call, not as a command', () => {
    const spec =
        'VERIFY\n```sh\n'
        + '# the bullet reaches the tree\n'
        + 'godot_runtime {"ops": [{"op": "run"}], "contains": "Bullet"}\n'
        + '# no assertion, so the call answering is all it proves\n'
        + 'godot_runtime {"ops": [{"op": "get_state"}]}\n'
        + '```\n'

    assert.deepEqual(parseVerifyPoints(spec), [
        {
            name: 'the bullet reaches the tree',
            command: 'godot_runtime {"ops": [{"op": "run"}], "contains": "Bullet"}',
            tool: 'godot_runtime',
            params: {ops: [{op: 'run'}]},
            contains: 'Bullet'
        },
        {
            name: 'no assertion, so the call answering is all it proves',
            command: 'godot_runtime {"ops": [{"op": "get_state"}]}',
            tool: 'godot_runtime',
            params: {ops: [{op: 'get_state'}]}
        }
    ])
})

test('a line that only looks like a tool call stays a shell command', () => {
    const notJson = 'VERIFY\n```sh\n# still the shell\ngodot_runtime run --scene main\n```'
    assert.deepEqual(parseVerifyPoints(notJson), [
        {name: 'still the shell', command: 'godot_runtime run --scene main'}
    ])

    const broken = 'VERIFY\n```sh\n# broken json\ngodot_runtime {"ops": [\n```'
    assert.deepEqual(parseVerifyPoints(broken), [
        {name: 'broken json', command: 'godot_runtime {"ops": ['}
    ])
})

const TOOLING_RESEARCH = [
    'CONTEXT',
    '- a project',
    '',
    'TOOLING',
    '  npm test  runs',
    '  make ship  ships'
].join('\n')

test('only the commands that ran reach the spec', async () => {
    const worker = scriptedWorker([
        ok('VERIFIED\n  npm test  0 failures\n\nREJECTED\n  make ship  no such target')
    ])
    const logged = []
    const out = await verifyTooling(TOOLING_RESEARCH, {
        runWorker: worker.run,
        log: line => logged.push(line)
    })

    assert.equal(worker.calls[0].label, 'verify-tooling')
    assert.deepEqual(worker.calls[0].toolNames, ['read', 'bash'])
    assert.match(out, /npm test {2}0 failures/u)
    assert.doesNotMatch(out, /make ship/u)
    assert.match(logged.join('\n'), /tooling rejected: make ship/u)
})

test('a verifier that cannot answer degrades to the unverified list rather than ending the phase', async () => {
    const worker = scriptedWorker([failed('model-error', 'the endpoint refused')])
    const out = await verifyTooling(TOOLING_RESEARCH, {runWorker: worker.run})
    assert.equal(out, TOOLING_RESEARCH)
})

test('a stop during verification is never degraded past', async () => {
    const worker = scriptedWorker([stopped])
    await assert.rejects(verifyTooling(TOOLING_RESEARCH, {runWorker: worker.run}), PhaseStopped)
})

test('nothing to run costs no worker at all', async () => {
    const worker = scriptedWorker([ok('never asked')])
    assert.equal(
        await verifyTooling('CONTEXT\n- a project', {runWorker: worker.run}),
        'CONTEXT\n- a project'
    )
    assert.equal(worker.calls.length, 0)
})

test('a research bullet that refutes a constraint deletes it before compose reads it', async () => {
    const worker = scriptedWorker([ok(SPEC)])
    const logged = []
    await compose(
        'GOAL\nPlace a unit.\n\nCONSTRAINTS\n- refuse the cell when `is_open` is true\n- keep the input map\n',
        'CONTEXT\n- no `is_open` check is needed; every cell accepts a unit\n',
        [],
        {runWorker: worker.run, log: line => logged.push(line)}
    )
    assert.doesNotMatch(worker.calls[0].prompt, /refuse the cell/u)
    assert.match(worker.calls[0].prompt, /keep the input map/u)
    assert.match(logged.join('\n'), /dropped constraint/u)
})

const CRITIQUED = SPEC.replace('npm run test:godot', 'godot_runtime {"ops": [{"op": "input"}]}')

test('the critique replaces the composed spec when it comes back as one', async () => {
    const worker = scriptedWorker([ok(CRITIQUED)])
    assert.equal(
        await critique(REFINED, 'RESEARCH', [], SPEC, {runWorker: worker.run}),
        CRITIQUED.trim()
    )
    assert.equal(worker.calls[0].label, 'critique')
    assert.deepEqual(worker.calls[0].toolNames, [])
    assert.match(worker.calls[0].prompt, /SPECIFICATION/u)
})

test('a critique that is not a specification cannot cost the plan the one it had', async () => {
    for (const answer of [
        ok('Looks fine to me.'),
        failed('model-error', 'refused'),
        failed('no-answer')
    ]) {
        const worker = scriptedWorker([answer])
        assert.equal(await critique(REFINED, 'RESEARCH', [], SPEC, {runWorker: worker.run}), SPEC)
    }
})

test('a stop during the critique is never swallowed by the fallback', async () => {
    const worker = scriptedWorker([stopped])
    await assert.rejects(
        critique(REFINED, 'RESEARCH', [], SPEC, {runWorker: worker.run}),
        PhaseStopped
    )
})
