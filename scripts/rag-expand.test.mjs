import assert from 'node:assert/strict'
import test from 'node:test'
import {clampThinkingLevel, createAssistantMessageEventStream} from '@earendil-works/pi-ai'
import {createCompletion, isUsableConnection, textOf} from './rag-expand.mjs'

const CONNECTION = {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'small.gguf',
    modelName: 'Small',
    apiKey: null,
    thinkingLevel: 'low',
    contextWindow: 8192,
    maxTokens: 4096,
    reasoning: true,
    supportsReasoningEffort: true,
    timeoutMs: 30_000,
    maxRetries: 1
}

/** A provider that answers once with the content parts it is given. */
function fakeModels(content, {stopReason = 'stop', errorMessage} = {}) {
    const calls = []
    return {
        calls,
        streamSimple(model, context, options) {
            calls.push({model, context, options})
            const stream = createAssistantMessageEventStream()
            const message = {role: 'assistant', content, stopReason, errorMessage}
            // The two shapes pi-ai really emits: a failure carries the message as `error`.
            stream.push(
                stopReason === 'error' ?
                    {type: 'error', reason: 'error', error: message}
                :   {type: 'done', reason: 'stop', message}
            )
            stream.end(message)
            return stream
        }
    }
}

test('a connection without an address or a model cannot be used', () => {
    assert.equal(isUsableConnection(CONNECTION), true)
    for (const broken of [
        undefined,
        null,
        'local',
        {...CONNECTION, baseUrl: ''},
        {...CONNECTION, baseUrl: undefined},
        {...CONNECTION, model: ''},
        {...CONNECTION, model: undefined}
    ]) {
        assert.equal(isUsableConnection(broken), false)
        assert.equal(createCompletion(broken), undefined)
    }
})

test('thinking is dropped and only the answer text comes back', async () => {
    const models = fakeModels([
        {type: 'thinking', thinking: 'Tween is primary. Also AnimationPlayer.'},
        {type: 'text', text: '  Tween, AnimationPlayer, Animation  '}
    ])
    const complete = createCompletion(CONNECTION, {models})

    const answer = await complete({system: 'be terse', user: 'animate a value', maxTokens: 100})

    assert.equal(answer, 'Tween, AnimationPlayer, Animation')
})

test('the reasoning level, the ceilings and the prompt are the ones supplied', async () => {
    const models = fakeModels([{type: 'text', text: 'Tween, Animation'}])
    const complete = createCompletion(CONNECTION, {models})

    await complete({system: 'EXPAND', user: 'animate a value', maxTokens: 100})

    const [call] = models.calls
    assert.equal(call.options.reasoning, 'low')
    assert.equal(call.options.timeoutMs, 30_000)
    assert.equal(call.options.maxRetries, 1)
    // Per request, not per connection: expansion wants a hundred tokens, an answer wants the window.
    assert.equal(call.model.maxTokens, 100)
    assert.equal(call.model.id, 'small.gguf')
    assert.equal(call.model.baseUrl, CONNECTION.baseUrl)
    assert.equal(call.context.systemPrompt, 'EXPAND')
    assert.deepEqual(call.context.messages, [{role: 'user', content: 'animate a value'}])
})

test('a chat-template server is sent the argument that turns thinking on', async () => {
    const models = fakeModels([{type: 'text', text: 'Tween'}])
    const complete = createCompletion({...CONNECTION, chatTemplateThinking: true}, {models})

    await complete({system: 'EXPAND', user: 'animate a value', maxTokens: 100})

    // The same switch the agent worker sends. This is the second copy of that builder, in a process
    // that cannot import the first without dragging the whole agent into a search.
    const [call] = models.calls
    assert.equal(call.model.compat.thinkingFormat, 'chat-template')
    assert.equal(call.model.compat.chatTemplateKwargs.enable_thinking.$var, 'thinking.enabled')

    // And a connection that never heard from a `/props` is left exactly as it was.
    const plain = fakeModels([{type: 'text', text: 'Tween'}])
    await createCompletion(CONNECTION, {models: plain})({
        system: 'EXPAND',
        user: 'animate a value',
        maxTokens: 100
    })
    assert.equal(plain.calls[0].model.compat.thinkingFormat, undefined)
})

test('a model that answered with an error throws rather than returning empty text', async () => {
    const models = fakeModels([], {stopReason: 'error', errorMessage: 'connection refused'})
    const complete = createCompletion(CONNECTION, {models})

    await assert.rejects(
        () => complete({system: 's', user: 'u', maxTokens: 100}),
        /connection refused/u
    )
})

test('an off level is what a connection with no level asks at', async () => {
    const models = fakeModels([{type: 'text', text: 'Tween'}])
    const complete = createCompletion({...CONNECTION, thinkingLevel: ''}, {models})

    await complete({system: 's', user: 'u', maxTokens: 100})

    assert.equal(models.calls[0].options.reasoning, 'off')
})

test('textOf keeps only text parts', () => {
    assert.equal(textOf(undefined), '')
    assert.equal(textOf({content: []}), '')
    assert.equal(
        textOf({
            content: [
                {type: 'thinking', thinking: 'x'},
                {type: 'text', text: 'a'}
            ]
        }),
        'a'
    )
})

/**
 * The level the search asks at has to be one pi-ai's own scale contains.
 *
 * `on` is not on it. Handed one it does not know, `clampThinkingLevel` drops to the lowest level
 * the model offers — `off` — and the chat-template switch then resolves to `enable_thinking: false`.
 * A search expansion that was supposed to think went out with thinking explicitly disabled.
 */
test('the on level survives the clamp pi-ai puts every request through', async () => {
    const models = fakeModels([{type: 'text', text: 'Tween'}])
    const connection = {
        ...CONNECTION,
        supportsReasoningEffort: false,
        chatTemplateThinking: true,
        thinkingLevel: 'on'
    }

    await createCompletion(connection, {models})({system: 's', user: 'u', maxTokens: 100})

    const [call] = models.calls
    const clamped = clampThinkingLevel(call.model, call.options.reasoning)
    assert.notEqual(clamped, 'off', 'the level reached the request as off')
    // Which is what makes the template argument true, since that is read off the surviving effort.
    assert.equal(call.model.compat.chatTemplateKwargs.enable_thinking.$var, 'thinking.enabled')
})

/**
 * The search asks at the level the server named, under the name the server used.
 *
 * The second copy of the worker's model builder, and it had the second copy of the same clamp.
 * pi-ai only believes a model has `xhigh` or `max` if the model says so; unsaid, `xhigh` is clamped
 * to `high`, and the chat template these levels were read out of raises on a word it does not know.
 */
test('a named effort is not clamped onto one the template never offered', async () => {
    const models = fakeModels([{type: 'text', text: 'Tween'}])
    const connection = {
        ...CONNECTION,
        supportsReasoningEffort: true,
        chatTemplateThinking: true,
        thinkingLevels: ['low', 'medium', 'xhigh'],
        thinkingLevel: 'xhigh'
    }

    await createCompletion(connection, {models})({system: 's', user: 'u', maxTokens: 100})

    const [call] = models.calls
    assert.equal(clampThinkingLevel(call.model, call.options.reasoning), 'xhigh')
})
