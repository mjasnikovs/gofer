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

const WORKER_ENTRY = process.env.GOFER_WORKER_ENTRY ?? 'scripts/ai-worker.mjs'

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

    assert.equal(await finished, 1)
    assert.match(errors, /godot_docs_search: docs_unavailable: the models are missing/u)
    assert.equal(mock.bodies.length, 0)
    assert.deepEqual(
        events.filter(event => event.type === 'done'),
        []
    )
})

const LINGERING_CONNECTION = pathToFileURL(
    join(process.cwd(), 'fixtures/ai-worker/lingering-provider-connection.mjs')
).href

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

function exitedWithin(exited, ms) {
    return Promise.race([
        exited,
        new Promise(resolve => {
            setTimeout(() => resolve('still running'), ms).unref()
        })
    ])
}

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
