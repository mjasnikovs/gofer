import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import test from 'node:test'
import {
    EVENT_PREFIX,
    TOOL_PREFIX,
    createGodotTools,
    createToolHost,
    toolResult
} from './ai-host.mjs'
import {createAgentTools, runAgent} from './ai-provider.mjs'

const settings = {
    name: 'Local AI',
    baseUrl: '',
    model: 'Qwen3.6-27B-UD-Q4_K_XL.gguf'
}

async function temporaryWorkspace(files = {}, outsideFiles = {}) {
    const root = await mkdtemp(join(tmpdir(), 'gofer-worker-'))
    const path = join(root, 'workspace')
    await mkdir(path)
    for (const [name, contents] of Object.entries(files))
        await writeFile(join(path, name), contents)
    for (const [name, contents] of Object.entries(outsideFiles))
        await writeFile(join(root, name), contents)
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

function startServer() {
    let body = ''
    let authorization = ''
    const server = createServer((request, response) => {
        authorization = request.headers.authorization ?? ''
        request.on('data', chunk => {
            body += chunk
        })
        request.on('end', () => {
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [
                        {
                            index: 0,
                            delta: {role: 'assistant', content: 'Hello'},
                            finish_reason: null
                        }
                    ]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta: {content: ' Gofer'}, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
                    usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    return {
        server,
        request: () => ({body: JSON.parse(body), authorization})
    }
}

test('streams a Pi AI completion through the configured local provider', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const events = []

    try {
        const completion = await runAgent({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            apiKey: 'secret',
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: event => events.push(event)
        })
        const request = mock.request()

        assert.equal(completion.text, 'Hello Gofer')
        assert.equal(completion.stopReason, 'stop')
        assert.equal(completion.usage.totalTokens, 6)
        assert.deepEqual(
            events.filter(event => event.type === 'text-delta').map(event => event.delta),
            ['Hello', ' Gofer']
        )
        assert.equal(request.authorization, 'Bearer secret')
        assert.equal(request.body.model, settings.model)
        assert.equal(request.body.messages.at(-1).role, 'user')
        assert.deepEqual(
            request.body.tools.map(tool => tool.function.name),
            ['read', 'write', 'edit', 'bash']
        )
    } finally {
        mock.server.close()
    }
})

test('sends image-only prompts as OpenAI image content', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()

    try {
        await runAgent({
            settings: {
                ...settings,
                baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
                input: ['text', 'image']
            },
            messages: [
                {
                    sender: 'user',
                    text: '',
                    timestamp: 1,
                    images: [{data: 'aGk=', mimeType: 'image/png'}]
                }
            ],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.deepEqual(mock.request().body.messages.at(-1), {
            role: 'user',
            content: [{type: 'image_url', image_url: {url: 'data:image/png;base64,aGk='}}]
        })
    } finally {
        mock.server.close()
    }
})

test('sends mixed text and image prompts without dropping either part', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    context.after(() => mock.server.close())
    const address = mock.server.address()

    await runAgent({
        settings: {
            ...settings,
            baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
            input: ['text', 'image']
        },
        messages: [
            {
                sender: 'user',
                text: 'Describe this image',
                timestamp: 1,
                images: [{data: 'aGk=', mimeType: 'image/png'}]
            }
        ],
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.deepEqual(mock.request().body.messages.at(-1), {
        role: 'user',
        content: [
            {type: 'text', text: 'Describe this image'},
            {type: 'image_url', image_url: {url: 'data:image/png;base64,aGk='}}
        ]
    })
})

test('restores renderer history when native agent history is unavailable', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    context.after(() => mock.server.close())
    const address = mock.server.address()

    await runAgent({
        settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
        messages: [
            {sender: 'user', text: 'Earlier question', timestamp: 1},
            {sender: 'assistant', text: 'Earlier answer', timestamp: 2},
            {sender: 'user', text: 'Continue', timestamp: 3}
        ],
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.deepEqual(
        mock
            .request()
            .body.messages.slice(-3)
            .map(message => message.role),
        ['user', 'assistant', 'user']
    )
})

test('rejects requests without a user prompt or image before network dispatch', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    await assert.rejects(
        runAgent({
            settings,
            messages: [{sender: 'user', text: '', timestamp: 1, images: []}],
            workspacePath: workspace.path,
            emit: () => undefined
        }),
        /prompt or image/u
    )
})

/**
 * A conversation that has outgrown the model's context window does not fail: the server answers a
 * token or two and says it stopped for length. Recorded as an answer, that is a complete assistant
 * message reading "I", and the work carries on against a conversation that can never reply again.
 */
test('reports a turn that ran out of context rather than recording it as an answer', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = createServer((request, response) => {
        request.resume()
        request.on('end', () => {
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-full',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta: {role: 'assistant', content: 'I'}}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-full',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta: {}, finish_reason: 'length'}],
                    usage: {prompt_tokens: 116_449, completion_tokens: 1, total_tokens: 116_450}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const address = server.address()

    await assert.rejects(
        runAgent({
            settings: {
                ...settings,
                baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
                contextWindow: 120_064,
                maxRetries: 0
            },
            messages: [{sender: 'user', text: 'Carry on', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        }),
        // The two numbers that explain it, and the way out.
        /116,449 of the model's 120,064-token context window.*Start a new task/su
    )
})

test('rejects malformed and interrupted provider streams', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/event-stream'})
        response.end('data: {not-json}\n\n')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const address = server.address()

    await assert.rejects(
        runAgent({
            settings: {
                ...settings,
                baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
                maxRetries: 0
            },
            messages: [{sender: 'user', text: 'Respond', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })
    )
})

test('cancels an active provider stream through AbortSignal', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    let notifyRequest
    const requestStarted = new Promise(resolve => {
        notifyRequest = resolve
    })
    const server = createServer(() => notifyRequest())
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => {
        server.closeAllConnections()
        server.close()
    })
    const address = server.address()
    const controller = new AbortController()
    const completion = runAgent({
        settings: {
            ...settings,
            baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
            maxRetries: 0,
            timeoutMs: 60_000
        },
        messages: [{sender: 'user', text: 'Wait', timestamp: 1}],
        workspacePath: workspace.path,
        emit: () => undefined,
        signal: controller.signal
    })
    await requestStarted
    controller.abort()

    const result = await completion
    assert.equal(result.stopReason, 'aborted')
})

test('worker stdin framing reports malformed JSON and exits nonzero', () => {
    const result = spawnSync(process.execPath, ['scripts/ai-worker.mjs'], {
        cwd: process.cwd(),
        input: '{invalid',
        encoding: 'utf8'
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /JSON/u)
    assert.equal(result.stdout, '')
})

test('agent tools confine paths to the temporary workspace', async context => {
    const workspace = await temporaryWorkspace({}, {'secret.txt': 'outside secret'})
    context.after(workspace.remove)
    const {env, tools} = createAgentTools(workspace.path)
    context.after(() => env.cleanup())
    const read = tools.find(tool => tool.name === 'read')
    const bash = tools.find(tool => tool.name === 'bash')

    await assert.rejects(
        read.execute(
            'read-outside',
            {path: '../secret.txt'},
            new AbortController().signal,
            () => undefined
        ),
        /outside|workspace|path|ENOENT/iu
    )
    await assert.rejects(
        bash.execute(
            'bash-outside',
            {command: 'cat ../secret.txt'},
            new AbortController().signal,
            () => undefined
        ),
        /workspace/iu
    )
})

test('runs the Pi agent tool loop and streams tool lifecycle events', async context => {
    const workspace = await temporaryWorkspace({'package.json': '{"name":"gofer"}'})
    context.after(workspace.remove)
    let requestCount = 0
    const bodies = []
    const server = createServer((request, response) => {
        let body = ''
        request.on('data', chunk => {
            body += chunk
        })
        request.on('end', () => {
            bodies.push(JSON.parse(body))
            requestCount += 1
            response.writeHead(200, {'content-type': 'text/event-stream'})
            const delta =
                requestCount === 1 ?
                    {
                        role: 'assistant',
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call-read',
                                type: 'function',
                                function: {
                                    name: 'read',
                                    arguments: '{"path":"package.json"}'
                                }
                            }
                        ]
                    }
                :   {role: 'assistant', content: 'Read complete'}
            response.write(
                `data: ${JSON.stringify({
                    id: `chatcmpl-${requestCount}`,
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: `chatcmpl-${requestCount}`,
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [
                        {
                            index: 0,
                            delta: {},
                            finish_reason: requestCount === 1 ? 'tool_calls' : 'stop'
                        }
                    ],
                    usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const events = []

    try {
        const completion = await runAgent({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            messages: [{sender: 'user', text: 'Read package.json', timestamp: 1}],
            workspacePath: workspace.path,
            emit: event => events.push(event)
        })

        assert.equal(completion.text, 'Read complete')
        assert.equal(requestCount, 2)
        assert.equal(events.find(event => event.type === 'tool-start').name, 'read')
        assert.equal(events.find(event => event.type === 'tool-start').target, 'package.json')
        assert.equal(events.find(event => event.type === 'tool-end').isError, false)
        assert.equal(
            JSON.parse(events.find(event => event.type === 'tool-end').output).name,
            'gofer'
        )
        assert.equal(bodies[1].messages.at(-1).role, 'tool')

        await runAgent({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            messages: [
                {sender: 'user', text: 'Read package.json', timestamp: 1},
                {sender: 'assistant', text: completion.text, timestamp: 2},
                {sender: 'user', text: 'Continue', timestamp: 3}
            ],
            agentMessages: completion.agentMessages,
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(requestCount, 3)
        assert.ok(bodies[2].messages.some(message => message.role === 'tool'))
    } finally {
        server.close()
    }
})

const catalog = [
    {
        name: 'godot_scene',
        description: 'The edited scene.',
        operations: [
            {op: 'get_tree', summary: 'Returns the edited scene hierarchy.'},
            {op: 'save', summary: 'Saves the edited scene.'}
        ]
    },
    {
        name: 'godot_runtime',
        description: 'The running game.',
        operations: [{op: 'capture', summary: 'Captures a PNG frame.'}]
    },
    {
        name: 'godot_resource',
        description: 'Project resources.',
        operations: [{op: 'delete', summary: 'Deletes a resource. Asks the user first.'}]
    }
]

test('the tool host correlates results, failures, cancellation, and closure', async () => {
    const sent = []
    const host = createToolHost(call => sent.push(call))

    const answered = host.call('godot_scene', {op: 'get_tree'})
    assert.equal(sent.length, 1)
    assert.equal(sent[0].tool, 'godot_scene')
    host.deliver({type: 'tool-result', id: sent[0].id, ok: true, result: {revision: 3}})
    assert.deepEqual(await answered, {revision: 3})

    const refused = host.call('godot_scene', {op: 'save'})
    host.deliver({
        type: 'tool-result',
        id: sent[1].id,
        ok: false,
        error: {code: 'revision_conflict', message: 'The scene moved on'}
    })
    await assert.rejects(refused, /revision_conflict: The scene moved on/u)

    // A late duplicate result must not settle anything a second time, and an unknown id is
    // ignored rather than thrown: the channel outlives individual calls.
    host.deliver({type: 'tool-result', id: sent[1].id, ok: true, result: {}})
    host.deliver({type: 'tool-result', id: 'call-unknown', ok: true, result: {}})
    host.deliver({type: 'ignored'})

    const controller = new AbortController()
    const cancelled = host.call('godot_scene', {op: 'get_tree'}, controller.signal)
    controller.abort()
    await assert.rejects(cancelled, /cancelled/u)
    assert.equal(host.pendingCount, 0)

    const failing = createToolHost(() => {
        throw new Error('the channel is closed')
    })
    await assert.rejects(failing.call('godot_scene', {op: 'get_tree'}), /channel is closed/u)
    assert.equal(failing.pendingCount, 0)

    const pending = host.call('godot_scene', {op: 'get_tree'})
    host.close('the backend closed the tool channel')
    await assert.rejects(pending, /backend closed/u)
    await assert.rejects(host.call('godot_scene', {op: 'get_tree'}), /backend closed/u)
    await assert.rejects(
        host.call('godot_scene', {op: 'get_tree'}, AbortSignal.abort()),
        /backend closed/u
    )
})

test('domain tools carry the router catalog and forward every call', async () => {
    const calls = []
    const host = {
        call: (tool, params) => {
            calls.push({tool, params})
            return Promise.resolve({nodes: []})
        }
    }
    const tools = createGodotTools(catalog, host)

    assert.deepEqual(
        tools.map(tool => tool.name),
        ['godot_scene', 'godot_runtime', 'godot_resource']
    )
    assert.deepEqual(tools[0].parameters.properties.op.enum, ['get_tree', 'save'])
    assert.match(tools[0].description, /get_tree: Returns the edited scene hierarchy\./u)
    const result = await tools[0].execute('call-1', {op: 'get_tree'})
    assert.deepEqual(calls, [{tool: 'godot_scene', params: {op: 'get_tree', params: {}}}])
    assert.deepEqual(result.details, {nodes: []})
    assert.equal(createGodotTools(undefined, host).length, 0)
})

test('captured frames become image content and large results are bounded', () => {
    const captured = toolResult({
        running: true,
        frame: {encoding: 'png-base64', width: 320, height: 240, data: 'iVBORw0KGgo='}
    })

    assert.deepEqual(captured.content[1], {
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png'
    })
    assert.equal(JSON.parse(captured.content[0].text).frame.data, undefined)
    assert.equal(JSON.parse(captured.content[0].text).frame.width, 320)
    assert.equal(captured.details.frame.data, 'iVBORw0KGgo=')

    const huge = toolResult({nodes: 'x'.repeat(40_000)})
    assert.equal(huge.content.length, 1)
    assert.match(huge.content[0].text, /… \[truncated, \d+ characters\]$/u)
    assert.equal(huge.details.nodes.length, 40_000)
})

/** A model that answers with one tool call, then with text once the tool result comes back. */
function startToolCallingServer(tool, args) {
    let turn = 0
    const server = createServer((request, response) => {
        request.on('data', () => undefined)
        request.on('end', () => {
            turn += 1
            const delta =
                turn === 1 ?
                    {
                        role: 'assistant',
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call-tool',
                                type: 'function',
                                function: {name: tool, arguments: JSON.stringify(args)}
                            }
                        ]
                    }
                :   {role: 'assistant', content: 'Scene inspected'}
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-tool',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [{index: 0, delta, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-tool',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: settings.model,
                    choices: [
                        {index: 0, delta: {}, finish_reason: turn === 1 ? 'tool_calls' : 'stop'}
                    ],
                    usage: {prompt_tokens: 8, completion_tokens: 2, total_tokens: 10}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    return server
}

test('the worker asks the backend for domain tools over the duplex channel', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = startToolCallingServer('godot_scene', {op: 'get_tree', params: {}})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const port = server.address().port

    const worker = spawn(process.execPath, ['scripts/ai-worker.mjs'], {cwd: process.cwd()})
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
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(port)}/v1`},
            messages: [{sender: 'user', text: 'Inspect the scene', timestamp: 1}],
            workspacePath: workspace.path,
            tools: catalog
        })}\n`
    )

    const code = await finished
    assert.equal(code, 0)
    assert.deepEqual(
        requests.map(request => ({tool: request.tool, params: request.params})),
        [{tool: 'godot_scene', params: {op: 'get_tree', params: {}}}]
    )
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(events.find(event => event.type === 'tool-start').name, 'godot_scene')
    assert.equal(events.find(event => event.type === 'tool-start').target, 'get_tree')
    assert.equal(end.isError, false)
    assert.equal(JSON.parse(end.output).root, 'Main')
    assert.equal(events.find(event => event.type === 'done').text, 'Scene inspected')
})

test('a refused tool call reaches the model as an error result', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = startToolCallingServer('godot_scene', {op: 'save', params: {}})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const port = server.address().port
    const events = []
    const host = createToolHost(call =>
        host.deliver({
            type: 'tool-result',
            id: call.id,
            ok: false,
            error: {code: 'revision_conflict', message: 'The scene moved on'}
        })
    )

    await runAgent({
        settings: {...settings, baseUrl: `http://127.0.0.1:${String(port)}/v1`},
        messages: [{sender: 'user', text: 'Save the scene', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, true)
    assert.match(end.output, /revision_conflict/u)
})

/*
 * The prompt itself is composed in Rust and shown to the user in settings, so what is left to
 * prove here is that the worker does not touch it: the text arrives whole and reaches the model
 * whole. Memory is the exception, because it is this turn's data rather than the user's wording.
 */
test('the system prompt reaches the model as it arrived, with this turn’s memory behind it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // One server per turn: the shared mock accumulates request bodies, and this test compares two.
    const systemPrompt = async extra => {
        const mock = startServer()
        await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
        try {
            await runAgent({
                settings: {
                    ...settings,
                    baseUrl: `http://127.0.0.1:${String(mock.server.address().port)}/v1`
                },
                systemPrompt: 'Be brief. Never mention cats.',
                messages: [{sender: 'user', text: 'Hello', timestamp: 1}],
                workspacePath: workspace.path,
                emit: () => undefined,
                ...extra
            })
            return mock.request().body.messages[0].content
        } finally {
            mock.server.close()
        }
    }

    assert.equal(await systemPrompt({}), 'Be brief. Never mention cats.')
    const withTools = await systemPrompt({
        tools: catalog,
        host: {call: () => Promise.resolve({})},
        memoryContext: 'The player is a cat.'
    })
    assert.equal(
        withTools,
        'Be brief. Never mention cats.\n\nRelevant persistent project memory:\nThe player is a cat.'
    )
})

/**
 * A model scripted turn by turn: `calls` answers with tool calls, `text` ends the turn on a
 * message. The request bodies are kept because half of what these tests prove is what reaches the
 * model — an error code it must read, an image it must see, a tool it was never asked to confirm.
 */
function startScriptedServer(turns) {
    const bodies = []
    let turn = 0
    const server = createServer((request, response) => {
        let body = ''
        request.on('data', chunk => {
            body += chunk
        })
        request.on('end', () => {
            bodies.push(JSON.parse(body))
            const script = turns[Math.min(turn, turns.length - 1)]
            turn += 1
            const calls = script.calls ?? []
            const delta =
                calls.length > 0 ?
                    {
                        role: 'assistant',
                        tool_calls: calls.map((call, index) => ({
                            index,
                            id: `call-${String(turn)}-${String(index)}`,
                            type: 'function',
                            function: {name: call.name, arguments: JSON.stringify(call.args)}
                        }))
                    }
                :   {role: 'assistant', content: script.text ?? 'Done'}
            const frame = choices => ({
                id: `chatcmpl-${String(turn)}`,
                object: 'chat.completion.chunk',
                created: 1,
                model: settings.model,
                choices
            })
            response.writeHead(200, {'content-type': 'text/event-stream'})
            response.write(
                `data: ${JSON.stringify(frame([{index: 0, delta, finish_reason: null}]))}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    ...frame([
                        {
                            index: 0,
                            delta: {},
                            finish_reason: calls.length > 0 ? 'tool_calls' : 'stop'
                        }
                    ]),
                    usage: {prompt_tokens: 8, completion_tokens: 2, total_tokens: 10}
                })}\n\n`
            )
            response.end('data: [DONE]\n\n')
        })
    })
    return {bodies, server}
}

async function baseUrl(context, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    return `http://127.0.0.1:${String(server.address().port)}/v1`
}

test('parallel domain calls are answered out of order without crossing results', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {
            calls: [
                {name: 'godot_scene', args: {op: 'get_tree', params: {}}},
                {name: 'godot_runtime', args: {op: 'capture', params: {}}}
            ]
        },
        {text: 'Both answered'}
    ])
    const url = await baseUrl(context, mock.server)
    // The backend's half: hold both requests, then answer them in reverse arrival order. Two calls
    // are in flight at once precisely because the channel is duplex, and only the correlation id
    // says which result belongs to which.
    const held = []
    const host = createToolHost(call => {
        held.push(call)
        if (held.length < 2) return
        for (const request of [...held].reverse())
            host.deliver({
                type: 'tool-result',
                id: request.id,
                ok: true,
                result: {answered: request.params.op}
            })
    })
    const events = []

    const completion = await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Inspect and capture', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Both answered')
    assert.deepEqual(
        held.map(request => request.params.op),
        ['get_tree', 'capture']
    )
    const requested = new Map(
        events.filter(event => event.type === 'tool-start').map(event => [event.id, event.target])
    )
    const ended = events.filter(event => event.type === 'tool-end')
    assert.equal(ended.length, 2)
    for (const end of ended)
        assert.equal(JSON.parse(end.output).answered, requested.get(end.id), end.id)
    assert.equal(host.pendingCount, 0)
})

test('aborting a turn cancels the domain tool call it is waiting on', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'godot_scene', args: {op: 'get_tree', params: {}}}]}
    ])
    const url = await baseUrl(context, mock.server)
    let notifyCalled
    const called = new Promise(resolve => {
        notifyCalled = resolve
    })
    // A backend that never answers: the only thing that can settle this call is the abort.
    const host = createToolHost(() => notifyCalled())
    const controller = new AbortController()
    const events = []

    const completion = runAgent({
        settings: {...settings, baseUrl: url, maxRetries: 0},
        messages: [{sender: 'user', text: 'Inspect the scene', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event),
        signal: controller.signal
    })
    await called
    controller.abort()

    const result = await completion
    assert.equal(result.stopReason, 'aborted')
    assert.equal(host.pendingCount, 0)
})

test('a tool call left unanswered is settled when the backend closes the channel', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'godot_scene', args: {op: 'get_tree', params: {}}}]},
        {text: 'The scene could not be read'}
    ])
    const url = await baseUrl(context, mock.server)
    const worker = spawn(process.execPath, ['scripts/ai-worker.mjs'], {cwd: process.cwd()})
    context.after(() => worker.kill())
    const events = []
    const finished = new Promise(resolve => worker.on('exit', resolve))
    createInterface({input: worker.stdout}).on('line', line => {
        // The backend goes away mid-call: the channel closes instead of the request being answered.
        if (line.startsWith(TOOL_PREFIX)) return worker.stdin.end()
        if (line.startsWith(EVENT_PREFIX)) events.push(JSON.parse(line.slice(EVENT_PREFIX.length)))
    })

    worker.stdin.write(
        `${JSON.stringify({
            settings: {...settings, baseUrl: url},
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

test('a denied approval reaches the model as approval_denied without failing the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'godot_resource', args: {op: 'delete', params: {path: 'main.tscn'}}}]},
        {text: 'I did not delete it'}
    ])
    const url = await baseUrl(context, mock.server)
    const host = createToolHost(call =>
        host.deliver({
            type: 'tool-result',
            id: call.id,
            ok: false,
            error: {code: 'approval_denied', message: 'The user declined the tool call'}
        })
    )
    const events = []

    const completion = await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Delete main.tscn', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    // A refusal is an answer, not a failure: the turn continues and the model reads the code, which
    // the system prompt has already told it not to retry.
    assert.equal(completion.text, 'I did not delete it')
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, true)
    assert.match(end.output, /approval_denied/u)
    assert.equal(mock.bodies.length, 2)
    const answer = mock.bodies[1].messages.at(-1)
    assert.equal(answer.role, 'tool')
    assert.match(JSON.stringify(answer.content), /approval_denied/u)
})

test('a captured frame reaches the model as an image and not as base64 in the tool text', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const data = 'iVBORw0KGgoAAAANSUhEUg=='
    const mock = startScriptedServer([
        {calls: [{name: 'godot_runtime', args: {op: 'capture', params: {}}}]},
        {text: 'The label changed'}
    ])
    const url = await baseUrl(context, mock.server)
    const host = createToolHost(call =>
        host.deliver({
            type: 'tool-result',
            id: call.id,
            ok: true,
            result: {
                running: true,
                frame: {encoding: 'png-base64', width: 320, height: 240, data}
            }
        })
    )
    const events = []

    await runAgent({
        settings: {...settings, baseUrl: url, input: ['text', 'image']},
        messages: [{sender: 'user', text: 'Capture the game', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    // The frame rides the second request as an image part; the text the model reads keeps the
    // frame's dimensions and drops its payload, which is worth nothing as characters.
    assert.match(JSON.stringify(mock.bodies[1]), new RegExp(`data:image/png;base64,${data}`, 'u'))
    const tool = mock.bodies[1].messages.find(message => message.role === 'tool')
    assert.doesNotMatch(JSON.stringify(tool.content), new RegExp(data, 'u'))
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, false)
    assert.equal(JSON.parse(end.output).frame.width, 320)
    assert.equal(JSON.parse(end.output).frame.data, undefined)
})

test('the confined shell does destructive work in the worktree without asking anyone', async context => {
    const workspace = await temporaryWorkspace({'stale.tmp': 'remove me'})
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'bash', args: {command: 'rm stale.tmp'}}]},
        {text: 'Removed'}
    ])
    const url = await baseUrl(context, mock.server)
    // The Godot tools are offered, so a gated typed delete was available; nothing reaches the
    // backend because the shell is the deliberate autonomous exception to the approval model.
    const asked = []
    const host = {call: (tool, params) => Promise.resolve(asked.push({tool, params}) && {})}
    const events = []

    await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Remove the stale file', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    assert.deepEqual(await readdir(workspace.path), [])
    assert.deepEqual(asked, [])
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, false)
    assert.equal(events.find(event => event.type === 'tool-start').target, 'rm stale.tmp')
})

const NO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
}

/**
 * A stored conversation long enough to cross the compaction line.
 *
 * Every turn reports no usage, so the size the worker measures comes from the text itself rather
 * than from a server's token accounting — which is what makes the line the test crosses a number
 * the test controls.
 */
function longConversation(pairs, characters) {
    const messages = []
    for (let index = 0; index < pairs; index += 1) {
        messages.push({role: 'user', content: 'u'.repeat(characters), timestamp: index * 2 + 1})
        messages.push({
            role: 'assistant',
            content: [{type: 'text', text: 'a'.repeat(characters)}],
            api: 'openai-completions',
            provider: 'local',
            model: settings.model,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: index * 2 + 2
        })
    }
    return messages
}

test('a conversation past the compaction line is summarised before the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'SUMMARY OF THE EARLY WORK'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(60, 3_500)
    const events = []

    const completion = await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    // The summary comes first, and costs a second request when the cut lands mid-turn: the history
    // and the half-finished turn above it are summarised separately. Then comes the turn itself.
    assert.ok(mock.bodies.length >= 2, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[0].messages), /summarization assistant/)

    const sent = mock.bodies.at(-1).messages
    assert.ok(sent.length < history.length, 'the turn is shorter than the conversation it replaced')
    const summary = sent.find(message =>
        JSON.stringify(message).includes('SUMMARY OF THE EARLY WORK')
    )
    // The Agent's default message conversion drops this message. Losing it would leave a turn that
    // is shorter, cheaper, and has forgotten everything — which no assertion on length would catch.
    assert.ok(summary, 'the summary reaches the model')
    assert.equal(summary.role, 'user')

    // Stored is what was sent, so the next turn starts from the compacted conversation rather than
    // summarising the same history again.
    assert.ok(completion.agentMessages.length < history.length)
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')

    // Summarising happens before a single token of the answer exists, so the only thing that keeps
    // the wait from reading as a hang is that it is announced and then withdrawn.
    const start = events.find(event => event.type === 'compaction-start')
    assert.ok(start, 'the wait is announced')
    assert.equal(start.contextWindow, 120_064)
    assert.ok(start.tokens > start.contextWindow * 0.86)
    assert.ok(
        events.indexOf(start) < events.findIndex(event => event.type === 'compaction-end'),
        'and withdrawn once the summary exists'
    )
})

test('compaction set to 100 percent sends the conversation whole', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Carried on'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(60, 3_500)

    await runAgent({
        settings: {...settings, baseUrl: url, compactionPercent: 100},
        systemPrompt: 'You are Gofer.',
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies.length, 1)
    // The system prompt and the new prompt on either side of an untouched conversation.
    assert.equal(mock.bodies[0].messages.length, history.length + 2)
})
