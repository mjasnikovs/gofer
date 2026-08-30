import assert from 'node:assert/strict'
import test from 'node:test'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {answerText, ASK_PROBE_ANSWER, ASK_USER_TOOL_NAME, createAskUserTool} from './ai-ask.mjs'
import {ASK_LOOP_PROBE_ANSWER, createAskDelegate} from './ai-ask-loop.mjs'
import {
    CHILD_TOOL_NAMES,
    createChildTools,
    DESIGN_TOOL_NAMES,
    SUBAGENT_TOOL_NAMES
} from './ai-subagent.mjs'

const model = {id: 'test-model', api: 'openai-completions', provider: 'test'}

test('a skip tells the model to decide it, not to ask again', () => {
    const text = answerText({questionId: 'question-1', skipped: true})
    assert.match(text, /chose not to decide this/u)
    assert.match(text, /Do not ask again/u)
})

test('a question answered in words comes back as words', () => {
    const text = answerText({questionId: 'question-1', answer: 'its own scene'})
    assert.match(text, /They said: "its own scene"/u)
})

test('a plain question in words can still be asked again under the same id', () => {
    const text = answerText({questionId: 'question-1', answer: 'its own scene'})
    assert.match(text, /questionId question-1/u)
    assert.match(text, /same decision/u)
})

test('a skip is never invited to ask again', () => {
    const text = answerText({questionId: 'question-1', skipped: true})
    assert.doesNotMatch(text, /questionId/u)
})

test('words about a sketch ask for the revision under the same id', () => {
    const text = answerText({questionId: 'question-9', answer: 'the title is too big', sketches: 2})
    assert.match(text, /questionId question-9/u)
})

test('the identifier a revision is asked under is never wrapped in quotes', () => {
    const text = answerText({questionId: 'question-9', answer: 'smaller', sketches: 2})
    assert.doesNotMatch(text, /"question-9"/u)
    assert.match(text, /no quotation marks/u)
})

test('a pick with no note says so, so nothing asks the user to justify it', () => {
    const text = answerText({
        questionId: 'question-1',
        picked: {index: 0, label: 'Bar across the top'}
    })
    assert.match(text, /picked "Bar across the top" \(sketch 1\)/u)
    assert.match(text, /do not ask them to justify it/iu)
    assert.match(text, /do not ask again/iu)
})

test('a pick inside a delegation is a preference, not the end of it', () => {
    const text = answerText(
        {questionId: 'question-1', picked: {index: 0, label: 'Bar across the top'}},
        {inDesign: true}
    )
    assert.match(text, /not the end of the design/u)
    assert.match(text, /show it to them again/u)
    assert.doesNotMatch(text, /do not ask again/iu)
})

test('blocked resources are named in the sentence the model reads', () => {
    const text = answerText({
        questionId: 'question-5',
        answer: 'ugly',
        blocked: ['https://fonts.googleapis.com/…/css2']
    })
    assert.match(text, /fonts\.googleapis\.com/u)
    assert.match(text, /res:\/\/ path/u)
})

test('a project asset that did not go in is reported apart from what was blocked', () => {
    const text = answerText({
        questionId: 'question-6',
        answer: 'fine',
        unresolved: ['res://fonts/Title.ttf (no such file)']
    })
    assert.match(text, /did not go into the sketch/u)
    assert.match(text, /Check the path against the project/u)
})

test('a skip still reports what could not load', () => {
    const text = answerText({
        questionId: 'question-7',
        skipped: true,
        blocked: ['https://x.test/a.png']
    })
    assert.match(text, /chose not to decide/u)
    assert.match(text, /x\.test/u)
})

test('a request for another round is said before anything else the answer implies', () => {
    const text = answerText({questionId: 'question-1', answer: 'narrower than that', again: true})
    assert.match(text, /NOT finished with this/u)
    assert.doesNotMatch(text, /whole answer/u)
})

test('a request for another round names the identifier to ask it under', () => {
    const text = answerText({questionId: 'question-9', answer: 'narrower', again: true})
    assert.match(text, /questionId question-9/u)
    assert.doesNotMatch(text, /"question-9"/u)
})

test('an approval outranks a request for another round', () => {
    const text = answerText({
        questionId: 'question-1',
        answer: 'perfect',
        again: true,
        approved: true
    })
    assert.match(text, /ended the design here/u)
    assert.doesNotMatch(text, /NOT finished/u)
})

test('an approval is not read as a change to make', () => {
    const text = answerText({
        questionId: 'question-9',
        answer: 'perfect',
        sketches: 2,
        picked: {index: 1, label: 'Side rail'},
        approved: true
    })
    assert.match(text, /ended the design here/u)
    assert.doesNotMatch(text, /show them a revision/u)
})

test('an ordinary question is owned by the call that asked it', async () => {
    const sent = []
    const host = {
        call: (_name, request) => {
            sent.push(request)
            return Promise.resolve({questionId: 'question-1', answer: 'y'})
        }
    }
    const tool = createAskUserTool({host})

    await tool.execute('call-42', {question: 'which?'})

    assert.equal(sent[0].ownerCallId, 'call-42')
    assert.equal('isDelegated' in sent[0], false)
})

test('a delegated question carries the call it is asking on behalf of', async () => {
    const sent = []
    const host = {
        call: (_name, request) => {
            sent.push(request)
            return Promise.resolve({questionId: 'question-1', answer: 'y'})
        }
    }
    const tool = createAskUserTool({host, ownerCallId: 'call-parent'})

    await tool.execute('call-child', {question: 'which?'})

    assert.equal(sent[0].ownerCallId, 'call-parent')
    assert.equal(sent[0].isDelegated, true)
})

test('a question never carries an owner the model invented', async () => {
    let seen
    const host = {
        call: (_name, request) => {
            seen = request
            return Promise.resolve({questionId: 'question-1', answer: 'yes'})
        }
    }
    const tool = createAskUserTool({host})

    await tool.execute('call-42', {question: 'which?', ownerCallId: 'call-somebody-else'})

    assert.equal(seen.ownerCallId, 'call-42')
})

test('the two copies of the tool offer two different parameters', () => {
    const parent = createAskUserTool({host: {call: () => Promise.resolve({})}, delegate: () => {}})
    const child = createAskUserTool({host: {call: () => Promise.resolve({})}})

    assert.ok('brief' in parent.parameters.properties)
    assert.ok(!('sketches' in parent.parameters.properties))
    assert.ok('sketches' in child.parameters.properties)
    assert.ok(!('brief' in child.parameters.properties))
})

test('a brief and sketches together are refused', async () => {
    let calls = 0
    const tool = createAskUserTool({
        host: {
            call: () => {
                calls += 1
                return Promise.resolve({})
            }
        },
        delegate: () => assert.fail('a refused call must not start a child')
    })

    await assert.rejects(
        () =>
            tool.execute('call-1', {
                question: 'which?',
                brief: 'a pause menu',
                sketches: [{label: 'a', html: '<p>a</p>'}]
            }),
        /brief AND sketches/u
    )
    assert.equal(calls, 0, 'a refused question never reaches the window')
})

test('the parent is refused sketches and pointed at the brief', async () => {
    const tool = createAskUserTool({
        host: {call: () => assert.fail('a refused question never reaches the window')},
        delegate: () => assert.fail('a refused call must not start a child')
    })

    await assert.rejects(
        () =>
            tool.execute('call-1', {
                question: 'which?',
                sketches: [{label: 'a', html: '<p>a</p>'}]
            }),
        /send a `brief`/u
    )
})

test('the child is refused a brief and pointed at its own sketches', async () => {
    const tool = createAskUserTool({
        host: {call: () => assert.fail('a refused question never reaches the window')}
    })

    await assert.rejects(
        () => tool.execute('call-1', {question: 'which?', brief: 'a pause menu'}),
        /send `sketches`/u
    )
})

function scriptedModels(script) {
    let turn = 0
    const seen = []
    return {
        get turns() {
            return turn
        },
        get seen() {
            return seen
        },
        streamSimple: (requested, context) => {
            seen.push(context)
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
                usage: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 2,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
                },
                stopReason: calls.length > 0 ? 'toolUse' : 'stop',
                timestamp: 0
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

const SKETCH = [{label: 'Bar across the top', html: '<p>a</p>'}]

function askTool({host = {call: () => Promise.resolve({})}, ...overrides} = {}) {
    return createAskUserTool({
        host,
        delegate: createAskDelegate({
            workspacePath: process.cwd(),
            models: {streamSimple: () => assert.fail('the probe must not reach a provider')},
            model,
            thinkingLevel: 'off',
            streamOptions: {},
            settings: {},
            host,
            ...overrides
        })
    })
}

function answering(reply) {
    const asks = []
    return {
        asks,
        call: (name, request) => {
            if (name !== ASK_USER_TOOL_NAME) return Promise.resolve({})
            asks.push(request)
            return Promise.resolve({questionId: 'question-1', ...reply})
        }
    }
}

test('only a delegated design may reach the user, and the ceiling was widened on purpose', () => {
    assert.ok(CHILD_TOOL_NAMES.includes('ask_user'))
    assert.ok(DESIGN_TOOL_NAMES.includes('ask_user'))
    assert.ok(!SUBAGENT_TOOL_NAMES.includes('ask_user'))
})

test('nothing that would make a child something else is on the ceiling', () => {
    for (const name of ['write', 'edit', 'subagent', 'web_fetch'])
        assert.ok(!CHILD_TOOL_NAMES.includes(name), `${name} must not be a tool a child may hold`)
})

test('a child cannot hold ask_user without an owning call', () => {
    assert.throws(
        () =>
            createChildTools(process.cwd(), {
                toolNames: DESIGN_TOOL_NAMES,
                deps: {host: {call: () => Promise.resolve({})}}
            }),
        /ownerCallId/u
    )
})

test('the owning call reaches the child through createChildTools', () => {
    const agreed = {}
    const {tools} = createChildTools(process.cwd(), {
        toolNames: DESIGN_TOOL_NAMES,
        deps: {host: {call: () => Promise.resolve({})}, ownerCallId: 'call-parent', agreed}
    })

    const ask = tools.find(tool => tool.name === ASK_USER_TOOL_NAME)
    assert.ok(ask, 'the child holds the question tool')
    assert.ok(!('brief' in ask.parameters.properties), 'and it is the drafting half of it')
})

test('the probe proves the backend routes it and the child builds', async () => {
    let routed = 0
    const tool = askTool({
        host: {
            call: () => {
                routed += 1
                return Promise.resolve({tool: ASK_USER_TOOL_NAME, reachable: true})
            }
        },
        models: {streamSimple: () => assert.fail('a probe must not reach a provider')}
    })

    const {content} = await tool.execute('call-1', {probe: true})

    assert.equal(routed, 1, 'the backend was asked whether it routes the name')
    assert.match(content[0].text, new RegExp(ASK_PROBE_ANSWER, 'u'))
    assert.match(content[0].text, new RegExp(ASK_LOOP_PROBE_ANSWER, 'u'))
})

test('a whole design asks several times under one owning call', async () => {
    const host = answering({answer: 'tighter', sketches: 1})
    const tool = askTool({
        host,
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {
                calls: [
                    {
                        name: 'ask_user',
                        args: {question: 'and now?', questionId: 'question-1', sketches: SKETCH}
                    }
                ]
            },
            {text: 'The header sits at the top, 64px tall, 24px of padding.'}
        ])
    })

    const result = await tool.execute('call-parent', {
        question: 'how should the HUD sit?',
        brief: 'a pause menu'
    })

    assert.equal(host.asks.length, 2, 'both rounds reached the window')
    for (const ask of host.asks) {
        assert.equal(ask.ownerCallId, 'call-parent')
        assert.equal(ask.isDelegated, true)
    }
    assert.match(result.content[0].text, /64px tall/u)
})

test('a model that asks again after approval is stopped, and its answer is kept', async () => {
    const host = answering({
        approved: true,
        picked: {index: 0, label: 'Bar across the top'},
        sketch: {label: 'Bar across the top', html: '<p>the agreed one</p>'},
        sketches: 1
    })
    const tool = askTool({
        host,
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'A single column, 720px wide, centred.'},
            {calls: [{name: 'ask_user', args: {question: 'sure?', sketches: SKETCH}}]}
        ])
    })

    const {text} = (await tool.execute('call-parent', {question: 'which?', brief: 'a pause menu'}))
        .content[0]

    assert.equal(host.asks.length, 1, 'the user was interrupted once and then not again')
    assert.match(text, /720px wide/u, 'the answer written after the approval is what came back')
    assert.ok(!text.includes('DID NOT AGREE'))
})

test('a round after the approval cannot change the layout that was agreed', async () => {
    const asks = []
    const host = {
        asks,
        call: (name, request) => {
            if (name !== ASK_USER_TOOL_NAME) return Promise.resolve({})
            asks.push(request)
            return Promise.resolve(
                asks.length === 1 ?
                    {
                        questionId: 'question-1',
                        approved: true,
                        picked: {index: 0, label: 'Bar across the top'},
                        sketch: {label: 'Bar across the top', html: '<p>the agreed one</p>'}
                    }
                :   {
                        questionId: 'question-1',
                        answer: 'not that one',
                        sketch: {label: 'Rail down the side', html: '<p>the one after</p>'}
                    }
            )
        }
    }
    const tool = askTool({
        host,
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {calls: [{name: 'ask_user', args: {question: 'sure?', sketches: SKETCH}}]},
            {text: 'A single column, 720px wide, centred.'}
        ])
    })

    const {text} = (await tool.execute('call-parent', {question: 'which?', brief: 'a pause menu'}))
        .content[0]

    assert.equal(asks.length, 2, 'the child did ask again, which is the case being covered')
    assert.match(text, /<p>the agreed one<\/p>/u, 'the layout they approved is what comes back')
    assert.ok(!text.includes('the one after'), 'and the round after it is not what they agreed')
    assert.ok(!text.includes('DID NOT AGREE'), 'the approval itself still stands')
})

test('the layout the user agreed comes back drawn as well as described', async () => {
    const tool = askTool({
        host: answering({
            approved: true,
            picked: {index: 0, label: 'Bar across the top'},
            sketch: {label: 'Bar across the top', html: '<p>the agreed one</p>'},
            sketches: 1
        }),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'The dock sits bottom-left, 576x84.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /The dock sits bottom-left/u, 'the agreement in words is still first')
    assert.match(text, /<p>the agreed one<\/p>/u, 'and the drawing is under it')
    assert.match(text, /Bar across the top/u, 'named, so it can be talked about')
})

test('a layout that was never agreed is not handed over as agreed', async () => {
    const tool = askTool({
        host: answering({
            approved: false,
            answer: 'no, much wider',
            picked: {index: 0, label: 'Bar across the top'},
            sketch: {label: 'Bar across the top', html: '<p>REJECTED</p>'},
            sketches: 1
        }),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'They asked for changes and then stopped answering.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.ok(!text.includes('REJECTED'), 'the rejected layout must not be handed over')
    assert.ok(!text.includes('they agreed'))
})

test('a design the user never ended says so before it says anything else', async () => {
    const tool = askTool({
        host: answering({
            approved: false,
            answer: 'bigger rows',
            sketch: {label: 'Bar across the top', html: '<p>a</p>'},
            sketches: 1
        }),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'The dock sits bottom-left.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /^THE USER DID NOT AGREE THIS\./u)
    assert.match(text, /shown 1 round/u)
    assert.match(text, /proposal, not a decision/u)
})

test('a design nobody was ever shown says nobody was shown it', async () => {
    const tool = askTool({models: scriptedModels([{text: 'The dock sits bottom-left.'}])})

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /^THE USER DID NOT AGREE THIS\./u)
    assert.match(text, /never shown anything at all/u)
})

test('a design agreed without the pictures says so', async () => {
    const tool = askTool({
        models: scriptedModels([{text: 'Agreed.'}]),
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /never reached the design loop/u)
    assert.match(text, /project files alone/u)
})

test('a design agreed with the pictures says nothing about them', async () => {
    const tool = askTool({
        model: {...model, input: ['text', 'image']},
        models: scriptedModels([{text: 'Agreed.'}]),
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.ok(!text.includes('never reached the design loop'))
})

test('an answer with no drawing behind it appends nothing', async () => {
    const tool = askTool({
        host: answering({skipped: true}),
        models: scriptedModels([
            {calls: [{name: 'ask_user', args: {question: 'which?', sketches: SKETCH}}]},
            {text: 'They walked away.'}
        ])
    })

    const {text} = (await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'}))
        .content[0]

    assert.match(text, /They walked away\./u)
    assert.ok(!text.includes('they agreed'), 'nothing was agreed, so nothing is claimed to be')
})

test('the pictures the user attached are what the child designs against', async () => {
    const picture = {type: 'image', data: 'AAAA', mimeType: 'image/png'}
    const models = scriptedModels([{text: 'Agreed.'}])
    const tool = askTool({
        model: {...model, input: ['text', 'image']},
        models,
        images: [picture]
    })

    await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'})

    const parts = models.seen[0].messages.flatMap(message =>
        Array.isArray(message.content) ? message.content : []
    )
    assert.deepEqual(
        parts.filter(part => part.type === 'image'),
        [picture]
    )
})

test('a child that cannot see is sent no pictures at all', async () => {
    const models = scriptedModels([{text: 'Agreed.'}])
    const tool = askTool({
        models,
        images: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]
    })

    await tool.execute('call-1', {question: 'which?', brief: 'a squad dock'})

    const parts = models.seen[0].messages.flatMap(message =>
        Array.isArray(message.content) ? message.content : []
    )
    assert.equal(parts.filter(part => part.type === 'image').length, 0)
})

test('the layout the user reacted to is recorded without being read back to the child', async () => {
    const agreed = {}
    const tool = createAskUserTool({
        host: {
            call: () =>
                Promise.resolve({
                    questionId: 'question-1',
                    approved: true,
                    sketch: {label: 'Bar across the top', html: '<p>a</p>'},
                    sketches: 1
                })
        },
        ownerCallId: 'call-parent',
        agreed
    })

    const answer = await tool.execute('call-child', {question: 'which?'})

    assert.deepEqual(agreed, {
        rounds: 1,
        approved: true,
        label: 'Bar across the top',
        html: '<p>a</p>'
    })
    assert.ok(!answer.content[0].text.includes('<p>a</p>'))
})

test('a retried attempt inherits no layout from the attempt that failed', () => {
    const agreed = {rounds: 3, label: 'Stale', html: '<p>old</p>', approved: true}

    createAskUserTool({
        host: {call: () => Promise.resolve({})},
        ownerCallId: 'call-parent',
        agreed
    })

    assert.deepEqual(agreed, {})
})
