import {createServer} from 'node:http'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

export const MODEL_ID = 'Qwen3.6-27B-UD-Q4_K_XL.gguf'

export const settings = {
    connectionType: 'local',
    connections: {
        local: {
            name: 'Local AI',
            baseUrl: '',
            api: 'openai-completions',
            chatTemplateThinking: false,
            model: {id: MODEL_ID}
        }
    }
}

export function servedBy(baseUrl, {model = {}, connection = {}, ...tuning} = {}) {
    const live = settings.connections['local']
    return {
        ...settings,
        ...tuning,
        connections: {
            local: {...live, ...connection, baseUrl, model: {...live.model, ...model}}
        }
    }
}

export async function temporaryWorkspace(files = {}, outsideFiles = {}) {
    const root = await mkdtemp(join(tmpdir(), 'gofer-worker-'))
    const path = join(root, 'workspace')
    await mkdir(path)
    for (const [name, contents] of Object.entries(files))
        await writeFile(join(path, name), contents)
    for (const [name, contents] of Object.entries(outsideFiles))
        await writeFile(join(root, name), contents)
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

export function startServer() {
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
                    model: MODEL_ID,
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
                    model: MODEL_ID,
                    choices: [{index: 0, delta: {content: ' Gofer'}, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
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

export const catalog = [
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
    {
        name: 'godot_docs_search',
        description: 'The Godot documentation on this machine.',
        operations: [{op: 'search', summary: 'Retrieves ranked passages: {question}.'}]
    }
]

export function isProbe(call) {
    return call.params?.probe === true
}

export function probeResult(call) {
    return {type: 'tool-result', id: call.id, ok: true, result: {tool: call.tool, reachable: true}}
}

export function withoutProbes(calls) {
    return calls.filter(call => !isProbe(call))
}

export function startToolCallingServer(tool, args) {
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
                    model: MODEL_ID,
                    choices: [{index: 0, delta, finish_reason: null}]
                })}\n\n`
            )
            response.write(
                `data: ${JSON.stringify({
                    id: 'chatcmpl-tool',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: MODEL_ID,
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

export function startScriptedServer(turns) {
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
                    JSON.stringify(
                        script.error.body ?? {
                            error: {message: script.error.message, type: 'invalid_request_error'}
                        }
                    )
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
                : script.reasoning !== undefined ?
                    {role: 'assistant', reasoning: script.reasoning, content: script.text ?? ''}
                :   {role: 'assistant', content: script.text ?? 'Done'}
            const frame = choices => ({
                id: `chatcmpl-${String(turn)}`,
                object: 'chat.completion.chunk',
                created: 1,
                model: MODEL_ID,
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

export async function baseUrl(context, server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => server.close())
    return `http://127.0.0.1:${String(server.address().port)}/v1`
}

export const NO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
}

export function longConversation(pairs, characters) {
    const messages = []
    for (let index = 0; index < pairs; index += 1) {
        messages.push({role: 'user', content: 'u'.repeat(characters), timestamp: index * 2 + 1})
        messages.push({
            role: 'assistant',
            content: [{type: 'text', text: 'a'.repeat(characters)}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: index * 2 + 2
        })
    }
    return messages
}

export function toolStep(marker, at) {
    return [
        {
            role: 'assistant',
            content: [
                {type: 'text', text: `Working on ${marker}`},
                {type: 'toolCall', id: `call-${marker}`, name: 'bash', arguments: {command: 'ls'}}
            ],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
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

export function settledTurn(prompt, answer, at) {
    return [
        {role: 'user', content: prompt, timestamp: at},
        {
            role: 'assistant',
            content: [{type: 'text', text: answer}],
            api: 'openai-completions',
            provider: 'local',
            model: MODEL_ID,
            usage: NO_USAGE,
            stopReason: 'stop',
            timestamp: at + 1
        }
    ]
}

export const impatient = {maxRetries: 0}

export function instantTimers() {
    const waited = []
    return {
        waited,
        now: () => Date.now(),
        schedule(fn, ms) {
            waited.push(ms)
            queueMicrotask(fn)
            return waited.length
        },
        cancel: () => undefined,
        repeat: (fn, ms) => setInterval(fn, ms),
        stopRepeat: handle => {
            clearInterval(handle)
        }
    }
}

export const SMALL_MODEL = {
    connectionType: 'local',
    model: {
        id: 'small.gguf',
        name: 'Small',
        contextWindow: 8192,
        maxTokens: 4096,
        reasoning: false,
        supportsReasoningEffort: false,
        input: ['text'],
        thinkingLevel: 'off'
    }
}
