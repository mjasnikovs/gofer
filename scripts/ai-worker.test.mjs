import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import test from 'node:test'
import {canSeePictures} from './ai-provider.mjs'
import {pathToFileURL} from 'node:url'
import {
    EVENT_PREFIX,
    TOOL_PREFIX,
    createGodotTools,
    createToolHost,
    normalizeToolCalls,
    toolResult,
    withoutPictures
} from './ai-host.mjs'
import Ajv from 'ajv'

import {probeTools} from './ai-reachability.mjs'
import {createChildTools} from './ai-subagent.mjs'
import {createAgentTools, retryDelay, runAgent} from './ai-provider.mjs'

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
    let headers = {}
    const server = createServer((request, response) => {
        authorization = request.headers.authorization ?? ''
        headers = request.headers
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
        request: () => ({body: JSON.parse(body), authorization, headers})
    }
}

/// The session the turn belongs to has to reach the request, and nothing else notices when it does
/// not: the turn works, it just pays for the whole story on every ask. It was read from a settings
/// field that has never existed, so every request went out anonymous — a measured 24-ask turn cost
/// 328,533 tokens against about 12,664 characters of tool output, and one lucky ask cost 875.
test('carries the task through to the request, so a server can route it to its own cache', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()

    try {
        await runAgent({
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(address.port)}/v1`},
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            sessionId: 'task-9f2c',
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(mock.request().headers['x-session-affinity'], 'task-9f2c')
    } finally {
        mock.server.close()
    }
})

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
            ['read', 'write', 'edit', 'bash', 'subagent', 'web_search', 'web_fetch']
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
    const result = spawnSync(process.execPath, [WORKER_ENTRY], {
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
        // The ask that issued the call is charged to it, by id and not by time. `input + output`
        // and never `cacheRead`, which is the same prompt re-sent on every ask of the turn.
        const cost = events.find(event => event.type === 'tool-cost')
        assert.deepEqual(cost.ids, [events.find(event => event.type === 'tool-start').id])
        assert.equal(cost.tokens, 13)
        // The final ask answered with text, so it issued no calls and charged nothing.
        assert.equal(events.filter(event => event.type === 'tool-cost').length, 1)

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
    },
    // The tool the reachability pass was written for: it answers through a sidecar and a model
    // cache, so it is the one that can be declared with nothing behind it.
    {
        name: 'godot_docs_search',
        description: 'The Godot documentation on this machine.',
        operations: [{op: 'search', summary: 'Retrieves ranked passages: {question}.'}]
    }
]

/**
 * The backend's half of the startup reachability probe.
 *
 * Every fake backend below answers it, because a turn no longer starts against a tool that does
 * not answer — which is the whole point of the pass. A fake that stayed silent would be testing a
 * backend the application would refuse to talk to.
 */
function isProbe(call) {
    return call.params?.probe === true
}

function probeResult(call) {
    return {type: 'tool-result', id: call.id, ok: true, result: {tool: call.tool, reachable: true}}
}

/** The tool calls a turn made, with the startup probes taken out. */
function withoutProbes(calls) {
    return calls.filter(call => !isProbe(call))
}

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

test('two hosts reading one stream never answer each other', async () => {
    const toolCalls = []
    const credentialCalls = []
    const tools = createToolHost(call => toolCalls.push(call))
    const credentials = createToolHost(call => credentialCalls.push(call), 'credential')

    const tool = tools.call('godot_scene', {op: 'get_tree'})
    const stored = credentials.call('store', {credential: {type: 'oauth'}})
    assert.notEqual(toolCalls[0].id, credentialCalls[0].id)

    // Every line reaches every host, so only the id keeps the two apart.
    for (const answer of [
        {type: 'tool-result', id: credentialCalls[0].id, ok: true},
        {type: 'tool-result', id: toolCalls[0].id, ok: true, result: {revision: 7}}
    ]) {
        tools.deliver(answer)
        credentials.deliver(answer)
    }

    assert.deepEqual(await tool, {revision: 7})
    assert.equal(await stored, undefined)
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
        ['godot_scene', 'godot_runtime', 'godot_resource', 'godot_docs_search']
    )
    assert.deepEqual(tools[0].parameters.properties.ops.items.properties.op.enum, [
        'get_tree',
        'save'
    ])
    assert.match(tools[0].description, /get_tree: Returns the edited scene hierarchy\./u)
    const result = await tools[0].execute(
        'call-1',
        tools[0].prepareArguments({ops: [{op: 'get_tree'}]})
    )
    assert.deepEqual(calls, [{tool: 'godot_scene', params: {ops: [{op: 'get_tree'}]}}])
    assert.deepEqual(result.details, {nodes: []})
    assert.equal(createGodotTools(undefined, host).length, 0)
})

/**
 * The two narrowings read differently, and neither one caps the list.
 *
 * `godot_session` used to advertise a list of exactly one, because all seven of its operations were
 * marked alone. The mark meant two different things, and the schema said the stricter of them about
 * both: a live project wrote `[stop, start]` and `[get_state, answer_dialog]` and was refused, for
 * ordinary two-step requests the router walks in order. Only the debugger is exclusive now.
 */
test('an exclusive operation and a once-only operation are advertised apart', () => {
    const session = [
        {
            op: 'status',
            summary: 'Reports the session state.',
            alone: {scope: 'repeat', why: 'It takes no parameters.'}
        },
        {
            op: 'undo',
            summary: 'Undoes the last operation.',
            alone: {scope: 'repeat', why: 'One undo stack, walked in order.'}
        }
    ]
    const debug = [
        {op: 'threads', summary: 'Lists the threads.', alone: null},
        {
            op: 'continue',
            summary: 'Resumes the debuggee.',
            alone: {scope: 'exclusive', why: 'One debuggee, driven in order.'}
        }
    ]
    const [owned, driven] = createGodotTools(
        [
            {name: 'godot_session', description: 'd', operations: session},
            {name: 'godot_debug', description: 'd', operations: debug}
        ],
        {call: async () => ({})}
    )

    // Nothing is capped: a list of two different operations is what `ops` is for.
    assert.equal(owned.parameters.properties.ops.maxItems, undefined)
    assert.equal(driven.parameters.properties.ops.maxItems, undefined)

    // A repeat operation is named as one that may not appear twice, never as one that must be alone.
    assert.match(owned.parameters.properties.ops.description, /may not appear twice: status, undo/u)
    assert.doesNotMatch(owned.parameters.properties.ops.description, /only entry of their call/u)
    assert.match(owned.description, /not twice in one call: It takes no parameters\./u)

    // An exclusive one keeps the stronger sentence, and only it.
    assert.match(
        driven.parameters.properties.ops.description,
        /only entry of their call: continue/u
    )
    assert.doesNotMatch(driven.parameters.properties.ops.description, /may not appear twice/u)
    assert.match(driven.description, /only entry of its call: One debuggee, driven in order\./u)
})

/**
 * The domains as `createGodotTools` receives them, built from the declared parameter contract.
 *
 * The real catalogue is serialized by the Rust crate, which merges prose from `ai_tools.rs` with
 * this file. Only the parameters and the narrowing reach the JSON schema — a summary is a sentence
 * in the description — so reading them here costs no cargo build, and `check:command-surface` is
 * what holds the two halves together.
 */
async function declaredDomains() {
    const {operations} = JSON.parse(
        await readFile(new URL('../protocol/schemas/v2/params.json', import.meta.url), 'utf8')
    )
    const domains = new Map()
    for (const entry of operations) {
        const operations = domains.get(entry.tool) ?? []
        operations.push({
            op: entry.op,
            summary: `${entry.op}.`,
            params: entry.params ?? [],
            alone: entry.alone ?? null
        })
        domains.set(entry.tool, operations)
    }
    return [...domains].map(([name, operations]) => ({name, description: name, operations}))
}

/**
 * Every distinct `ops` shape a model wrote across sixteen real tasks validates against the schema.
 *
 * `fixtures/recorded-tool-calls.json` is 712 calls from a live project reduced to their 93 distinct
 * operation lists. The Rust gate has its own pass over the same file; this one is the layer above
 * it, where the agent loop refuses a call before the router ever sees it.
 */
test('every recorded ops shape validates against the advertised schema', async () => {
    const recorded = JSON.parse(
        await readFile(new URL('../fixtures/recorded-tool-calls.json', import.meta.url), 'utf8')
    )
    const tools = createGodotTools(await declaredDomains(), {call: async () => ({})})
    const validate = new Ajv({strict: false, allErrors: true})
    let checked = 0
    for (const recordedCase of recorded.cases) {
        const tool = tools.find(candidate => candidate.name === recordedCase.tool)
        assert.ok(tool, `${recordedCase.tool} is recorded and is not advertised`)
        const check = validate.compile(tool.parameters)
        assert.ok(
            check({ops: recordedCase.ops}),
            `${recordedCase.tool} ${JSON.stringify(recordedCase.ops.map(op => op.op))}: ${validate.errorsText(check.errors)}`
        )
        checked += 1
    }
    assert.ok(checked > 50, 'the fixture lost its cases')
})

/**
 * The entry schema is one object per domain, not one branch per operation.
 *
 * Measured, not preferred. Branching per `op` refuses a call by reporting every branch it did not
 * match — a `godot_script save` missing its `text` came back as eight lines, two of them `must be
 * equal to constant` about operations the caller never named. `if`/`then` reports one line, and it
 * is `must match "then" schema`, naming neither parameter nor operation. So the types are enforced
 * here, where an error is about one named key, and which parameters belong to which operation is
 * enforced by `tool_params::check`, which names the parameter and prints the corrected call.
 */
test('the entry schema types every parameter and leaves the rest to the router', () => {
    const domain = [
        {
            op: 'save',
            summary: 'Writes a whole file.',
            params: [
                {name: 'path', kind: 'text', required: true, entry: []},
                {name: 'text', kind: 'text', required: true, entry: []},
                {name: 'expectedHash', kind: 'hash', required: false, entry: []}
            ]
        },
        {
            op: 'diagnostics',
            summary: 'Diagnostics for a file.',
            params: [
                {
                    name: 'path',
                    kind: 'either',
                    of: [{kind: 'text'}, {kind: 'list'}],
                    required: true,
                    entry: []
                },
                {name: 'timeoutMs', kind: 'int', required: false, entry: []}
            ]
        }
    ]
    const [tool] = createGodotTools(
        [{name: 'godot_script', description: 'd', operations: domain}],
        {
            call: async () => ({})
        }
    )
    const entry = tool.parameters.properties.ops.items

    // Every kind is a real JSON type, which is the whole reason this schema is generated.
    assert.deepEqual(entry.properties.text, {type: 'string'})
    assert.deepEqual(entry.properties.timeoutMs, {type: 'integer'})
    assert.deepEqual(entry.properties.expectedHash, {
        type: 'string',
        pattern: '^[0-9a-f]{64}$'
    })
    // Two operations, two shapes for one name: the entry accepts either and the router decides.
    assert.deepEqual(entry.properties.path, {anyOf: [{type: 'string'}, {type: 'array'}]})

    // Only `op` is required here. A missing parameter is the router's to name.
    assert.deepEqual(entry.required, ['op'])
    assert.deepEqual(entry.properties.op.enum, ['save', 'diagnostics'])
    assert.equal(entry.additionalProperties, true)
})

// Every call below was written by a model in a recorded turn and refused. The op is real, the
// parameters are real, and only the wrapper was in the wrong place.
test('the wrapper a model got wrong is repaired rather than refused', () => {
    const script = [
        {op: 'open', params: [{name: 'path', kind: 'text', required: true}]},
        {
            op: 'edit',
            params: [{name: 'files', kind: 'list', required: true}]
        }
    ]
    const runtime = [
        {
            op: 'inspect_node',
            params: [
                {name: 'path', kind: 'text', required: true},
                {name: 'properties', kind: 'list', required: false}
            ]
        }
    ]

    // The parameter list flat beside the op, which is the shape the schema now asks for.
    assert.deepEqual(normalizeToolCalls(script, {ops: [{op: 'open', path: 'scripts/enemy.gd'}]}), {
        ops: [{path: 'scripts/enemy.gd', op: 'open'}]
    })

    // The wrapper under the name the prose uses.
    assert.deepEqual(
        normalizeToolCalls(runtime, {
            ops: [{op: 'inspect_node', parameters: {path: '/root/Main/Game'}}]
        }),
        {ops: [{path: '/root/Main/Game', op: 'inspect_node'}]}
    )

    // One parameter hoisted out of a wrapper that is otherwise right.
    assert.deepEqual(
        normalizeToolCalls([{op: 'set', params: [{name: 'node'}, {name: 'expectedRevision'}]}], {
            ops: [{op: 'set', expectedRevision: 0, params: {node: '/Main'}}]
        }),
        {ops: [{expectedRevision: 0, node: '/Main', op: 'set'}]}
    )

    // A key no parameter is named after reaches the router, which refuses it by name and offers
    // the near miss. Dropped here, the call would run without it and answer as if it had worked.
    assert.deepEqual(normalizeToolCalls(script, {ops: [{op: 'open', file: 'scripts/enemy.gd'}]}), {
        ops: [{file: 'scripts/enemy.gd', op: 'open'}]
    })

    // Unless a wrapper was written too, which is the shape the dropping was measured on: the
    // parameters in their wrapper, and something loose beside it that was never one of them.
    assert.deepEqual(
        normalizeToolCalls(script, {
            ops: [{op: 'open', thinking: 'now open it', params: {path: 'a.gd'}}]
        }),
        {ops: [{path: 'a.gd', op: 'open'}]}
    )

    // The wrapper as sent stays the wrapper, and it wins over a flat key of the same name.
    assert.deepEqual(
        normalizeToolCalls(script, {ops: [{op: 'open', path: 'a.gd', params: {path: 'b.gd'}}]}),
        {ops: [{path: 'b.gd', op: 'open'}]}
    )

    // No list at all: the previous shape, and what a model writes when it wants one thing. A list
    // of one rather than a refusal, because refusing it would spend a round trip teaching a bracket.
    assert.deepEqual(normalizeToolCalls(script, {op: 'open', path: 'a.gd'}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    // A domain with one operation still does not need to be told which: there is only one, so a
    // call that omits `op` is not ambiguous.
    assert.deepEqual(normalizeToolCalls([script[0]], {ops: [{path: 'a.gd'}]}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    // The operation under the word the prose uses. A live turn wrote this and was refused with four
    // `must not have additional properties` lines that never named the key it should have written.
    assert.deepEqual(normalizeToolCalls(script, {ops: [{operation: 'open', path: 'a.gd'}]}), {
        ops: [{path: 'a.gd', op: 'open'}]
    })

    // `method` is a real parameter on other operations, so it is never read as the operation.
    assert.deepEqual(
        normalizeToolCalls([{op: 'connect', params: [{name: 'method'}]}], {
            ops: [{op: 'connect', method: '_on_pressed'}]
        }),
        {ops: [{method: '_on_pressed', op: 'connect'}]}
    )
})

test('a call is a list, and a bare operation is a list of one', async () => {
    const calls = []
    const host = {
        call: (tool, params) => {
            calls.push({tool, params})
            return Promise.resolve({passages: []})
        }
    }
    const [scene, , , docs] = createGodotTools(catalog, host)

    // As the agent loop drives it: arguments are prepared, then validated against the schema, then
    // executed. Repair that happened after validation would already have been refused.
    const drive = (tool, id, args) => tool.execute(id, tool.prepareArguments(args))

    // Three questions in one call, which is the whole reason the list exists. Sent one at a time,
    // each would be a turn of its own waiting on the one before it.
    await drive(docs, 'call-1', {
        ops: [{question: 'Camera2D shake'}, {question: 'TileMapLayer'}, {question: 'AnimationTree'}]
    })
    // The op is the only one there is, so an entry that omits it is not ambiguous — and a call with
    // no list at all is the one a model writes when it reads the operation line and nothing else.
    await drive(docs, 'call-2', {question: 'Camera2D shake'})
    await drive(docs, 'call-3', {op: 'search', params: {question: 'Camera2D shake'}})
    assert.deepEqual(
        calls.map(call => call.params),
        [
            {
                ops: [
                    {question: 'Camera2D shake', op: 'search'},
                    {question: 'TileMapLayer', op: 'search'},
                    {question: 'AnimationTree', op: 'search'}
                ]
            },
            {ops: [{question: 'Camera2D shake', op: 'search'}]},
            {ops: [{question: 'Camera2D shake', op: 'search'}]}
        ]
    )

    // Every tool asks for the list, whatever it holds.
    assert.deepEqual(scene.parameters.required, ['ops'])
    assert.deepEqual(docs.parameters.required, ['ops'])
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
            settings: {...settings, baseUrl: `http://127.0.0.1:${String(port)}/v1`},
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
    assert.deepEqual(
        requests.filter(isProbe).map(request => request.tool),
        [...catalog.map(domain => domain.name), 'ask_user']
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

test('a refused tool call reaches the model as an error result', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const server = startToolCallingServer('godot_scene', {op: 'save', params: {}})
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    const port = server.address().port
    const events = []
    const host = createToolHost(call =>
        host.deliver(
            isProbe(call) ?
                probeResult(call)
            :   {
                    type: 'tool-result',
                    id: call.id,
                    ok: false,
                    error: {code: 'revision_conflict', message: 'The scene moved on'}
                }
        )
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
 *
 * `usage` is what the server says the request cost, which is the number compaction has to trust
 * over any estimate. `error` fails the request the way llama.cpp does, body and status and all.
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
            if (script.error) {
                response.writeHead(script.error.status ?? 400, {
                    'content-type': 'application/json'
                })
                response.end(
                    JSON.stringify({
                        error: {message: script.error.message, type: 'invalid_request_error'}
                    })
                )
                return
            }
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
                    usage: script.usage ?? {
                        prompt_tokens: 8,
                        completion_tokens: 2,
                        total_tokens: 10
                    }
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
        if (isProbe(call)) return host.deliver(probeResult(call))
        held.push(call)
        if (held.length < 2) return
        for (const request of [...held].reverse())
            host.deliver({
                type: 'tool-result',
                id: request.id,
                ok: true,
                result: {answered: request.params.ops[0].op}
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
        held.map(request => request.params.ops[0].op),
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
    // A backend that never answers the call the model made: the only thing that can settle it is
    // the abort. The startup probes are answered, or the turn would never reach the model.
    const host = createToolHost(call => {
        if (isProbe(call)) return host.deliver(probeResult(call))
        notifyCalled()
    })
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
        host.deliver(
            isProbe(call) ?
                probeResult(call)
            :   {
                    type: 'tool-result',
                    id: call.id,
                    ok: false,
                    error: {code: 'approval_denied', message: 'The user declined the tool call'}
                }
        )
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
    assert.deepEqual(withoutProbes(asked), [])
    const end = events.find(event => event.type === 'tool-end')
    assert.equal(end.isError, false)
    assert.equal(events.find(event => event.type === 'tool-start').target, 'rm stale.tmp')
})

/*
 * The defect the reachability pass exists for: a tool the model is told about, with nothing behind
 * it. Zero documentation searches across ten live sweeps was never the model declining the tool.
 */
test('a declared tool that cannot answer stops the turn before the model is asked', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'this turn must never reach the model'}])
    const url = await baseUrl(context, mock.server)
    const host = createToolHost(call =>
        host.deliver(
            call.tool === 'godot_docs_search' ?
                {
                    type: 'tool-result',
                    id: call.id,
                    ok: false,
                    error: {
                        code: 'docs_unavailable',
                        message: 'the retrieve worker was not found'
                    }
                }
            :   probeResult(call)
        )
    )

    await assert.rejects(
        runAgent({
            settings: {...settings, baseUrl: url},
            messages: [{sender: 'user', text: 'How does Tween work?', timestamp: 1}],
            workspacePath: workspace.path,
            tools: catalog,
            host,
            emit: () => undefined
        }),
        error => {
            // The failure names the one tool that could not answer, and only that one.
            assert.match(
                error.message,
                /godot_docs_search: docs_unavailable: the retrieve worker was not found/u
            )
            assert.doesNotMatch(error.message, /godot_scene/u)
            return true
        }
    )

    assert.equal(mock.bodies.length, 0)
    // The probe leaves the worktree as it found it, including when it fails.
    assert.deepEqual(await readdir(workspace.path), [])
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
            settings: {...settings, baseUrl: url},
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

test('the workspace tools are proven against the workspace, not assumed', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'this turn must never reach the model'}])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: {...settings, baseUrl: url},
            messages: [{sender: 'user', text: 'Fix the script', timestamp: 1}],
            // The worktree the turn was given is gone. Every file tool is dead, and the shell has
            // nowhere to start.
            workspacePath: join(workspace.path, 'removed-worktree'),
            emit: () => undefined
        }),
        error => {
            for (const name of ['read', 'write', 'edit', 'bash'])
                assert.match(error.message, new RegExp(`- ${name}: `, 'u'))
            return true
        }
    )
    assert.equal(mock.bodies.length, 0)
})

/*
 * The chain has a beginning, and a caller that does not hold it still has to be provable.
 *
 * The four workspace probes each prove the one before them, and `write` is what creates the file the
 * other three work on. A research worker holds `read` and `bash` and nothing else, so both failed on
 * a file that was never going to exist — every planned task died before its first phase, reported as
 * two tools that could not answer.
 */
test('read and bash are provable without a write tool to set them up', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const {env, tools} = createChildTools(workspace.path, {toolNames: ['read', 'bash']})
    context.after(() => env.cleanup())

    await probeTools({tools, workspacePath: workspace.path})

    // And the file is still taken away afterwards, so a seeded probe does not leave litter in the
    // worktree the agent is about to work in.
    assert.deepEqual(
        (await readdir(workspace.path)).filter(name => name.startsWith('.gofer-tool-probe')),
        []
    )
})

test('a tool that never answers its probe is given up on, and one the turn outlived is not', async () => {
    const silent = {
        name: 'godot_scene',
        execute: () => new Promise(() => undefined)
    }
    const workspace = await temporaryWorkspace()

    await assert.rejects(
        probeTools({
            tools: [silent],
            host: {call: () => new Promise(() => undefined)},
            workspacePath: workspace.path,
            timeoutMs: 20
        }),
        /godot_scene: it did not answer within 0\.02 seconds/u
    )

    // A domain tool with no channel behind it is the same defect one layer up.
    await assert.rejects(
        probeTools({tools: [silent], workspacePath: workspace.path}),
        /godot_scene: there is no channel to answer it/u
    )

    // A turn stopped while the probes are running fails as stopped rather than as unreachable.
    await assert.rejects(
        probeTools({
            tools: [silent],
            host: {call: () => new Promise(() => undefined)},
            workspacePath: workspace.path,
            signal: AbortSignal.abort()
        }),
        /godot_scene: the turn was stopped/u
    )

    await workspace.remove()
})

test('a workspace tool that answers without doing its work is caught by the next one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // The shape the whole refactor is about: a tool that reports success and changed nothing. It
    // is the read after it that says so, because the probe is a read-back rather than four
    // independent calls.
    const pretending = {
        name: 'edit',
        execute: () => Promise.resolve({content: [{type: 'text', text: 'Successfully edited'}]})
    }
    const real = createAgentTools(workspace.path, undefined, undefined).tools.filter(tool =>
        ['write', 'read'].includes(tool.name)
    )

    await assert.rejects(
        probeTools({tools: [...real, pretending], workspacePath: workspace.path}),
        /- read: it answered without the text the probe wrote: expected reachable, got/u
    )
    assert.deepEqual(await readdir(workspace.path), [])
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

/*
 * The next three tests are the Mario session of 2026-08-08. One prompt, one twenty-minute turn:
 * the context crossed the line while the turn ran, nothing compacted because the only check had
 * already happened at the turn's start, and the turn died where Pi on the same server recovers.
 * Pi's policy is checked after every assistant message, on the usage the server reported. These
 * tests hold this worker to that policy.
 */

test('a turn that crosses the line mid-flight compacts before its next request', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // Textually the history estimates well under the line, so the pre-turn check stays quiet. The
    // server then reports what the estimate missed: this conversation is already at 110k tokens.
    const history = longConversation(30, 3_500)
    const mock = startScriptedServer([
        {
            calls: [{name: 'bash', args: {command: 'echo grown'}}],
            usage: {prompt_tokens: 110_000, completion_tokens: 200, total_tokens: 110_200}
        },
        {text: 'MID-TURN SUMMARY'},
        {text: 'Finished the level'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    // The turn finishes; summarising was one or two requests of its own between the tool result
    // and the answer, and the answer was asked against the compacted conversation, not the whole.
    assert.equal(completion.text, 'Finished the level')
    assert.ok(mock.bodies.length >= 3, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[1].messages), /summarization assistant/u)
    const finalRequest = JSON.stringify(mock.bodies.at(-1).messages)
    assert.match(finalRequest, /MID-TURN SUMMARY/u)
    assert.ok(mock.bodies.at(-1).messages.length < mock.bodies[0].messages.length)

    // The wait is announced with the number the server reported, not the estimate that missed it.
    const start = events.find(event => event.type === 'compaction-start')
    assert.ok(start, 'mid-turn compaction is announced')
    assert.ok(start.tokens >= 110_000)
    assert.ok(
        events.indexOf(start) > events.findIndex(event => event.type === 'tool-end'),
        'the line was crossed mid-turn, after the tool ran'
    )

    // Stored is what was sent, so the next turn starts from the compacted conversation.
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')
})

test('a context overflow from the model compacts and retries instead of failing the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const history = longConversation(30, 3_500)
    // llama.cpp's overflow, verbatim. Pi strips the error, compacts, and asks again; a worker that
    // surfaces this error instead hands the user a Retry button that wipes the conversation.
    const mock = startScriptedServer([
        {
            error: {
                status: 400,
                message: 'the request exceeds the available context size, try increasing it'
            }
        },
        {text: 'RECOVERY SUMMARY'},
        {text: 'Recovered and finished'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: {...settings, baseUrl: url, maxRetries: 0},
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Recovered and finished')
    assert.ok(mock.bodies.length >= 3, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[1].messages), /summarization assistant/u)
    const retried = JSON.stringify(mock.bodies.at(-1).messages)
    assert.match(retried, /RECOVERY SUMMARY/u)
    // The failed attempt is rolled back, not summarised: an error message in the retried context
    // would teach the model that its last answer was the error text.
    assert.doesNotMatch(retried, /exceeds the available context size/u)
    assert.ok(events.find(event => event.type === 'compaction-start'))
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')
})

test('overflow recovery is attempted once, not forever', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // A server that overflows on every request, including the summary request. One recovery
    // attempt is owed; a second is a loop against a model that cannot answer.
    const mock = startScriptedServer([
        {
            error: {
                status: 400,
                message: 'the request exceeds the available context size, try increasing it'
            }
        }
    ])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: {...settings, baseUrl: url, maxRetries: 0},
            messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
            agentMessages: longConversation(30, 3_500),
            workspacePath: workspace.path,
            emit: () => undefined
        }),
        /context/iu
    )
    assert.ok(mock.bodies.length <= 3, 'the turn gives up instead of looping')
})

test('a turn reports what the agent remembers at every step, not only at the end', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'bash', args: {command: 'echo one'}}]},
        {text: 'Done'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Run it', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    // Two steps, so two checkpoints — the first one lands while the turn is still running, which is
    // the only reason a turn that dies part-way leaves anything behind at all.
    const checkpoints = events.filter(event => event.type === 'turn-state')
    assert.equal(checkpoints.length, 2)
    assert.ok(checkpoints[0].agentMessages.length > 0)
    assert.ok(
        events.indexOf(checkpoints[0]) < events.findIndex(event => event.type === 'done'),
        'the first checkpoint arrives before the turn ends'
    )
})

test('a retry drops the abandoned answer and does not ask the prompt twice', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'This time it worked'}])
    const url = await baseUrl(context, mock.server)
    // What a crashed turn leaves behind: the settled turn above it, then its own prompt and the
    // half-finished work it did before it died.
    const crashed = [
        ...longConversation(1, 20),
        {role: 'user', content: 'Build the level', timestamp: 10},
        {
            role: 'assistant',
            content: [{type: 'text', text: 'Starting on it'}],
            api: 'openai-completions',
            provider: 'local',
            model: settings.model,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: 11
        }
    ]

    await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Build the level', timestamp: 10}],
        agentMessages: crashed,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = mock.bodies[0].messages
    // The one settled turn, then the prompt being asked again — and only once.
    assert.equal(sent.length, 3)
    assert.equal(
        sent.filter(message => JSON.stringify(message).includes('Build the level')).length,
        1
    )
    assert.ok(!JSON.stringify(sent).includes('Starting on it'), 'the abandoned answer is dropped')
})

/**
 * One step of agentic work in the shape the agent stores it: a call, then its result.
 *
 * This is what a long turn is almost entirely made of. A conversation of six bubbles on screen was
 * two hundred and thirty five of these in the transcript on disk, so what a retry does to them is
 * what a retry does to the model's memory.
 */
function toolStep(marker, at) {
    return [
        {
            role: 'assistant',
            content: [
                {type: 'text', text: `Working on ${marker}`},
                {type: 'toolCall', id: `call-${marker}`, name: 'bash', arguments: {command: 'ls'}}
            ],
            api: 'openai-completions',
            provider: 'local',
            model: settings.model,
            usage: NO_USAGE,
            stopReason: 'toolUse',
            timestamp: at
        },
        {
            role: 'toolResult',
            toolCallId: `call-${marker}`,
            toolName: 'bash',
            content: [{type: 'text', text: `result of ${marker}`}],
            isError: false,
            timestamp: at + 1
        }
    ]
}

/** One settled exchange in the shape the agent stores it. */
function settledTurn(prompt, answer, at) {
    return [
        {role: 'user', content: prompt, timestamp: at},
        {
            role: 'assistant',
            content: [{type: 'text', text: answer}],
            api: 'openai-completions',
            provider: 'local',
            model: settings.model,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: at + 1
        }
    ]
}

test('a retry of a turn that never checkpointed keeps the turns before it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Exported'}])
    const url = await baseUrl(context, mock.server)
    // A turn can fail before it stores anything: the worker cannot start, the process is killed,
    // the tool probe refuses. The transcript then still ends at the last turn that succeeded, and
    // the failed prompt was never written into it.
    const transcript = [
        ...settledTurn('Build the level', 'Built it', 1),
        ...settledTurn('Add a light', 'Added it', 3)
    ]

    await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [
            {sender: 'user', text: 'Build the level', timestamp: 1},
            {sender: 'assistant', text: 'Built it', timestamp: 2},
            {sender: 'user', text: 'Add a light', timestamp: 3},
            {sender: 'assistant', text: 'Added it', timestamp: 4},
            {sender: 'user', text: 'Now export it', timestamp: 5}
        ],
        agentMessages: transcript,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = JSON.stringify(mock.bodies[0].messages)
    // Nothing the screen still shows may be taken off the model's memory by a retry.
    assert.ok(sent.includes('Build the level'), 'the first turn survives')
    assert.ok(sent.includes('Add a light'), 'the last settled prompt survives')
    assert.ok(sent.includes('Added it'), 'the last settled answer survives')
    assert.ok(sent.includes('Now export it'), 'the prompt being retried is asked')
})

test('a retry keeps the work the turn already did', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Picking up where it stopped'}])
    const url = await baseUrl(context, mock.server)
    // Force-quit mid-turn: the prompt is on the transcript, so are twenty steps of real work, and
    // the turn never got to write an answer. The screen shows four bubbles; the model remembers
    // forty-five messages. Retry must not be the thing that throws the forty-one away.
    const transcript = [
        ...settledTurn('Create Mario 1-1 clone.', 'Built it', 1),
        {role: 'user', content: 'Debug errors', timestamp: 3},
        ...Array.from({length: 20}, (_, index) =>
            toolStep(`step${String(index)}`, 10 + index * 2)
        ).flat()
    ]

    await runAgent({
        settings: {...settings, baseUrl: url},
        // What `retryPlan` sends: every message except the reply being rewritten, so the last one
        // is the user turn being asked again.
        messages: [
            {sender: 'user', text: 'Create Mario 1-1 clone.', timestamp: 1},
            {sender: 'assistant', text: 'Built it', timestamp: 2},
            {sender: 'user', text: 'Debug errors', timestamp: 3}
        ],
        agentMessages: transcript,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = JSON.stringify(mock.bodies[0].messages)
    // Every step the turn managed to take is still the model's to build on.
    for (let index = 0; index < 20; index += 1) {
        assert.ok(sent.includes(`result of step${String(index)}`), `step ${String(index)} survives`)
    }
    // And the question is still asked exactly once.
    assert.equal(sent.split('Debug errors').length - 1, 1)
})

test('a retry of a turn that answered replaces the answer, not the work', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'A better answer'}])
    const url = await baseUrl(context, mock.server)
    const transcript = [
        {role: 'user', content: 'Debug errors', timestamp: 3},
        ...toolStep('one', 10),
        {
            role: 'assistant',
            content: [{type: 'text', text: 'I gave up'}],
            api: 'openai-completions',
            provider: 'local',
            model: settings.model,
            usage: NO_USAGE,
            stopReason: 'error',
            errorMessage: 'connection lost',
            timestamp: 20
        }
    ]

    const completion = await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Debug errors', timestamp: 3}],
        agentMessages: transcript,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = JSON.stringify(mock.bodies[0].messages)
    assert.ok(sent.includes('result of one'), 'the work survives')
    // The answer being retried is not left in front of the model as its own last word.
    assert.ok(!sent.includes('I gave up'), 'the failed answer is replaced')
    assert.equal(completion.text, 'A better answer')
})

/** The turn-level retry only. `maxRetries: 0` switches the provider's own HTTP retry off. */
const impatient = {maxRetries: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 1}

test('the wait doubles from five seconds and is held at a minute', () => {
    const policy = {baseDelayMs: 5_000, maxDelayMs: 60_000}
    const waits = Array.from({length: 10}, (_, index) => retryDelay(index + 1, policy))
    assert.deepEqual(
        waits,
        [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]
    )
})

test('a turn whose model drops out is asked again by itself', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // A model that died and came back — the everyday failure a local runtime has.
    const mock = startScriptedServer([
        {error: {status: 503, message: 'upstream connect error: connection refused'}},
        {text: 'Back online'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: {...settings, ...impatient, baseUrl: url},
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Back online')
    const scheduled = events.filter(event => event.type === 'retry-scheduled')
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].attempt, 1)
    assert.equal(scheduled[0].maxAttempts, 10)
    assert.ok(events.some(event => event.type === 'retry-start'))
    // The prompt is on the transcript already, so the retry continues rather than asking twice.
    assert.equal(JSON.stringify(mock.bodies.at(-1).messages).split('Build the level').length - 1, 1)
    // An error message left in the transcript teaches the model that its last word was the error.
    assert.ok(!JSON.stringify(completion.agentMessages).includes('connection refused'))
})

test('a turn gives up once its retry budget is spent', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{error: {status: 503, message: 'service unavailable'}}])
    const url = await baseUrl(context, mock.server)
    const events = []

    await assert.rejects(
        runAgent({
            settings: {...settings, ...impatient, baseUrl: url, retryAttempts: 2},
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            emit: event => events.push(event)
        }),
        /unavailable/iu
    )

    // The first ask, then two retries. Not forever.
    assert.equal(mock.bodies.length, 3)
    assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 2)
})

test('a failure that will not fix itself is not waited on', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    // A spent quota is the account's problem, not the moment's. Waiting only delays the news.
    const mock = startScriptedServer([
        {error: {status: 429, message: 'insufficient_quota: quota exceeded for this key'}}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    await assert.rejects(
        runAgent({
            settings: {...settings, ...impatient, baseUrl: url},
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            emit: event => events.push(event)
        }),
        /quota/iu
    )

    assert.equal(mock.bodies.length, 1)
    assert.ok(!events.some(event => event.type === 'retry-scheduled'))
})

test('an ordinary turn keeps the transcript it was given', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Carrying on'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(2, 20)

    await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'Next', timestamp: 99}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies[0].messages.length, history.length + 1)
})

test('an empty transcript is rebuilt from the conversation on screen', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Carrying on'}])
    const url = await baseUrl(context, mock.server)
    const events = []

    // What a task looks like after its first turn failed: three messages on screen, and a model
    // that was never told any of them.
    await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [
            {sender: 'user', text: 'Earlier question', timestamp: 1},
            {sender: 'assistant', text: 'Earlier answer', timestamp: 2},
            {sender: 'user', text: 'Continue', timestamp: 3}
        ],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.deepEqual(
        mock.bodies[0].messages.map(message => message.role),
        ['user', 'assistant', 'user']
    )
    const rebuilt = events.find(event => event.type === 'context-rebuilt')
    assert.ok(rebuilt, 'the rebuild is announced rather than done silently')
    assert.equal(rebuilt.messages, 2)
})

test('a first turn with nothing behind it rebuilds nothing', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Starting'}])
    const url = await baseUrl(context, mock.server)
    const events = []

    await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'First question', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(mock.bodies[0].messages.length, 1)
    assert.ok(!events.some(event => event.type === 'context-rebuilt'))
})

test('a delegated question comes back as an answer, not as what it read', async context => {
    const workspace = await temporaryWorkspace({
        'physics.gd': `extends Node\n${'# padding\n'.repeat(200)}const SPEED = 512 # SECRET-MARKER\n`
    })
    context.after(workspace.remove)
    const mock = startScriptedServer([
        // The parent delegates.
        {calls: [{name: 'subagent', args: {prompt: 'Where is the player speed set?'}}]},
        // The child reads the big file, then answers from it.
        {calls: [{name: 'read', args: {path: 'physics.gd'}}]},
        {text: 'physics.gd sets SPEED to 512.'},
        // The parent answers its user.
        {text: 'The speed is 512, set in physics.gd.'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: {...settings, baseUrl: url},
        messages: [{sender: 'user', text: 'How fast does the player move?', timestamp: 1}],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'The speed is 512, set in physics.gd.')
    assert.equal(mock.bodies.length, 4)

    // The whole point, asserted on the wire: the child read two hundred lines and the parent's
    // context holds one sentence about them. The marker only ever existed in the child's request.
    const child = JSON.stringify(mock.bodies[2])
    const parent = JSON.stringify(mock.bodies[3])
    assert.match(child, /SECRET-MARKER/u)
    assert.doesNotMatch(parent, /SECRET-MARKER/u)
    assert.match(parent, /physics\.gd sets SPEED to 512/u)
    // And what it cost rides with it, on the call that spent it.
    assert.match(parent, /sub-agent: Qwen3\.6-27B-UD-Q4_K_XL\.gguf, 2 steps/u)

    // On screen it is one tool row, named and captioned by the question it was asked.
    const started = events.find(event => event.type === 'tool-start')
    assert.equal(started.name, 'subagent')
    assert.equal(started.target, 'Where is the player speed set?')
    assert.equal(events.find(event => event.type === 'tool-end').isError, false)
})

/** A child given a model of its own: a small one to read with, on the connection it names. */
const SMALL_MODEL = {
    connectionType: 'openai-compatible',
    model: 'small.gguf',
    modelName: 'Small',
    contextWindow: 8192,
    maxTokens: 4096,
    reasoning: false,
    supportsReasoningEffort: false,
    input: ['text'],
    thinkingLevel: 'off'
}

/*
 * The whole point of letting the child name a model: the parent plans on the large one and the
 * child reads on the small one. Asserted on the wire, because the child builds its own `Agent` and
 * nothing between here and the request would notice it streaming through the parent's model object.
 */
test('a delegation is answered by the model the sub-agent was given, not the parents', async context => {
    const workspace = await temporaryWorkspace({'physics.gd': 'extends Node\n'})
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {calls: [{name: 'subagent', args: {prompt: 'Where is the speed set?'}}]},
        {text: 'physics.gd sets it.'},
        {text: 'The speed is set in physics.gd.'}
    ])
    const url = await baseUrl(context, mock.server)

    await runAgent({
        settings: {
            ...settings,
            baseUrl: url,
            subagent: {connection: SMALL_MODEL}
        },
        messages: [{sender: 'user', text: 'How fast does the player move?', timestamp: 1}],
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies[0].model, settings.model)
    assert.equal(mock.bodies[1].model, 'small.gguf')
    assert.equal(mock.bodies[2].model, settings.model)
})

/*
 * The two connections a turn may need at once, which is the arrangement the whole field exists for:
 * a ChatGPT parent that plans, and a local child that reads. Both providers are registered on one
 * `Models`, and this proves the registration rather than the requests — the parent's own ask needs
 * a ChatGPT credential no test has. What it must never fail with is the local provider missing.
 */
test('registers both connections when the sub-agent is on the other one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const failure = await runAgent({
        settings: {
            ...settings,
            connectionType: 'openai-codex',
            model: 'gpt-5.4-mini',
            maxRetries: 0,
            local: {...settings, baseUrl: 'http://127.0.0.1:1/v1'},
            subagent: {connection: SMALL_MODEL}
        },
        messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
        workspacePath: workspace.path,
        emit: () => undefined
    }).then(
        () => '',
        error => String(error)
    )

    assert.doesNotMatch(failure, /Unknown provider/u)
    assert.match(failure, /openai-codex/u)
})

test('stops the turn by name when the sub-agent has nowhere to run', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Done'}])
    const url = await baseUrl(context, mock.server)

    const start = configuration =>
        runAgent({
            settings: {...settings, baseUrl: url, ...configuration},
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        }).then(
            () => '',
            error => String(error)
        )

    // A local child on a settings file that has never held a local connection.
    assert.match(
        await start({
            connectionType: 'openai-codex',
            model: 'gpt-5.4-mini',
            local: undefined,
            subagent: {connection: SMALL_MODEL}
        }),
        /no local connection is configured/u
    )

    // And a ChatGPT model that is not in this Pi release.
    assert.match(
        await start({
            subagent: {connection: {...SMALL_MODEL, connectionType: 'openai-codex', model: 'gpt-2'}}
        }),
        /'gpt-2' is unavailable on ChatGPT/u
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
            settings: {...settings, baseUrl: url},
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
            settings: {...settings, baseUrl: url, retryAttempts: 0},
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            sessionId: 'task-9f2c',
            workspacePath: workspace.path
        })

        assert.equal(await exitedWithin(session.exited, 10_000), 1, session.stderr())
        assert.match(session.stderr(), /The request was rejected/u)
    }
)

/**
 * A picture a text-only model cannot see costs it a sentence, not the whole request.
 *
 * `read` hands back a real image part for a PNG, and llama.cpp refuses the request rather than the
 * part it cannot use: one live turn died on `failed to process mtmd chunk` after the agent read a
 * tileset to match the game's art. Which is exactly what an agent asked about a layout will do.
 */
test('a tool answering with an image is stripped for a model that cannot see', async () => {
    const png = {
        content: [
            {type: 'text', text: 'Read image file [image/png]'},
            {type: 'image', data: 'iVBOR', mimeType: 'image/png'}
        ]
    }
    const tool = {name: 'read', execute: () => Promise.resolve(png)}

    const blind = await withoutPictures(tool).execute('id', {})
    assert.equal(blind.content.length, 2)
    assert.equal(blind.content[1].type, 'text')
    assert.match(blind.content[1].text, /you cannot see/u)

    // A model that was declared as taking images keeps them, and a result with none is untouched.
    assert.equal(canSeePictures({input: ['text', 'image']}), true)
    assert.equal(canSeePictures({input: ['text']}), false)
    assert.equal(canSeePictures(undefined), false)
    const plain = {content: [{type: 'text', text: 'hello'}]}
    assert.equal(
        await withoutPictures({name: 'read', execute: () => plain}).execute('id', {}),
        plain
    )
})
