import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {probeTools} from './ai-reachability.mjs'
import {
    CHILD_TOOL_NAMES,
    SUBAGENT_BOUNDS,
    SUBAGENT_SETTINGS_DEFAULTS,
    SUBAGENT_TOOL_NAMES,
    assertChildTools,
    boundsFrom,
    createChildTools,
    createProgressReport,
    createSilenceClock,
    createSubagentTool,
    noProgress,
    runSubagent,
    runSubagentOutcome,
    subagentFailure
} from './ai-subagent.mjs'
import {toolStepLine} from './tool-target.mjs'

const model = {
    id: 'Qwen3.6-27B-UD-Q4_K_XL.gguf',
    name: 'Local AI',
    api: 'openai-completions',
    provider: 'local',
    contextWindow: 120_064
}

async function temporaryWorkspace(files = {}) {
    const root = await mkdtemp(join(tmpdir(), 'gofer-subagent-'))
    const path = join(root, 'workspace')
    await mkdir(path)
    for (const [name, contents] of Object.entries(files))
        await writeFile(join(path, name), contents)
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

function usage(tokens) {
    return {
        input: tokens,
        output: tokens,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens * 2,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
    }
}

function scriptedModels(script) {
    const contexts = []
    let turn = 0
    return {
        contexts,
        get turns() {
            return turn
        },
        streamSimple: (requested, context) => {
            contexts.push(context)
            const step = script[Math.min(turn, script.length - 1)]
            turn += 1
            const calls = step.calls ?? []
            const message = {
                role: 'assistant',
                content: [
                    ...(step.text ? [{type: 'text', text: step.text}] : []),
                    ...calls.map((call, index) => ({
                        type: 'toolCall',
                        id: `call-${String(turn)}-${String(index)}`,
                        name: call.name,
                        arguments: call.args
                    }))
                ],
                api: requested.api,
                provider: requested.provider,
                model: requested.id,
                usage: usage(step.tokens ?? 1),
                stopReason: calls.length > 0 ? 'toolUse' : 'stop',
                timestamp: Date.now()
            }
            const stream = createAssistantMessageEventStream()
            queueMicrotask(() => {
                stream.push({
                    type: 'done',
                    reason: calls.length > 0 ? 'toolUse' : 'stop',
                    message
                })
                stream.end(message)
            })
            return stream
        }
    }
}

function streamingModels(beginnings) {
    return {
        turns: 0,
        streamSimple: requested => {
            const message = {
                role: 'assistant',
                content: [{type: 'text', text: 'Done.'}],
                api: requested.api,
                provider: requested.provider,
                model: requested.id,
                usage: usage(1),
                stopReason: 'stop',
                timestamp: Date.now()
            }
            const stream = createAssistantMessageEventStream()
            queueMicrotask(() => {
                stream.push({type: 'start', partial: message})
                for (const [index, type] of beginnings.entries())
                    stream.push({type, contentIndex: index, partial: message})
                stream.push({type: 'done', reason: 'stop', message})
                stream.end(message)
            })
            return stream
        }
    }
}

function hangingModels() {
    let started
    const first = new Promise(resolve => {
        started = resolve
    })
    return {
        first,
        streamSimple: (requested, _context, options) => {
            const stream = createAssistantMessageEventStream()
            const message = {
                role: 'assistant',
                content: [],
                api: requested.api,
                provider: requested.provider,
                model: requested.id,
                usage: usage(0),
                stopReason: 'aborted',
                errorMessage: 'The request was aborted',
                timestamp: Date.now()
            }
            options.signal?.addEventListener(
                'abort',
                () => {
                    stream.push({type: 'error', reason: 'aborted', error: message})
                    stream.end(message)
                },
                {once: true}
            )
            started()
            return stream
        }
    }
}

test('the sub-agent holds read and bash, and is refused anything else', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const {env, tools} = createChildTools(workspace.path)
    context.after(() => env.cleanup())
    assert.deepEqual(
        tools.map(tool => tool.name),
        SUBAGENT_TOOL_NAMES
    )
    assert.deepEqual(SUBAGENT_TOOL_NAMES, ['read', 'bash'])

    assert.throws(
        () => assertChildTools([{name: 'read'}, {name: 'write'}, {name: 'edit'}]),
        /must not have: write, edit/u
    )
    assert.throws(
        () => assertChildTools([{name: 'bash'}, {name: 'godot_scene'}]),
        /must not have: godot_scene/u
    )
})

test('widening what a child MAY hold does not widen what the subagent tool DOES hold', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    assert.ok(CHILD_TOOL_NAMES.includes('web_search'))
    assert.ok(CHILD_TOOL_NAMES.includes('godot_docs_search'))
    assert.ok(!SUBAGENT_TOOL_NAMES.includes('web_search'))

    const {env, tools} = createChildTools(workspace.path)
    context.after(() => env.cleanup())
    assert.deepEqual(
        tools.map(tool => tool.name),
        ['read', 'bash']
    )

    assert.ok(!CHILD_TOOL_NAMES.includes('web_fetch'))
    assert.throws(() => assertChildTools([], ['web_fetch']), /asked for web_fetch/u)
})

test('a reaching tool asked for without what answers it is refused by name', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    assert.throws(
        () => createChildTools(workspace.path, {toolNames: ['godot_docs_search']}),
        /without the tool host that answers it/u
    )
    assert.throws(
        () =>
            createChildTools(workspace.path, {
                toolNames: ['godot_docs_search'],
                deps: {host: {call: async () => ({})}, domains: []}
            }),
        /did not offer that domain/u
    )
})

test('a child given search gets a search that is not confined to the worktree', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const {env, tools} = createChildTools(workspace.path, {
        toolNames: ['web_search'],
        deps: {searchProvider: 'exa'}
    })
    context.after(() => env.cleanup())
    assert.deepEqual(
        tools.map(tool => tool.name),
        ['web_search']
    )

    const probed = await tools[0].execute('call-1', {probe: true})
    assert.match(probed.content[0].text, /reachable/u)
})

test('the recursion guard refuses a sub-agent that could delegate again', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    assert.throws(() => assertChildTools([{name: 'read'}, {name: 'subagent'}]), /must not have/u)
    assert.throws(() => assertChildTools([{name: 'subagent'}]), /must not delegate again/u)

    const {env, tools} = createChildTools(workspace.path)
    context.after(() => env.cleanup())
    assert.equal(
        tools.find(tool => tool.name === 'subagent'),
        undefined
    )
})

test('a caller may narrow a child to no tools at all, and gets a child that has none', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const {env, tools} = createChildTools(workspace.path, {toolNames: []})
    context.after(() => env.cleanup())
    assert.deepEqual(tools, [])

    assert.throws(() => assertChildTools([{name: 'read'}], []), /must not have: read/u)
    assert.throws(() => assertChildTools([{name: 'read'}], []), /may hold no tools at all/u)
})

test('a caller cannot widen a child, only narrow one', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    assert.throws(() => assertChildTools([], ['read', 'write']), /asked for write/u)
    assert.throws(() => assertChildTools([], ['subagent']), /editing CHILD_TOOL_NAMES/u)
    assert.throws(
        () => createChildTools(workspace.path, {toolNames: ['read', 'godot_scene']}),
        /asked for godot_scene/u
    )
})

test('a child answers under the system prompt its caller gave it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{text: 'The page says the flag is --strict.'}])

    const result = await runSubagent({
        progress: noProgress,
        prompt: 'What flag does the page name?',
        systemPrompt: 'You extract one fact from the page below and quote it.',
        toolNames: [],
        workspacePath: workspace.path,
        models,
        model
    })

    assert.match(result.text, /--strict/u)
    assert.equal(
        models.contexts[0].systemPrompt,
        'You extract one fact from the page below and quote it.'
    )
    assert.equal(models.turns, 1)
})

test('a sub-agent that reaches for write, edit or the editor changes nothing', async context => {
    const workspace = await temporaryWorkspace({'level.gd': 'extends Node\n'})
    context.after(workspace.remove)
    const models = scriptedModels([
        {
            calls: [
                {name: 'write', args: {path: 'sneaked.gd', content: 'extends Node'}},
                {name: 'edit', args: {path: 'level.gd', edits: []}},
                {name: 'godot_scene', args: {op: 'save'}}
            ]
        },
        {text: 'level.gd extends Node and is not changed by me.'}
    ])

    const result = await runSubagent({
        progress: noProgress,
        prompt: 'What does level.gd extend?',
        workspacePath: workspace.path,
        models,
        model
    })

    assert.match(result.text, /extends Node/u)
    assert.deepEqual(await readdir(workspace.path), ['level.gd'])
    const secondRequest = models.contexts[1].messages
    assert.equal(secondRequest.filter(message => message.role === 'toolResult').length, 3)
})

test('the parent turn stopping stops the sub-agent with it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = hangingModels()
    const controller = new AbortController()

    const running = runSubagent({
        progress: noProgress,
        prompt: 'Trace where the player speed is set.',
        workspacePath: workspace.path,
        models,
        model,
        signal: controller.signal
    })
    await models.first
    controller.abort()

    await assert.rejects(running, /The sub-agent did not answer: the turn was stopped/u)
})

test('a turn already stopped never starts a sub-agent at all', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{text: 'this must never be asked'}])

    await assert.rejects(
        runSubagent({
            progress: noProgress,
            prompt: 'Anything.',
            workspacePath: workspace.path,
            models,
            model,
            signal: AbortSignal.abort()
        }),
        /the turn was stopped/u
    )
    assert.equal(models.turns, 0)
})

test('a stop and a failure are different endings, not one message', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const stopped = await runSubagentOutcome({
        progress: noProgress,
        prompt: 'Anything.',
        workspacePath: workspace.path,
        models: scriptedModels([{text: 'this must never be asked'}]),
        model,
        signal: AbortSignal.abort()
    })
    assert.equal(stopped.kind, 'stopped')

    const empty = await runSubagentOutcome({
        progress: noProgress,
        prompt: 'Anything.',
        workspacePath: workspace.path,
        models: scriptedModels([{text: '   '}]),
        model
    })
    assert.equal(empty.kind, 'failed')
    assert.equal(empty.cause, 'no-answer')
})

test('each ending names its cause as a tag', async context => {
    const workspace = await temporaryWorkspace({'a.gd': 'extends Node\n'})
    context.after(workspace.remove)

    const overran = await runSubagentOutcome({
        progress: noProgress,
        prompt: 'Where is the speed set?',
        workspacePath: workspace.path,
        models: scriptedModels([{calls: [{name: 'read', args: {path: 'a.gd'}}]}]),
        model,
        settings: {...SUBAGENT_SETTINGS_DEFAULTS, maxTurns: 3, retryAttempts: 0}
    })
    assert.equal(overran.kind, 'failed')
    assert.equal(overran.cause, 'step-ceiling')
    assert.match(overran.reason, /used all 3 of its steps/u)
})

test('a delegation is asked about the pictures it was given', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{text: 'the menu is off centre'}])

    const outcome = await runSubagentOutcome({
        progress: noProgress,
        prompt: 'What is wrong with this screen?',
        images: [{type: 'image', data: 'aGk=', mimeType: 'image/png'}],
        workspacePath: workspace.path,
        models,
        model: {...model, input: ['text', 'image']}
    })

    assert.equal(outcome.kind, 'ok')
    const asked = models.contexts[0].messages.at(-1)
    assert.deepEqual(asked.content, [
        {type: 'text', text: 'What is wrong with this screen?'},
        {type: 'image', data: 'aGk=', mimeType: 'image/png'}
    ])
})

test('a child that cannot read pictures is sent none', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{text: 'the menu is off centre'}])

    const outcome = await runSubagentOutcome({
        progress: noProgress,
        prompt: 'What is wrong with this screen?',
        images: [{type: 'image', data: 'aGk=', mimeType: 'image/png'}],
        workspacePath: workspace.path,
        models,
        model
    })

    assert.equal(outcome.kind, 'ok')
    assert.deepEqual(models.contexts[0].messages.at(-1).content, [
        {type: 'text', text: 'What is wrong with this screen?'}
    ])
})

test('an answered delegation still reports what it cost', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const outcome = await runSubagentOutcome({
        progress: noProgress,
        prompt: 'Anything.',
        workspacePath: workspace.path,
        models: scriptedModels([{text: 'the answer'}]),
        model
    })
    assert.equal(outcome.kind, 'ok')
    assert.equal(outcome.text, 'the answer')
    assert.equal(outcome.turns, 1)
})

test('a sub-agent that never stops reading is stopped for it', async context => {
    const workspace = await temporaryWorkspace({'a.gd': 'extends Node\n'})
    context.after(workspace.remove)
    const models = scriptedModels([{calls: [{name: 'read', args: {path: 'a.gd'}}]}])

    await assert.rejects(
        runSubagent({
            progress: noProgress,
            prompt: 'Where is the speed set?',
            workspacePath: workspace.path,
            models,
            model,
            settings: {...SUBAGENT_SETTINGS_DEFAULTS, maxTurns: 3, retryAttempts: 0}
        }),
        /used all 3 of its steps without reaching an answer/u
    )
    assert.equal(models.turns, 3)
})

test('a loop closed by its caller does not fail for having no answer left to write', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{calls: [{name: 'read', args: {path: 'a.gd'}}]}])

    const result = await runSubagent({
        progress: noProgress,
        prompt: 'Draw the pause menu.',
        workspacePath: workspace.path,
        models,
        model,
        stopWhen: () => true
    })

    assert.equal(result.text, '')
    assert.equal(models.turns, 1)
})

test('every way a sub-agent can fail says the same thing about the reading', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    const noAnswer = scriptedModels([{text: '   '}])
    await assert.rejects(
        runSubagent({
            progress: noProgress,
            prompt: 'Anything.',
            workspacePath: workspace.path,
            models: noAnswer,
            model
        }),
        error => {
            assert.equal(error.message, subagentFailure('it finished without writing an answer'))
            assert.match(error.message, /Nothing it read reached this conversation/u)
            return true
        }
    )

    const tool = createSubagentTool({workspacePath: workspace.path, models: noAnswer, model})
    await assert.rejects(tool.execute('call-1', {prompt: '  '}), error => {
        assert.equal(error.message, subagentFailure('it was given no question to answer'))
        return true
    })
})

test('an answer that is not distilled is cut and said to be cut', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{text: 'x'.repeat(20_000)}])

    const result = await runSubagent({
        progress: noProgress,
        prompt: 'Summarise the log.',
        workspacePath: workspace.path,
        models,
        model
    })

    assert.ok(result.text.length < 20_000)
    assert.match(result.text, /\[cut here: the sub-agent's answer was 20,?000 characters/u)
})

test('what the delegation cost is reported where it was spent', async context => {
    const workspace = await temporaryWorkspace({'a.gd': 'extends Node\n'})
    context.after(workspace.remove)
    const models = scriptedModels([
        {calls: [{name: 'read', args: {path: 'a.gd'}}], tokens: 100},
        {calls: [{name: 'bash', args: {command: 'ls'}}], tokens: 200},
        {text: 'a.gd extends Node.', tokens: 300}
    ])
    const tool = createSubagentTool({workspacePath: workspace.path, models, model})
    const updates = []

    const result = await tool.execute('call-1', {prompt: 'What does a.gd extend?'}, undefined, u =>
        updates.push(u)
    )
    const text = result.content[0].text

    assert.match(text, /\[sub-agent: Local AI, 3 steps, 600 tokens in, 600 out\]/u)
    assert.equal(result.details.turns, 3)
    assert.equal(result.details.usage.totalTokens, 1200)

    assert.equal(updates.length, 2)
    assert.match(updates[0].content[0].text, /Working — 1 step so far:\nread: a\.gd/u)
    assert.match(updates[1].content[0].text, /bash: ls/u)
    assert.doesNotMatch(updates[1].content[0].text, /extends Node/u)

    assert.equal(updates[0].details.step, 'read: a.gd')
    assert.equal(updates[1].details.step, 'bash: ls')
    assert.equal(updates[1].details.steps, 2)
})

test('a delegation must say where its progress goes', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{text: 'never asked'}])

    await assert.rejects(
        runSubagent({prompt: 'Anything.', workspacePath: workspace.path, models, model}),
        /without saying where its progress goes/u
    )
    assert.equal(models.turns, 0)
})

test('a child reports the silence between its tool calls, not only the calls', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = streamingModels(['thinking_start', 'text_start'])
    const lines = []

    await runSubagent({
        prompt: 'Answer from what you were given.',
        toolNames: [],
        workspacePath: workspace.path,
        models,
        model,
        progress: status => lines.push(status.line)
    })

    assert.deepEqual(lines, ['thinking…', 'writing the answer…'])
})

test('the step list keeps the tool calls, and never the words between them', () => {
    const report = createProgressReport({max: 2})

    report.step('bash', {command: 'rg -n  "Main"\n  --hidden'})
    report.say('thinking…')
    report.step('read', {path: 'a.gd'})
    const status = report.step('web_search', {query: 'godot 4 signal'})

    assert.deepEqual(status.steps, ['read: a.gd', 'web_search: godot 4 signal'])
    assert.equal(status.count, 3)
    assert.equal(status.line, 'web_search: godot 4 signal')
})

test('every tool a child may hold is named, not just the two that were', () => {
    const ARGS = {
        read: {path: 'a.gd'},
        bash: {command: 'ls'},
        godot_docs_search: {ops: [{op: 'ask'}]},
        web_search: {query: 'godot 4 signals'},
        ask_user: {
            question: 'which menu?',
            sketches: [{label: 'Bar across the top', html: '<p>'}]
        }
    }
    for (const name of CHILD_TOOL_NAMES) {
        const line = toolStepLine(name, ARGS[name])
        assert.notEqual(line, name, `${name} named nothing`)
        assert.doesNotMatch(line, /undefined/u)
    }
})

test('the sub-agent proves itself before the turn, without a model call', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([{text: 'this must never be asked'}])
    const tool = createSubagentTool({workspacePath: workspace.path, models, model})

    await probeTools({tools: [tool], workspacePath: workspace.path})

    assert.equal(models.turns, 0)
    assert.deepEqual(await readdir(workspace.path), [])
})

test('a sub-agent that cannot answer stops the turn by name', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    await assert.rejects(
        probeTools({
            tools: [{name: 'subagent', execute: () => Promise.reject(new Error('no provider'))}],
            host: {call: () => Promise.reject(new Error('the backend must not be asked'))},
            workspacePath: workspace.path
        }),
        /- subagent: no provider/u
    )

    await assert.rejects(
        probeTools({
            tools: [
                {
                    name: 'subagent',
                    execute: () => Promise.resolve({content: [{type: 'text', text: 'ok'}]})
                }
            ],
            workspacePath: workspace.path
        }),
        /- subagent: it answered without the text the probe wrote/u
    )

    await assert.rejects(
        probeTools({
            tools: [{name: 'subagent', execute: () => new Promise(() => undefined)}],
            workspacePath: workspace.path,
            signal: AbortSignal.abort()
        }),
        /- subagent: the turn was stopped/u
    )
})

test('the sub-agent shell is confined to the worktree like the parent’s', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const models = scriptedModels([
        {calls: [{name: 'bash', args: {command: 'cat /etc/hostname'}}]},
        {text: 'I could not read outside the checkout.'}
    ])

    await runSubagent({
        progress: noProgress,
        prompt: 'What is the hostname?',
        workspacePath: workspace.path,
        models,
        model
    })

    const results = models.contexts[1].messages.filter(message => message.role === 'toolResult')
    assert.equal(results.length, 1)
    assert.match(
        results[0].content.map(part => part.text ?? '').join(''),
        /paths relative to the workspace/u
    )
})

function fakeTimers() {
    let now = 0
    let nextId = 0
    const pending = new Map()
    return {
        now: () => now,
        schedule(fn, ms) {
            const id = (nextId += 1)
            pending.set(id, {at: now + ms, fn})
            return id
        },
        cancel(handle) {
            pending.delete(handle)
        },
        repeat(fn, ms) {
            const id = (nextId += 1)
            pending.set(id, {at: now + ms, fn, repeatMs: ms})
            return id
        },
        stopRepeat(handle) {
            pending.delete(handle)
        },
        get armed() {
            return pending.size
        },
        async advance(ms) {
            now += ms
            for (const [id, entry] of [...pending]) {
                if (entry.at > now) continue
                if (entry.repeatMs === undefined) pending.delete(id)
                else entry.at = now + entry.repeatMs
                entry.fn()
            }
            await new Promise(resolve => setImmediate(resolve))
        }
    }
}

test('a tool call that never returns is cut off, and the sub-agent is told why', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const timers = fakeTimers()
    const {env, tools} = createChildTools(workspace.path, {
        bounds: {...SUBAGENT_BOUNDS, commandTimeoutMs: 60_000},
        timers
    })
    context.after(() => env.cleanup())

    const running = assert.rejects(
        tools.find(tool => tool.name === 'bash').execute('call-1', {command: 'sleep 600'}),
        error => {
            assert.match(error.message, /was stopped after 60 seconds and produced no result/u)
            assert.match(error.message, /Do not report it as finished/u)
            assert.match(error.message, /bash tool's own timeout parameter set, in seconds/u)
            return true
        }
    )
    await timers.advance(60_000)
    await running
})

test('a tool call inside its ceiling is left alone', async context => {
    const workspace = await temporaryWorkspace({'a.gd': 'extends Node\n'})
    context.after(workspace.remove)
    const timers = fakeTimers()
    const {env, tools} = createChildTools(workspace.path, {
        bounds: {...SUBAGENT_BOUNDS, commandTimeoutMs: 60_000},
        timers
    })
    context.after(() => env.cleanup())

    const result = await tools.find(tool => tool.name === 'read').execute('call-1', {path: 'a.gd'})

    assert.match(result.content.map(part => part.text ?? '').join(''), /extends Node/u)
    assert.equal(timers.armed, 0)
})

test('a ceiling of zero arms no clock at all', async context => {
    const workspace = await temporaryWorkspace({'a.gd': 'extends Node\n'})
    context.after(workspace.remove)
    const timers = fakeTimers()
    const {env, tools} = createChildTools(workspace.path, {
        bounds: {...SUBAGENT_BOUNDS, commandTimeoutMs: 0},
        timers
    })
    context.after(() => env.cleanup())

    const running = tools.find(tool => tool.name === 'read').execute('call-1', {path: 'a.gd'})
    assert.equal(timers.armed, 0)

    assert.match((await running).content[0].text, /extends Node/u)
})

test('a stream that goes silent is given up on, and worded so a retry sees it', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const timers = fakeTimers()
    const models = hangingModels()

    const running = runSubagent({
        progress: noProgress,
        prompt: 'Where is the speed set?',
        workspacePath: workspace.path,
        models,
        model,
        timers,
        settings: {...SUBAGENT_SETTINGS_DEFAULTS, streamInactivityMinutes: 2, retryAttempts: 0}
    })
    const stalled = assert.rejects(
        running,
        /the model sent nothing for 120 seconds and reported no error/u
    )
    await models.first
    await timers.advance(120_000)
    await stalled
})

test('the silence clock is paused by tools and stays paused until the last one ends', async () => {
    const timers = fakeTimers()
    let silentAfter
    const clock = createSilenceClock({
        timeoutMs: 60_000,
        timers,
        onSilent: ms => {
            silentAfter = ms
        }
    })
    clock.start()

    clock.suspend('fast')
    clock.suspend('slow')
    clock.resume('fast')
    await timers.advance(600_000)
    assert.equal(silentAfter, undefined)

    clock.resume('slow')
    await timers.advance(600_000)
    assert.equal(silentAfter, 60_000)

    clock.stop()
    assert.equal(timers.armed, 0)
})

test('a delegation that failed transiently is asked again, and one that will not is not', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)
    const timers = fakeTimers()
    let attempts = 0
    const flaky = {
        streamSimple: requested => {
            attempts += 1
            const failed = attempts === 1
            const message = {
                role: 'assistant',
                content: failed ? [] : [{type: 'text', text: 'a.gd extends Node.'}],
                api: requested.api,
                provider: requested.provider,
                model: requested.id,
                usage: usage(1),
                stopReason: failed ? 'error' : 'stop',
                ...(failed && {errorMessage: 'fetch failed'}),
                timestamp: Date.now()
            }
            const stream = createAssistantMessageEventStream()
            queueMicrotask(() => {
                stream.push(
                    failed ?
                        {type: 'error', reason: 'error', error: message}
                    :   {type: 'done', reason: 'stop', message}
                )
                stream.end(message)
            })
            return stream
        }
    }

    const running = runSubagent({
        progress: noProgress,
        prompt: 'What does a.gd extend?',
        workspacePath: workspace.path,
        models: flaky,
        model,
        timers,
        settings: {...SUBAGENT_SETTINGS_DEFAULTS, retryAttempts: 2, retryBaseDelaySeconds: 1}
    })
    await new Promise(resolve => setImmediate(resolve))
    await timers.advance(1_000)

    assert.match((await running).text, /extends Node/u)
    assert.equal(attempts, 2)

    const looping = scriptedModels([{calls: [{name: 'read', args: {path: 'a.gd'}}]}])
    await assert.rejects(
        runSubagent({
            progress: noProgress,
            prompt: 'Anything.',
            workspacePath: workspace.path,
            models: looping,
            model,
            timers,
            settings: {
                ...SUBAGENT_SETTINGS_DEFAULTS,
                maxTurns: 2,
                retryAttempts: 3,
                commandTimeoutMinutes: 0
            }
        }),
        /used all 2 of its steps/u
    )
    assert.equal(looping.turns, 2)
})

test('every bound comes from the settings, not from this file', async context => {
    const workspace = await temporaryWorkspace()
    context.after(workspace.remove)

    assert.deepEqual(Object.keys(SUBAGENT_SETTINGS_DEFAULTS).sort(), [
        'commandTimeoutMinutes',
        'maxAnswerChars',
        'maxTurns',
        'retryAttempts',
        'retryBaseDelaySeconds',
        'streamInactivityMinutes'
    ])

    assert.deepEqual(boundsFrom({commandTimeoutMinutes: 3, retryBaseDelaySeconds: 2}), {
        ...SUBAGENT_BOUNDS,
        commandTimeoutMs: 180_000,
        retryBaseDelayMs: 2_000
    })

    const chosen = await runSubagent({
        progress: noProgress,
        prompt: 'Summarise.',
        workspacePath: workspace.path,
        models: scriptedModels([{text: 'y'.repeat(500)}]),
        model,
        settings: {...SUBAGENT_SETTINGS_DEFAULTS, maxAnswerChars: 100}
    })
    assert.match(chosen.text, /\[cut here: the sub-agent's answer was 500 characters/u)

    const partial = await runSubagent({
        progress: noProgress,
        prompt: 'Summarise.',
        workspacePath: workspace.path,
        models: scriptedModels([{text: 'z'.repeat(20_000)}]),
        model,
        settings: {maxTurns: 4}
    })
    assert.match(partial.text, /\[cut here/u)
    assert.ok(partial.text.length < 20_000)
})

function rustDefaults(source) {
    const declarations = source.matchAll(
        /fn default_subagent_(?<field>\w+)\(\) -> u32 \{\s*(?<value>[\d_]+)\s*\}/gu
    )
    return Object.fromEntries(
        [...declarations].map(({groups}) => [
            groups.field.replaceAll(/_(?<letter>[a-z])/gu, (_, letter) => letter.toUpperCase()),
            Number(groups.value.replaceAll('_', ''))
        ])
    )
}

function typescriptDefaults(source) {
    const literal = /DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = \{(?<body>[^}]*)\}/u.exec(source)
    assert.ok(literal, 'DEFAULT_SUBAGENT_SETTINGS is no longer a plain object literal')
    const fields = literal.groups.body.matchAll(/(?<field>\w+): (?<value>[\d_]+)/gu)
    return Object.fromEntries(
        [...fields].map(({groups}) => [groups.field, Number(groups.value.replaceAll('_', ''))])
    )
}

test('the three copies of the shipped bounds say the same numbers', async () => {
    const scripts = dirname(fileURLToPath(import.meta.url))
    const [rust, typescript] = await Promise.all([
        readFile(join(scripts, '..', 'src-tauri', 'src', 'settings', 'mod.rs'), 'utf8'),
        readFile(join(scripts, '..', 'src', 'models', 'settings.ts'), 'utf8')
    ])

    assert.deepEqual(rustDefaults(rust), SUBAGENT_SETTINGS_DEFAULTS)
    assert.deepEqual(typescriptDefaults(typescript), SUBAGENT_SETTINGS_DEFAULTS)
})
