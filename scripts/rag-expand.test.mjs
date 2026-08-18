import assert from 'node:assert/strict'
import test from 'node:test'
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai'
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
