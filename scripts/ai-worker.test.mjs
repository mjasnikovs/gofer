/**
 * The worker process: the duplex NDJSON channel it speaks, and what it does when that channel says
 * something other than an answer.
 *
 * These are the tests that actually spawn `scripts/ai-worker.mjs`, which is why they are the ones
 * left in the file named after it. `npm run test:worker:bundled` points `GOFER_WORKER_ENTRY` at the
 * file `scripts/build-workers.mjs` produced and runs this file alone — a bundle can lose a module
 * the source resolved fine, and it is the process, not the turn logic, that a bundle changes.
 */

import assert from 'node:assert/strict'
import {join} from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import test from 'node:test'
import {pathToFileURL} from 'node:url'
import {CANCEL_TYPE, EVENT_PREFIX, TOOL_PREFIX} from './ai-host.mjs'
import {
    baseUrl,
    catalog,
    isProbe,
    probeResult,
    servedBy,
    settings,
    startScriptedServer,
    startToolCallingServer,
    temporaryWorkspace,
    withoutProbes
} from './ai-turn-harness.mjs'

/**
 * The worker these tests spawn.
 *
 * `npm run test:worker` runs the source. `npm run test:worker:bundled` points this at the file
 * `scripts/build-workers.mjs` produced, which is what a built Gofer actually runs — the two used
 * to be the same file only because the build copied nothing.
 */
const WORKER_ENTRY = process.env.GOFER_WORKER_ENTRY ?? 'scripts/ai-worker.mjs'

/**
 * Why the two preload tests only run against the source worker.
 *
 * `--import` patches the real `@earendil-works/pi-ai/compat` session registry from outside the
 * worker. A bundle carries its own inlined copy of that registry, so the fixture would register a
 * cleanup with one registry while the worker released the other, and the worker would hang holding
 * an interval nothing can clear. It is the technique that does not survive bundling, not the
 * behaviour: nothing preloads a worker in a shipped Gofer.
 */
const PRELOAD_SKIP =
    WORKER_ENTRY === 'scripts/ai-worker.mjs' ? undefined : (
        'the preload patches a module graph a bundled worker does not share'
    )

test('worker stdin framing reports malformed JSON and exits nonzero', () => {
    const result = spawnSync(process.execPath, [WORKER_ENTRY], {
        cwd: process.cwd(),
        input: '{invalid',
        encoding: 'utf8'
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /JSON/u)
    assert.equal(result.stdout, '')
})

test('the worker asks the backend for domain tools over the duplex channel', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = startToolCallingServer('godot_scene', {op: 'get_tree', params: {}})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const port = server.address().port

    const worker = spawn(process.execPath, [WORKER_ENTRY], {cwd: process.cwd()})
    context.after(() => worker.kill())
    const requests = []
    const events = []
    const finished = new Promise(resolve => worker.on('exit', resolve))
    createInterface({input: worker.stdout}).on('line', line => {
        if (line.startsWith(TOOL_PREFIX)) {
            const call = JSON.parse(line.slice(TOOL_PREFIX.length))
            requests.push(call)
            // The backend's half of the channel: dispatch, then answer on the same stream.
            worker.stdin.write(
                `${JSON.stringify({
                    type: 'tool-result',
                    id: call.id,
                    ok: true,
                    result: {root: 'Main', revision: 4}
                })}\n`
            )
            return
        }
        if (line.startsWith('GOFER_AI_EVENT:'))
            events.push(JSON.parse(line.slice('GOFER_AI_EVENT:'.length)))
    })

    worker.stdin.write(
        `${JSON.stringify({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`),
            messages: [{sender: 'user', text: 'Inspect the scene', timestamp: 1}],
            workspacePath: workspace.path,
            tools: catalog
        })}\n`
    )

    const code = await finished
    assert.equal(code, 0)
    // Every declared domain was probed before the model was told about any of them, and the probes
    // came first: the turn is only offered tools the backend has answered for.
    //
    // `ask_user` is probed with them and is not one of them. It is answered by the backend over this
    // same channel, so it is proved the same way — but it is routed by name ahead of the catalogue
    // rather than being a domain in it, because a question has no addon handler and no `ops` list.
    // It comes first because its probe is run in this process: the tool asks the backend whether it
    // routes the name AND builds the child that draws a layout, and neither half can be proved from
    // the other side of the channel.
    assert.deepEqual(
        requests.filter(isProbe).map(request => request.tool),
        ['ask_user', ...catalog.map(domain => domain.name)]
    )
    assert.deepEqual(
        withoutProbes(requests).map(request => ({tool: request.tool, params: request.params})),
        [{tool: 'godot_scene', params: {ops: [{op: 'get_tree'}]}}]
    )
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(events.find(event => event.type === 'tool-start').name, 'godot_scene')
    assert.equal(events.find(event => event.type === 'tool-start').target, 'get_tree')
    assert.equal(end.isError, false)
    assert.equal(JSON.parse(end.output).root, 'Main')
    assert.equal(events.find(event => event.type === 'done').text, 'Scene inspected')
})

/**
 * Stopping a turn used to be one thing: `child.kill()`.
 *
 * So the worker's whole abort path — the listener that calls `agent.abort()`, the `aborted`
 * completion it builds, the interruptible retry wait, the sub-agent's `SubagentStopped` — was
 * threaded through fifteen functions and reached by no running Gofer: `scripts/ai-worker.mjs` built
 * no `AbortController` and passed `undefined` where all four read a signal. `grep -c signal
 * scripts/ai-worker.mjs` answered 0.
 *
 * The stop is written while the worker is provably in flight — blocked on a tool call it asked for
 * — and the answer to that call is written straight after it, so a worker that ignores the line
 * still finishes. That is what makes this test about which ending the turn reached rather than
 * about whether it reached one: without the line being honoured the model is asked again, answers,
 * and the turn ends `stop` with the second answer as its text.
 */
test('a cancel line on the channel stops the turn the worker is running', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = startToolCallingServer('godot_scene', {op: 'get_tree', params: {}})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const port = server.address().port

    const worker = spawn(process.execPath, [WORKER_ENTRY], {cwd: process.cwd()})
    context.after(() => worker.kill())
    const events = []
    const finished = new Promise(resolve => worker.on('exit', resolve))
    createInterface({input: worker.stdout}).on('line', line => {
        if (line.startsWith(TOOL_PREFIX)) {
            const call = JSON.parse(line.slice(TOOL_PREFIX.length))
            if (isProbe(call)) {
                worker.stdin.write(`${JSON.stringify(probeResult(call))}\n`)
                return
            }
            worker.stdin.write(`${JSON.stringify({type: CANCEL_TYPE})}\n`)
            worker.stdin.write(
                `${JSON.stringify({
                    type: 'tool-result',
                    id: call.id,
                    ok: true,
                    result: {root: 'Main', revision: 4}
                })}\n`
            )
            return
        }
        if (line.startsWith(EVENT_PREFIX)) events.push(JSON.parse(line.slice(EVENT_PREFIX.length)))
    })

    worker.stdin.write(
        `${JSON.stringify({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`),
            messages: [{sender: 'user', text: 'Inspect the scene', timestamp: 1}],
            workspacePath: workspace.path,
            tools: catalog
        })}\n`
    )

    await finished
    const done = events.find(event => event.type === 'done')
    assert.equal(done?.stopReason, 'aborted')
    // The half-finished turn is still on the transcript. That is what a bare kill loses: no step
    // ends, so nothing checkpoints, and the model's memory of the stopped turn stops at the last
    // step that had already finished.
    assert.ok(
        events.some(event => event.type === 'turn-state'),
        'a stopped turn checkpoints what the model had done'
    )
})

test('a tool call left unanswered is settled when the backend closes the channel', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'godot_scene', args: {op: 'get_tree', params: {}}}]},
        {text: 'The scene could not be read'}
    ])
    const url = await baseUrl(context, mock.server)
    const worker = spawn(process.execPath, [WORKER_ENTRY], {cwd: process.cwd()})
    context.after(() => worker.kill())
    const events = []
    const finished = new Promise(resolve => worker.on('exit', resolve))
    createInterface({input: worker.stdout}).on('line', line => {
        // The backend goes away mid-call: the channel closes instead of the request being answered.
        // It answers the startup probes first, because a turn that never started cannot have a call
        // left unanswered.
        if (line.startsWith(TOOL_PREFIX)) {
            const call = JSON.parse(line.slice(TOOL_PREFIX.length))
            if (!isProbe(call)) return worker.stdin.end()
            worker.stdin.write(`${JSON.stringify(probeResult(call))}\n`)
            return
        }
        if (line.startsWith(EVENT_PREFIX)) events.push(JSON.parse(line.slice(EVENT_PREFIX.length)))
    })

    worker.stdin.write(
        `${JSON.stringify({
            settings: servedBy(url),
            messages: [{sender: 'user', text: 'Inspect the scene', timestamp: 1}],
            workspacePath: workspace.path,
            tools: catalog
        })}\n`
    )

    // The worker exits rather than hanging on a promise the backend can no longer resolve, and the
    // model is told why instead of being left waiting for a result.
    assert.equal(await finished, 0)
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, true)
    assert.match(end.output, /closed the tool channel/u)
    assert.equal(events.find(event => event.type === 'done').text, 'The scene could not be read')
})

test('a dead tool fails worker startup loudly rather than quietly', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'this turn must never reach the model'}])
    const url = await baseUrl(context, mock.server)

    const worker = spawn(process.execPath, [WORKER_ENTRY], {cwd: process.cwd()})
    context.after(() => worker.kill())
    let errors = ''
    worker.stderr.on('data', chunk => {
        errors += String(chunk)
    })
    const events = []
    const finished = new Promise(resolve => worker.on('exit', resolve))
    createInterface({input: worker.stdout}).on('line', line => {
        if (line.startsWith(TOOL_PREFIX)) {
            const call = JSON.parse(line.slice(TOOL_PREFIX.length))
            worker.stdin.write(
                `${JSON.stringify(
                    call.tool === 'godot_docs_search' ?
                        {
                            type: 'tool-result',
                            id: call.id,
                            ok: false,
                            error: {code: 'docs_unavailable', message: 'the models are missing'}
                        }
                    :   probeResult(call)
                )}\n`
            )
            return
        }
        if (line.startsWith(EVENT_PREFIX)) events.push(JSON.parse(line.slice(EVENT_PREFIX.length)))
    })

    worker.stdin.write(
        `${JSON.stringify({
            settings: servedBy(url),
            messages: [{sender: 'user', text: 'How does Tween work?', timestamp: 1}],
            workspacePath: workspace.path,
            tools: catalog
        })}\n`
    )

    // Nonzero, with the reason on stderr: this is what the backend turns into a failed turn the
    // user can read, rather than a turn that runs with a tool nobody can call.
    assert.equal(await finished, 1)
    assert.match(errors, /godot_docs_search: docs_unavailable: the models are missing/u)
    assert.equal(mock.bodies.length, 0)
    assert.deepEqual(
        events.filter(event => event.type === 'done'),
        []
    )
})

/**
 * A worker held open by the connection it is finished with.
 *
 * Preloaded rather than built here, because holding the process open is only meaningful from
 * outside the turn: it registers with pi-ai's session-resource registry, which is where the
 * ChatGPT path parks its cached Codex WebSocket for five minutes after the answer.
 */
const LINGERING_CONNECTION = pathToFileURL(
    join(process.cwd(), 'fixtures/ai-worker/lingering-provider-connection.mjs')
).href

/** One worker process, with its events collected and its startup probes answered. */
function startWorker(context, {preload} = {}) {
    const worker = spawn(process.execPath, [WORKER_ENTRY], {
        cwd: process.cwd(),
        env: preload ? {...process.env, NODE_OPTIONS: `--import ${preload}`} : process.env
    })
    context.after(() => worker.kill())
    const events = []
    let errors = ''
    worker.stderr.on('data', chunk => {
        errors += String(chunk)
    })
    createInterface({input: worker.stdout}).on('line', line => {
        if (line.startsWith(TOOL_PREFIX)) {
            const call = JSON.parse(line.slice(TOOL_PREFIX.length))
            worker.stdin.write(`${JSON.stringify(probeResult(call))}\n`)
            return
        }
        if (line.startsWith(EVENT_PREFIX)) events.push(JSON.parse(line.slice(EVENT_PREFIX.length)))
    })
    return {
        worker,
        events,
        stderr: () => errors,
        start: request => worker.stdin.write(`${JSON.stringify(request)}\n`),
        exited: new Promise(resolve => worker.on('exit', resolve))
    }
}

/**
 * The exit code, or the fact that the worker was still running when the deadline passed.
 *
 * A deadline rather than a plain await, because the failure this asserts against is a worker that
 * never exits: awaiting it would hang the suite instead of failing it.
 */
function exitedWithin(exited, ms) {
    return Promise.race([
        exited,
        new Promise(resolve => {
            setTimeout(() => resolve('still running'), ms).unref()
        })
    ])
}

/*
 * The turn ends when the worker exits, so what the provider kept open is the turn's problem.
 *
 * The backend reads the worker's stdout to EOF and the renderer's composer stays busy until that
 * command returns. A remote turn leaves a cached connection behind — the Codex WebSocket, parked
 * per session for five minutes — and an open socket keeps Node alive. The answer is on screen, the
 * model is finished, nothing is running, and Gofer still says it is working until the user presses
 * Stop. The local path has no such cache, which is why only the remote one shows it.
 */
test(
    'the worker exits when the turn ends, releasing what the provider kept open',
    {skip: PRELOAD_SKIP},
    async context => {
        const workspace = await temporaryWorkspace()
        context.after(workspace.remove)
        const mock = startScriptedServer([{text: 'Done'}])
        const url = await baseUrl(context, mock.server)
        const session = startWorker(context, {preload: LINGERING_CONNECTION})

        session.start({
            settings: servedBy(url),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            // The session id is what makes the connection worth caching, so it is what the bug needs.
            sessionId: 'task-9f2c',
            workspacePath: workspace.path
        })

        assert.equal(await exitedWithin(session.exited, 10_000), 0, session.stderr())
        assert.ok(
            session.events.some(event => event.type === 'done'),
            'the turn answered before the worker exited'
        )
    }
)

/*
 * And the same when the turn ends badly. Releasing on the way out is a `finally`, not a step of the
 * happy path: a failed turn leaves the same connection behind, and it is the turn the user is most
 * likely to want to retry immediately.
 */
test(
    'a failed turn releases the connection too, rather than only a finished one',
    {skip: PRELOAD_SKIP},
    async context => {
        const workspace = await temporaryWorkspace()
        context.after(workspace.remove)
        const mock = startScriptedServer([
            {error: {status: 400, message: 'The request was rejected'}}
        ])
        const url = await baseUrl(context, mock.server)
        const session = startWorker(context, {preload: LINGERING_CONNECTION})

        session.start({
            settings: servedBy(url, {retryAttempts: 0}),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            sessionId: 'task-9f2c',
            workspacePath: workspace.path
        })

        assert.equal(await exitedWithin(session.exited, 10_000), 1, session.stderr())
        assert.match(session.stderr(), /The request was rejected/u)
    }
)
