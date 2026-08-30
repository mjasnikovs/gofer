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

function fakeModels(content, {stopReason = 'stop', errorMessage} = {}) {
    const calls = []
    return {
        calls,
        streamSimple(model, context, options) {
            calls.push({model, context, options})
            const stream = createAssistantMessageEventStream()
            const message = {role: 'assistant', content, stopReason, errorMessage}
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

    const [call] = models.calls
    assert.equal(call.model.compat.thinkingFormat, 'chat-template')
    assert.equal(call.model.compat.chatTemplateKwargs.enable_thinking.$var, 'thinking.enabled')

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
    assert.equal(call.model.compat.chatTemplateKwargs.enable_thinking.$var, 'thinking.enabled')
})

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
