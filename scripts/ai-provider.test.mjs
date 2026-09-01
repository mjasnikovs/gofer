import assert from 'node:assert/strict'
import {readFile, readdir, rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import test from 'node:test'
import {createToolHost} from './ai-host.mjs'
import {cannedModels} from './ai-subagent.mjs'
import {
    createAgentTools,
    createModelContext,
    DRIVERS,
    DRIVER_SECRETS,
    outOfRoom,
    readableProviderError,
    retryDelay,
    runAgent
} from './ai-provider.mjs'
import {
    MODEL_ID,
    NO_USAGE,
    SMALL_MODEL,
    baseUrl,
    catalog,
    impatient,
    instantTimers,
    isProbe,
    longConversation,
    probeResult,
    servedBy,
    settings,
    settledTurn,
    startScriptedServer,
    startServer,
    startToolCallingServer,
    temporaryWorkspace,
    toolStep,
    withoutProbes
} from './ai-turn-harness.mjs'

test('carries the task through to the request, so a server can route it to its own cache', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
            secrets: {'ai-default': 'secret'},
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
        assert.equal(request.body.model, MODEL_ID)
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
                model: {input: ['text', 'image']}
            }),
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
        settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
            model: {input: ['text', 'image']}
        }),
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
        settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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
                    model: MODEL_ID,
                    choices: [{index: 0, delta: {role: 'assistant', content: 'I'}}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-full',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
                maxRetries: 0,
                model: {contextWindow: 120_064}
            }),
            messages: [{sender: 'user', text: 'Carry on', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        }),
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {maxRetries: 0}),
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
        settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`, {
            maxRetries: 0,
            timeoutMs: 60_000
        }),
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
                    model: MODEL_ID,
                    choices: [{index: 0, delta, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: `chatcmpl-${requestCount}`,
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
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
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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
        const cost = events.find(event => event.type === 'tool-cost')
        assert.deepEqual(cost.ids, [events.find(event => event.type === 'tool-start').id])
        assert.equal(cost.tokens, 13)
        assert.equal(events.filter(event => event.type === 'tool-cost').length, 1)

        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
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
        settings: servedBy(`http://127.0.0.1:${String(port)}/v1`),
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

test('the system prompt reaches the model as it arrived, and this turn’s own data does not', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const sent = async extra => {
        const mock = startServer()
        await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
        try {
            await runAgent({
                settings: servedBy(`http://127.0.0.1:${String(mock.server.address().port)}/v1`),
                systemPrompt: 'Be brief. Never mention cats.',
                messages: [{sender: 'user', text: 'Hello', timestamp: 1}],
                workspacePath: workspace.path,
                emit: () => undefined,
                ...extra
            })
            const {messages} = mock.request().body
            return {system: messages[0].content, prompt: messages.at(-1).content}
        } finally {
            mock.server.close()
        }
    }

    const godot = {tools: catalog, host: {call: () => Promise.resolve({})}}

    const bare = await sent({})
    assert.equal(bare.system, 'Be brief. Never mention cats.')
    assert.equal(bare.prompt, 'Hello')

    const withMemory = await sent({...godot, memoryContext: 'The player is a cat.'})
    assert.equal(withMemory.system, 'Be brief. Never mention cats.')
    assert.equal(
        withMemory.prompt,
        'Hello\n\nRelevant persistent project memory:\nThe player is a cat.'
    )

    const withSession = await sent({
        ...godot,
        memoryContext: 'The player is a cat.',
        sessionContext: 'Editor session: ready. Godot 4.7.2.'
    })
    assert.equal(withSession.system, 'Be brief. Never mention cats.')
    assert.equal(
        withSession.prompt,
        'Hello'
            + '\n\nRelevant persistent project memory:\nThe player is a cat.'
            + '\n\nEditor session: ready. Godot 4.7.2.'
    )

    const withInventory = await sent({
        ...godot,
        memoryContext: 'The player is a cat.',
        sessionContext: 'Editor session: ready. Godot 4.7.2.',
        inventory: "The project's tracked files:\nscripts/player.gd"
    })
    assert.equal(withInventory.system, 'Be brief. Never mention cats.')
    assert.equal(
        withInventory.prompt,
        'Hello'
            + '\n\nRelevant persistent project memory:\nThe player is a cat.'
            + '\n\nEditor session: ready. Godot 4.7.2.'
            + "\n\nThe project's tracked files:\nscripts/player.gd"
    )

    assert.deepEqual(await sent({sessionContext: undefined}), {
        system: 'Be brief. Never mention cats.',
        prompt: 'Hello'
    })
    assert.deepEqual(await sent({inventory: undefined}), {
        system: 'Be brief. Never mention cats.',
        prompt: 'Hello'
    })
})

test('parallel domain calls are answered out of order without crossing results', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {
            calls: [
                {name: 'godot_docs_search', args: {op: 'search', question: 'signals'}},
                {name: 'godot_docs_search', args: {op: 'search', question: 'tweens'}}
            ]
        },
        {text: 'Both answered'}
    ])
    const url = await baseUrl(context, mock.server)
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
                result: {answered: request.params.ops[0].question}
            })
    })
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Inspect and capture', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Both answered')
    assert.deepEqual(
        held.map(request => request.params.ops[0].question),
        ['signals', 'tweens']
    )
    const started = events.filter(event => event.type === 'tool-start').map(event => event.id)
    const requested = new Map(started.map((id, index) => [id, held[index].params.ops[0].question]))
    const ended = events.filter(event => event.type === 'tool-end')
    assert.equal(ended.length, 2)
    for (const end of ended)
        assert.equal(JSON.parse(end.output).answered, requested.get(end.id), end.id)
    assert.equal(host.pendingCount, 0)
})

test('two editor calls in one message do not overlap', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {
            calls: [
                {name: 'godot_runtime', args: {op: 'capture', params: {}}},
                {name: 'godot_scene', args: {op: 'save', params: {}}}
            ]
        },
        {text: 'Stopped, then saved'}
    ])
    const url = await baseUrl(context, mock.server)
    const order = []
    let inFlight = 0
    let overlapped = false
    const host = createToolHost(call => {
        if (isProbe(call)) return host.deliver(probeResult(call))
        order.push(call.params.ops[0].op)
        inFlight += 1
        if (inFlight > 1) overlapped = true
        setTimeout(() => {
            inFlight -= 1
            host.deliver({type: 'tool-result', id: call.id, ok: true, result: {ran: true}})
        }, 5)
    })

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Capture, then save', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: () => undefined
    })

    assert.equal(completion.text, 'Stopped, then saved')
    assert.equal(overlapped, false, 'two editor calls were in flight at once')
    assert.deepEqual(order, ['capture', 'save'])
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
    const host = createToolHost(call => {
        if (isProbe(call)) return host.deliver(probeResult(call))
        notifyCalled()
    })
    const controller = new AbortController()
    const events = []

    const completion = runAgent({
        settings: servedBy(url, {maxRetries: 0}),
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
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Delete main.tscn', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

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
        settings: servedBy(url, {model: {input: ['text', 'image']}}),
        messages: [{sender: 'user', text: 'Capture the game', timestamp: 1}],
        workspacePath: workspace.path,
        tools: catalog,
        host,
        emit: event => events.push(event)
    })

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
    const asked = []
    const host = {call: (tool, params) => Promise.resolve(asked.push({tool, params}) && {})}
    const events = []

    await runAgent({
        settings: servedBy(url),
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

test('a conversation past the compaction line is summarised before the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'SUMMARY OF THE EARLY WORK'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(60, 3_500)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.ok(mock.bodies.length >= 2, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[0].messages), /summarization assistant/)

    const sent = mock.bodies.at(-1).messages
    assert.ok(sent.length < history.length, 'the turn is shorter than the conversation it replaced')
    const summary = sent.find(message =>
        JSON.stringify(message).includes('SUMMARY OF THE EARLY WORK')
    )
    assert.ok(summary, 'the summary reaches the model')
    assert.equal(summary.role, 'user')

    assert.ok(completion.agentMessages.length < history.length)
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')

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
        settings: servedBy(url, {compactionPercent: 100}),
        systemPrompt: 'You are Gofer.',
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies.length, 1)
    assert.equal(mock.bodies[0].messages.length, history.length + 2)
})

test('a turn that crosses the line mid-flight compacts before its next request', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
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
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Keep going', timestamp: 999}],
        agentMessages: history,
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Finished the level')
    assert.ok(mock.bodies.length >= 3, 'the summary is a request of its own')
    assert.match(JSON.stringify(mock.bodies[1].messages), /summarization assistant/u)
    const finalRequest = JSON.stringify(mock.bodies.at(-1).messages)
    assert.match(finalRequest, /MID-TURN SUMMARY/u)
    assert.ok(mock.bodies.at(-1).messages.length < mock.bodies[0].messages.length)

    const start = events.find(event => event.type === 'compaction-start')
    assert.ok(start, 'mid-turn compaction is announced')
    assert.ok(start.tokens >= 110_000)
    assert.ok(
        events.indexOf(start) > events.findIndex(event => event.type === 'tool-end'),
        'the line was crossed mid-turn, after the tool ran'
    )

    assert.equal(completion.agentMessages[0].role, 'compactionSummary')
})

test('a context overflow from the model compacts and retries instead of failing the turn', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const history = longConversation(30, 3_500)
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
        settings: servedBy(url, {maxRetries: 0}),
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
    assert.doesNotMatch(retried, /exceeds the available context size/u)
    assert.ok(events.find(event => event.type === 'compaction-start'))
    assert.equal(completion.agentMessages[0].role, 'compactionSummary')
})

test('overflow recovery is attempted once, not forever', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
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
            settings: servedBy(url, {maxRetries: 0}),
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
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Run it', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

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
    const crashed = [
        ...longConversation(1, 20),
        {role: 'user', content: 'Build the level', timestamp: 10},
        {
            role: 'assistant',
            content: [{type: 'text', text: 'Starting on it'}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: 11
        }
    ]

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 10}],
        agentMessages: crashed,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = mock.bodies[0].messages
    assert.equal(sent.length, 3)
    assert.equal(
        sent.filter(message => JSON.stringify(message).includes('Build the level')).length,
        1
    )
    assert.ok(!JSON.stringify(sent).includes('Starting on it'), 'the abandoned answer is dropped')
})

test('a retry of a turn that never checkpointed keeps the turns before it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Exported'}])
    const url = await baseUrl(context, mock.server)
    const transcript = [
        ...settledTurn('Build the level', 'Built it', 1),
        ...settledTurn('Add a light', 'Added it', 3)
    ]

    await runAgent({
        settings: servedBy(url),
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
    const transcript = [
        ...settledTurn('Create Mario 1-1 clone.', 'Built it', 1),
        {role: 'user', content: 'Debug errors', timestamp: 3},
        ...Array.from({length: 20}, (_, index) =>
            toolStep(`step${String(index)}`, 10 + index * 2)
        ).flat()
    ]

    await runAgent({
        settings: servedBy(url),
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
    for (let index = 0; index < 20; index += 1) {
        assert.ok(sent.includes(`result of step${String(index)}`), `step ${String(index)} survives`)
    }
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
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'error',
            errorMessage: 'connection lost',
            timestamp: 20
        }
    ]

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Debug errors', timestamp: 3}],
        agentMessages: transcript,
        isRetry: true,
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = JSON.stringify(mock.bodies[0].messages)
    assert.ok(sent.includes('result of one'), 'the work survives')
    assert.ok(!sent.includes('I gave up'), 'the failed answer is replaced')
    assert.equal(completion.text, 'A better answer')
})

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
    const mock = startScriptedServer([
        {error: {status: 503, message: 'upstream connect error: connection refused'}},
        {text: 'Back online'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Back online')
    assert.deepEqual(timers.waited, [5_000])
    const scheduled = events.filter(event => event.type === 'retry-scheduled')
    assert.equal(scheduled.length, 1)
    assert.equal(scheduled[0].attempt, 1)
    assert.equal(scheduled[0].maxAttempts, 10)
    assert.ok(events.some(event => event.type === 'retry-start'))
    assert.equal(JSON.stringify(mock.bodies.at(-1).messages).split('Build the level').length - 1, 1)
    assert.ok(!JSON.stringify(completion.agentMessages).includes('connection refused'))
})

test('a stop during the wait between attempts ends the turn as stopped', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: {status: 503, message: 'upstream connect error: connection refused'}},
        {text: 'Back online'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const controller = new AbortController()
    const timers = {
        ...instantTimers(),
        schedule(_fn, ms) {
            queueMicrotask(() => {
                controller.abort()
            })
            return ms
        }
    }

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        signal: controller.signal,
        emit: event => events.push(event)
    })

    assert.equal(completion.stopReason, 'aborted')
    assert.ok(
        events.some(event => event.type === 'retry-scheduled'),
        'the wait had begun'
    )
    assert.ok(
        !events.some(event => event.type === 'retry-start'),
        'and the attempt it was waiting for never ran'
    )
    assert.equal(mock.bodies.length, 1, 'the provider was not asked again')
})

test('a turn gives up once its retry budget is spent', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{error: {status: 503, message: 'service unavailable'}}])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    await assert.rejects(
        runAgent({
            settings: servedBy(url, impatient),
            retry: {attempts: 2},
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers,
            emit: event => events.push(event)
        }),
        /unavailable/iu
    )

    assert.equal(mock.bodies.length, 3)
    assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 2)
    assert.deepEqual(timers.waited, [5_000, 10_000])
})

const RATE_LIMITED = {
    status: 429,
    body: {
        error: {
            message: 'Provider returned error',
            code: 429,
            metadata: {
                raw: 'stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.',
                provider_name: 'Stealth',
                limit_source: 'upstream_provider_shared_pool',
                remedy_hint: 'Retry shortly, or add your own provider key.'
            }
        },
        user_id: 'user_3IJE3NGNCSCGpZVhEluB5fQ6ck5'
    }
}

test('a rate-limited turn is asked again in a second, not five', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: RATE_LIMITED},
        {error: RATE_LIMITED},
        {text: 'Through on the third ask'}
    ])
    const url = await baseUrl(context, mock.server)
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: () => {}
    })

    assert.equal(completion.text, 'Through on the third ask')
    assert.deepEqual(timers.waited, [1_000, 2_000])
})

test('a turn that has been rate-limited keeps the short curve when the wording changes', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: RATE_LIMITED},
        {error: {status: 503, message: 'Provider returned error'}},
        {error: RATE_LIMITED},
        {text: 'Through'}
    ])
    const url = await baseUrl(context, mock.server)
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: () => {}
    })

    assert.equal(completion.text, 'Through')
    assert.deepEqual(timers.waited, [1_000, 2_000, 4_000])
})

test('a failure that is not a rate limit keeps the five-second curve', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: {status: 503, message: 'upstream connect error: connection refused'}},
        {text: 'Back online'}
    ])
    const url = await baseUrl(context, mock.server)
    const timers = instantTimers()

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers,
        emit: () => {}
    })

    assert.equal(completion.text, 'Back online')
    assert.deepEqual(timers.waited, [5_000])
})

test('a spent rate-limit budget ends the turn in a sentence, not in JSON', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{error: RATE_LIMITED}])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: servedBy(url, impatient),
            retry: {attempts: 1},
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers: instantTimers(),
            emit: () => {}
        }),
        error => {
            assert.equal(
                error.message,
                'The provider refused this request (429): stealth/ox-alpha is temporarily '
                    + 'rate-limited upstream. Please retry shortly. Retry shortly, or add your own '
                    + 'provider key.'
            )
            assert.ok(!error.message.includes('{'), 'no JSON reaches the user')
            return true
        }
    )
})

test('a quota that will never clear is not retried, however it is worded', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {
            error: {
                status: 429,
                body: {
                    error: {
                        type: 'GoUsageLimitError',
                        code: 429,
                        message: 'You have reached your plan limit.'
                    }
                }
            }
        }
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    await assert.rejects(
        runAgent({
            settings: servedBy(url, impatient),
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers,
            emit: event => events.push(event)
        }),
        /plan limit/u
    )

    assert.equal(mock.bodies.length, 1, 'the provider was asked once and not again')
    assert.ok(!events.some(event => event.type === 'retry-scheduled'))
    assert.deepEqual(timers.waited, [])
})

test('a provider error that is not JSON is left alone', () => {
    assert.equal(readableProviderError('fetch failed'), 'fetch failed')
    assert.equal(readableProviderError('429: not json at all'), '429: not json at all')
    assert.equal(readableProviderError(undefined), undefined)
})

test('a failure that will not fix itself is not waited on', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {error: {status: 429, message: 'insufficient_quota: quota exceeded for this key'}}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []
    const timers = instantTimers()

    await assert.rejects(
        runAgent({
            settings: servedBy(url, impatient),
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers,
            emit: event => events.push(event)
        }),
        /quota/iu
    )

    assert.equal(mock.bodies.length, 1)
    assert.ok(!events.some(event => event.type === 'retry-scheduled'))
    assert.deepEqual(timers.waited, [])
})

test('a turn that stops without saying anything is asked again', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: ''}, {text: 'Back with an answer'}])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url, impatient),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers: instantTimers(),
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Back with an answer')
    assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 1)
    assert.equal(JSON.stringify(mock.bodies.at(-1).messages).split('Build the level').length - 1, 1)
})

test('a turn that only thought and never answered is asked again', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([
        {reasoning: 'Let me work out what they want.'},
        {text: 'Back with an answer'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url, {...impatient, model: {reasoning: true}}),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
        agentMessages: [],
        workspacePath: workspace.path,
        timers: instantTimers(),
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'Back with an answer')
    assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 1)
})

test('a turn that only ever stops without saying anything gives up loudly', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: ''}])
    const url = await baseUrl(context, mock.server)

    await assert.rejects(
        runAgent({
            settings: servedBy(url, impatient),
            retry: {attempts: 2},
            messages: [{sender: 'user', text: 'Build the level', timestamp: 1}],
            agentMessages: [],
            workspacePath: workspace.path,
            timers: instantTimers(),
            emit: () => undefined
        }),
        /empty/iu
    )

    assert.equal(mock.bodies.length, 3)
})

test('an ordinary turn keeps the transcript it was given', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const mock = startScriptedServer([{text: 'Carrying on'}])
    const url = await baseUrl(context, mock.server)
    const history = longConversation(2, 20)

    await runAgent({
        settings: servedBy(url),
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

    await runAgent({
        settings: servedBy(url),
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
        settings: servedBy(url),
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
        {calls: [{name: 'subagent', args: {prompt: 'Where is the player speed set?'}}]},
        {calls: [{name: 'read', args: {path: 'physics.gd'}}]},
        {text: 'physics.gd sets SPEED to 512.'},
        {text: 'The speed is 512, set in physics.gd.'}
    ])
    const url = await baseUrl(context, mock.server)
    const events = []

    const completion = await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'How fast does the player move?', timestamp: 1}],
        workspacePath: workspace.path,
        emit: event => events.push(event)
    })

    assert.equal(completion.text, 'The speed is 512, set in physics.gd.')
    assert.equal(mock.bodies.length, 4)

    const child = JSON.stringify(mock.bodies[2])
    const parent = JSON.stringify(mock.bodies[3])
    assert.match(child, /SECRET-MARKER/u)
    assert.doesNotMatch(parent, /SECRET-MARKER/u)
    assert.match(parent, /physics\.gd sets SPEED to 512/u)
    assert.match(parent, /sub-agent: Qwen3\.6-27B-UD-Q4_K_XL\.gguf, 2 steps/u)

    const started = events.find(event => event.type === 'tool-start')
    assert.equal(started.name, 'subagent')
    assert.equal(started.target, 'Where is the player speed set?')
    assert.equal(events.find(event => event.type === 'tool-end').isError, false)
})

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
        settings: servedBy(url, {subagent: {connection: SMALL_MODEL}}),
        messages: [{sender: 'user', text: 'How fast does the player move?', timestamp: 1}],
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies[0].model, MODEL_ID)
    assert.equal(mock.bodies[1].model, 'small.gguf')
    assert.equal(mock.bodies[2].model, MODEL_ID)
})

test('registers both connections when the sub-agent is on the other one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const failure = await runAgent({
        settings: {
            ...settings,
            connectionType: 'openai-codex',
            maxRetries: 0,
            connections: {
                ...servedBy('http://127.0.0.1:1/v1').connections,
                'openai-codex': {
                    name: 'ChatGPT subscription',
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    chatTemplateThinking: false,
                    model: {id: 'gpt-5.4-mini'}
                }
            },
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
            settings: {...servedBy(url), ...configuration},
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        }).then(
            () => '',
            error => String(error)
        )

    assert.match(
        await start({
            connectionType: 'openai-codex',
            connections: {
                'openai-codex': {
                    name: 'ChatGPT subscription',
                    baseUrl: 'https://chatgpt.com/backend-api',
                    api: 'openai-codex-responses',
                    chatTemplateThinking: false,
                    model: {id: 'gpt-5.4-mini'}
                }
            },
            subagent: {connection: SMALL_MODEL}
        }),
        /no local connection is configured/u
    )

    assert.match(
        await start({
            subagent: {
                connection: {
                    connectionType: 'openai-codex',
                    model: {...SMALL_MODEL.model, id: 'gpt-2'}
                }
            }
        }),
        /'gpt-2' is unavailable on ChatGPT/u
    )
})

test('a turn whose verification failed carries the verdict in its answer', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const spec =
        'GOAL\nA thing.\n\nVERIFY\n```sh\n'
        + '# the boss registers every part it builds\n'
        + 'sh -c "exit 1"\n'
        + '# the project is still there\n'
        + 'sh -c "exit 0"\n'
        + '```\n'

    try {
        const completion = await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
            messages: [{sender: 'user', text: spec, images: [], timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.match(completion.text, /^Hello/u)
        assert.match(completion.text, /Verification failed: 1 of 2 points/u)
        assert.match(completion.text, /FAIL {2}the boss registers every part it builds/u)
        assert.match(completion.text, /PASS {2}the project is still there/u)
        assert.equal(completion.verify.failed, 1)
        assert.deepEqual(completion.verify.points, [
            {name: 'the boss registers every part it builds', passed: false},
            {name: 'the project is still there', passed: true}
        ])
    } finally {
        mock.server.close()
    }
})

test('a turn that passes its verification says nothing extra', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const address = mock.server.address()
    const spec = 'GOAL\nA thing.\n\nVERIFY\n```sh\n# it is there\nsh -c "exit 0"\n```\n'

    try {
        const completion = await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(address.port)}/v1`),
            messages: [{sender: 'user', text: spec, images: [], timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(completion.text, 'Hello Gofer')
        assert.equal(completion.verify.failed, 0)
    } finally {
        mock.server.close()
    }
})

test('a chat-template server is sent the argument that turns thinking on', () => {
    const template = {
        name: 'Local AI',
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'openai-completions',
        chatTemplateThinking: true,
        model: {
            id: 'local.gguf',
            name: 'local.gguf',
            contextWindow: 120_064,
            maxTokens: 120_064,
            reasoning: true,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text'],
            thinkingLevel: 'on'
        }
    }
    const on = connection => ({
        connectionType: 'openai-compatible',
        connections: {'openai-compatible': connection}
    })
    const {model} = createModelContext({settings: on(template), secrets: {'ai-default': 'local'}})

    assert.equal(model.compat.thinkingFormat, 'chat-template')
    assert.deepEqual(model.compat.chatTemplateKwargs, {
        enable_thinking: {$var: 'thinking.enabled'},
        preserve_thinking: true
    })

    const {model: withEfforts} = createModelContext({
        settings: on({
            ...template,
            model: {...template.model, supportsReasoningEffort: true, thinkingLevel: 'medium'}
        }),
        secrets: {'ai-default': 'local'}
    })
    assert.deepEqual(withEfforts.compat.chatTemplateKwargs.reasoning_effort, {
        $var: 'thinking.effort',
        omitWhenOff: true
    })

    const {model: plain} = createModelContext({
        settings: on({...template, chatTemplateThinking: false}),
        secrets: {'ai-default': 'local'}
    })
    assert.equal(plain.compat.thinkingFormat, undefined)
    assert.equal(plain.compat.chatTemplateKwargs, undefined)
})

test('the on level reaches a chat-template server as thinking enabled', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: false,
                    thinkingLevel: 'on'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const {body} = mock.request()
        assert.equal(body.chat_template_kwargs?.enable_thinking, true)
        assert.equal(body.chat_template_kwargs?.preserve_thinking, true)
        assert.equal('reasoning_effort' in body.chat_template_kwargs, false)
    } finally {
        mock.server.close()
    }
})

test('the off level reaches a chat-template server as thinking disabled', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: false,
                    thinkingLevel: 'off'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(mock.request().body.chat_template_kwargs?.enable_thinking, false)
    } finally {
        mock.server.close()
    }
})

test('a stored off never disables reasoning on a model that requires it', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    reasoningMandatory: true,
                    thinkingLevels: ['max', 'high', 'low'],
                    thinkingLevel: 'off'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const {body} = mock.request()
        assert.notEqual(body.reasoning_effort, 'none')
        assert.notEqual(body.reasoning?.enabled, false)
        assert.equal(body.reasoning_effort, 'low')
    } finally {
        mock.server.close()
    }
})

test('a stored off still disables reasoning where off is allowed', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    reasoningMandatory: false,
                    thinkingLevels: ['max', 'high', 'low'],
                    thinkingLevel: 'off'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.notEqual(mock.request().body.reasoning_effort, 'low')
    } finally {
        mock.server.close()
    }
})

test('a named effort reaches a chat-template server unchanged', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    thinkingLevel: 'medium'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const {body} = mock.request()
        assert.equal(body.chat_template_kwargs?.enable_thinking, true)
        assert.equal(body.chat_template_kwargs?.reasoning_effort, 'medium')
    } finally {
        mock.server.close()
    }
})

test('a level the server named is sent under that name, not the nearest one', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    thinkingLevels: ['low', 'medium', 'xhigh'],
                    thinkingLevel: 'xhigh'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        assert.equal(mock.request().body.chat_template_kwargs?.reasoning_effort, 'xhigh')
    } finally {
        mock.server.close()
    }
})

test('a level the server did not name is never what a request settles on', async context => {
    const mock = startServer()
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    await new Promise(resolve => mock.server.listen(0, '127.0.0.1', resolve))
    const {port} = mock.server.address()

    try {
        await runAgent({
            settings: servedBy(`http://127.0.0.1:${String(port)}/v1`, {
                connection: {chatTemplateThinking: true},
                model: {
                    reasoning: true,
                    supportsReasoningEffort: true,
                    thinkingLevels: ['low', 'medium', 'xhigh'],
                    thinkingLevel: 'high'
                }
            }),
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => undefined
        })

        const sent = mock.request().body.chat_template_kwargs?.reasoning_effort
        assert.ok(
            sent === undefined || ['low', 'medium', 'xhigh'].includes(sent),
            `sent an effort the template would raise on: ${String(sent)}`
        )
    } finally {
        mock.server.close()
    }
})

test('a length stop names which limit it was, and what the conversation really held', () => {
    const model = {contextWindow: 120064, maxTokens: 16384}

    const ceiling = outOfRoom({usage: {input: 1000, cacheRead: 34960, output: 16384}}, model)
    assert.match(ceiling, /whole response limit/u)
    assert.match(ceiling, /84,104 of its 120,064-token context window still free/u)
    assert.match(ceiling, /a larger context window would not change it/u)
    assert.doesNotMatch(ceiling, /no longer leaves room/u)

    const crowded = outOfRoom({usage: {input: 900, cacheRead: 118000, output: 40}}, model)
    assert.match(crowded, /no longer leaves room/u)
    assert.match(crowded, /filled 118,900 of the model's 120,064-token/u)
    assert.match(crowded, /larger context window/u)
})

test('what a turn re-sends is what the last turn sent, byte for byte', async context => {
    const mock = startScriptedServer([{text: 'One'}, {text: 'Two'}, {text: 'Three'}])
    const url = await baseUrl(context, mock.server)
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const derived = turn => ({
        memoryContext: `Turn ${String(turn)} remembered something else entirely.`,
        sessionContext: `Editor session: ready. Godot 4.7.${String(turn)}.`,
        inventory: `The project's tracked files:\n${'scripts/player.gd\n'.repeat(turn)}`
    })

    let agentMessages = []
    const messages = []
    for (const turn of [1, 2, 3]) {
        messages.push({sender: 'user', text: `Ask number ${String(turn)}`, timestamp: turn})
        await runAgent({
            settings: servedBy(url),
            systemPrompt: 'Be brief.',
            tools: catalog,
            host: {call: () => Promise.resolve({})},
            messages: [...messages],
            agentMessages,
            sessionId: 'one-task',
            workspacePath: workspace.path,
            emit: event => {
                if (event.type === 'turn-state') agentMessages = event.agentMessages
            },
            ...derived(turn)
        })
        messages.push({sender: 'assistant', text: 'ok', timestamp: turn})
    }

    assert.equal(mock.bodies.length, 3, 'three turns, three requests')

    const divergence = (before, after) => {
        const at = [...before].findIndex((part, index) => part !== after[index])
        if (at < 0) return undefined
        return {
            at,
            before: JSON.stringify(before[at]).slice(0, 200),
            after: JSON.stringify(after[at]).slice(0, 200)
        }
    }

    for (const [earlier, later, shared] of [
        [mock.bodies[0], mock.bodies[1], 1],
        [mock.bodies[1], mock.bodies[2], 3]
    ]) {
        assert.equal(
            JSON.stringify(later.tools),
            JSON.stringify(earlier.tools),
            'the tool schemas have to be the same bytes every turn'
        )

        assert.equal(
            later.messages[0].content,
            earlier.messages[0].content,
            'the system message has to be the same bytes every turn'
        )

        assert.equal(
            earlier.messages.length,
            shared + 1,
            'the earlier request is the shared run plus the prompt this turn hung its context on'
        )
        const before = earlier.messages.slice(0, shared).map(message => JSON.stringify(message))
        const after = later.messages.slice(0, shared).map(message => JSON.stringify(message))
        assert.deepEqual(
            divergence(before, after),
            undefined,
            `the first ${String(shared)} messages have to be the same bytes every turn`
        )
    }

    const asked = mock.bodies[2].messages.at(-1).content
    assert.ok(asked.startsWith('Ask number 3'), 'the user still asks first')
    assert.ok(asked.includes('Turn 3 remembered something else entirely.'), 'memory still arrives')
    assert.ok(asked.includes('Godot 4.7.3'), 'the session line still arrives')
    assert.ok(asked.includes('scripts/player.gd'), 'the file listing still arrives')
})

test('a retry still recognises its own prompt, whatever this turn remembered', async context => {
    const mock = startScriptedServer([{text: 'Carrying on'}])
    const url = await baseUrl(context, mock.server)
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const crashed = [
        {role: 'user', content: 'Build the level', timestamp: 10},
        {
            role: 'assistant',
            content: [{type: 'text', text: 'Starting on it'}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: 11
        }
    ]

    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: 'Build the level', timestamp: 10}],
        agentMessages: crashed,
        isRetry: true,
        tools: catalog,
        host: {call: () => Promise.resolve({})},
        memoryContext: 'Something the last attempt never saw.',
        sessionContext: 'Editor session: ready. Godot 4.7.2.',
        workspacePath: workspace.path,
        emit: () => undefined
    })

    const sent = mock.bodies[0].messages
    assert.equal(
        sent.filter(message => JSON.stringify(message).includes('Build the level')).length,
        1,
        'the retry carried on rather than asking the prompt a second time'
    )
    const asked = sent.find(message => JSON.stringify(message).includes('Build the level'))
    assert.ok(String(asked.content).includes('Something the last attempt never saw.'))
})

test('a red verify report does not move this turn’s context off the prompt', async context => {
    const mock = startScriptedServer([{text: 'Hello'}, {text: 'Fixed it'}])
    const url = await baseUrl(context, mock.server)
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const spec = 'GOAL\nA thing.\n\nVERIFY\n```sh\n# it is registered\nsh -c "exit 1"\n```\n'
    await runAgent({
        settings: servedBy(url),
        messages: [{sender: 'user', text: spec, images: [], timestamp: 1}],
        memoryContext: 'The player is a cat.',
        workspacePath: workspace.path,
        emit: () => undefined
    })

    assert.equal(mock.bodies.length, 2, 'the red report was asked as a second request')
    const [asked, reasked] = mock.bodies
    const prompt = body => body.messages.find(message => String(message.content).includes('GOAL'))

    assert.equal(
        JSON.stringify(prompt(reasked)),
        JSON.stringify(prompt(asked)),
        'the prompt has to be the same bytes in both requests'
    )
    assert.ok(String(prompt(asked).content).includes('The player is a cat.'))
    assert.ok(!String(reasked.messages.at(-1).content).includes('The player is a cat.'))
})

test('a turn runs against a canned world, with no server behind it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const events = []
    const model = {id: MODEL_ID, api: 'openai-completions', provider: 'local'}

    const completion = await runAgent({
        settings: servedBy('http://127.0.0.1:1/v1'),
        messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
        workspacePath: workspace.path,
        emit: event => events.push(event),
        world: {
            createModelContext: () => ({
                isChatGpt: false,
                models: cannedModels(model, 'Hello from nowhere'),
                model,
                subagent: {model, thinkingLevel: 'off'},
                streamOptions: {}
            })
        }
    })

    assert.equal(completion.text, 'Hello from nowhere')
    assert.equal(completion.stopReason, 'stop')
    assert.ok(
        events.some(event => event.type === 'done'),
        `a finished turn emits done: ${JSON.stringify(events.map(one => one.type))}`
    )
})

test('a turn with no world given reaches the live one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    await assert.rejects(
        runAgent({
            settings: {...servedBy('http://127.0.0.1:1/v1'), connections: {}},
            messages: [{sender: 'user', text: 'Say hello', timestamp: 1}],
            workspacePath: workspace.path,
            emit: () => {}
        }),
        /The selected model .* is unavailable/
    )
})

test('a driver this build has no provider for is refused by name', () => {
    const profile = {
        name: 'Somewhere',
        baseUrl: 'https://example.invalid/v1',
        api: 'openai-completions',
        chatTemplateThinking: false,
        model: {
            id: 'some-model',
            name: 'Some model',
            contextWindow: 128_000,
            maxTokens: 8_000,
            reasoning: false,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text'],
            thinkingLevel: 'off'
        }
    }
    assert.throws(
        () =>
            createModelContext({
                settings: {connectionType: 'anthropic', connections: {anthropic: profile}},
                secrets: {'ai-default': 'local'}
            }),
        /No pi-ai provider is registered for the 'anthropic' connection/u
    )
})

test('every driver but ChatGPT has a pi-ai provider registered for it', () => {
    assert.deepEqual([...DRIVERS].sort(), [
        'cerebras',
        'openai-codex',
        'openai-compatible',
        'openrouter'
    ])
    for (const driver of DRIVERS) {
        if (driver === 'openai-codex') continue
        let said = ''
        try {
            createModelContext({settings: {connectionType: driver, connections: {}}})
        } catch (refusal) {
            said = refusal.message
        }
        assert.ok(
            !said.includes('No pi-ai provider is registered'),
            `${driver} has no provider registered: ${said}`
        )
    }
})

test('a sub-agent driver this build has no provider for is refused by name', () => {
    const connection = {
        name: 'Local AI',
        baseUrl: 'http://127.0.0.1:8080/v1',
        api: 'openai-completions',
        chatTemplateThinking: false,
        model: {
            id: 'a-model',
            name: 'A model',
            contextWindow: 128_000,
            maxTokens: 8_000,
            reasoning: false,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text'],
            thinkingLevel: 'off'
        }
    }
    assert.throws(
        () =>
            createModelContext({
                settings: {
                    connectionType: 'openai-compatible',
                    connections: {'openai-compatible': connection},
                    subagent: {connection: {connectionType: 'anthropic', model: {id: 'a-model'}}}
                },
                secrets: {'ai-default': 'local'}
            }),
        /No pi-ai provider is registered for the 'anthropic' connection/u
    )
})

test('every hosted driver the catalogue declares has a key that reaches it', () => {
    const profile = name => ({
        name,
        baseUrl: 'https://example.invalid/v1',
        api: 'openai-completions',
        chatTemplateThinking: false,
        model: {
            id: 'a-model',
            name: 'A model',
            contextWindow: 128_000,
            maxTokens: 8_000,
            reasoning: false,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text'],
            thinkingLevel: 'off'
        }
    })
    const hosted = DRIVERS.filter(
        driver => driver !== 'openai-compatible' && driver !== 'openai-codex'
    )
    assert.ok(hosted.length > 0, 'the catalogue declares no hosted driver')
    for (const driver of hosted) {
        assert.doesNotThrow(
            () =>
                createModelContext({
                    settings: {connectionType: driver, connections: {[driver]: profile(driver)}},
                    secrets: Object.fromEntries(
                        Object.values(DRIVER_SECRETS).map(slot => [slot, 'k'])
                    )
                }),
            `${driver} is declared but no key reaches it`
        )
    }
})

test('a provider is sent the key of its own slot, whichever seat pointed at it', async () => {
    const profile = name => ({
        name,
        baseUrl: 'https://example.invalid/v1',
        api: 'openai-completions',
        chatTemplateThinking: false,
        model: {
            id: 'a-model',
            name: 'A model',
            contextWindow: 128_000,
            maxTokens: 8_000,
            reasoning: false,
            supportsReasoningEffort: false,
            thinkingLevels: [],
            input: ['text'],
            thinkingLevel: 'off'
        }
    })
    // The parent is hosted and only the sub-agent is local, which is the arrangement that used to
    // put the hosted key on the address the user typed into Base URL.
    const {models} = createModelContext({
        settings: {
            connectionType: 'openrouter',
            connections: {
                'openai-compatible': profile('Local AI'),
                openrouter: profile('OpenRouter')
            },
            subagent: {connection: {connectionType: 'openai-compatible', model: {id: 'a-model'}}}
        },
        secrets: {'ai-default': 'local-key', openrouter: 'hosted-key'}
    })
    const catalogue = JSON.parse(await readFile('protocol/drivers.json', 'utf8'))
    const stored = {'ai-default': 'local-key', openrouter: 'hosted-key'}
    let checked = 0
    for (const {id, providerId} of catalogue.drivers) {
        const provider = providerId && models.getProvider(providerId)
        if (!provider?.auth?.apiKey) continue
        const resolved = await provider.auth.apiKey.resolve()
        assert.equal(
            resolved.auth.apiKey,
            stored[DRIVER_SECRETS[id]],
            `the ${id} provider must be sent the key stored in its own slot`
        )
        checked += 1
    }
    assert.equal(checked, 2, 'both seats registered a provider to check')
})
