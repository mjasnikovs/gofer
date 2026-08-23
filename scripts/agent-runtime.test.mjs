import assert from 'node:assert/strict'
import test from 'node:test'
import {
    EMPTY_ANSWER,
    abortableWait,
    decorateTools,
    isWorthRetrying,
    modelReadsImages,
    textContent,
    zeroUsage
} from './agent-runtime.mjs'

const model = {
    id: 'Qwen3.6-27B-UD-Q4_K_XL.gguf',
    name: 'Local AI',
    api: 'openai-completions',
    provider: 'local',
    contextWindow: 120_064
}

/** A tool that answers with whatever it is handed, and says what it was called with. */
function spyTool(answer, name = 'read') {
    const calls = []
    return {
        calls,
        name,
        description: name,
        parameters: {type: 'object', properties: {}},
        execute: async (id, params, signal, onUpdate, context) => {
            calls.push({id, params, context})
            if (answer instanceof Error) throw answer
            return answer
        }
    }
}

test('a zero usage record is the same record for both loops', () => {
    assert.deepEqual(zeroUsage(), {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
    })
    // A fresh object each time. Shared, one turn's accounting would add to another's.
    assert.notEqual(zeroUsage(), zeroUsage())
})

test('the words are taken out of a content list, and an absent one reads as empty', () => {
    assert.equal(
        textContent([
            {type: 'text', text: 'first'},
            {type: 'thinking', thinking: 'not this'},
            {type: 'image', data: 'nor this'},
            {type: 'text', text: ' second'}
        ]),
        'first second'
    )
    // The half of the split that used to differ: the turn's copy threw on this and the child's
    // did not, and every call site of the turn's had written `?? []` to make up for it.
    assert.equal(textContent(undefined), '')
    assert.equal(textContent([]), '')
})

test('a model is taken at its word about pictures, and silence means text', () => {
    assert.equal(modelReadsImages({input: ['text', 'image']}), true)
    assert.equal(modelReadsImages({input: ['text']}), false)
    assert.equal(modelReadsImages({}), false)
    assert.equal(modelReadsImages(undefined), false)
})

test('a decorated tool runs in the environment it was given', async () => {
    const tool = spyTool({content: [{type: 'text', text: 'ok'}]})
    const env = {cwd: '/somewhere'}
    const [decorated] = decorateTools({env, tools: [tool], model})

    await decorated.execute('call-1', {path: 'a.gd'}, undefined, undefined)

    assert.equal(tool.calls.length, 1)
    assert.equal(tool.calls[0].context.env, env)
})

test('a picture is taken out for a model with no eyes and left in for one with them', async () => {
    const picture = {content: [{type: 'image', data: 'AAA', mimeType: 'image/png'}]}
    const blind = spyTool(picture)
    const seeing = spyTool(picture)

    const [forBlind] = decorateTools({env: {}, tools: [blind], model})
    const [forSeeing] = decorateTools({
        env: {},
        tools: [seeing],
        model: {...model, input: ['text', 'image']}
    })

    const hidden = await forBlind.execute('a', {}, undefined, undefined)
    assert.equal(hidden.content[0].type, 'text')
    assert.match(hidden.content[0].text, /you cannot see/u)

    const shown = await forSeeing.execute('a', {}, undefined, undefined)
    assert.equal(shown.content[0].type, 'image')
})

test('the refusal counter is on every decorated tool, and it is one counter per agent', async () => {
    const tool = spyTool(new Error('anchor not found'))
    const [decorated] = decorateTools({env: {}, tools: [tool], model})

    await assert.rejects(decorated.execute('a', {path: 'a.gd'}, undefined, undefined), /anchor/u)
    await assert.rejects(decorated.execute('b', {path: 'a.gd'}, undefined, undefined), /anchor/u)
    await assert.rejects(
        decorated.execute('c', {path: 'a.gd'}, undefined, undefined),
        /refused this exact call 3 times/u
    )

    // A second agent built from the same tool has heard nothing.
    const [again] = decorateTools({env: {}, tools: [tool], model})
    await assert.rejects(again.execute('a', {path: 'a.gd'}, undefined, undefined), /anchor/u)
})

test('extras go on the outside, in the order the caller listed them', async () => {
    const order = []
    const tool = spyTool({content: []})
    const wrap = word => inner => ({
        ...inner,
        execute: async (...args) => {
            order.push(word)
            return inner.execute(...args)
        }
    })
    const [decorated] = decorateTools({
        env: {},
        tools: [tool],
        model,
        extras: [wrap('first'), wrap('second')]
    })

    await decorated.execute('a', {}, undefined, undefined)

    // The last one listed is the outermost, so it is the first to run — and the tool still ran
    // inside the environment the pipeline bound.
    assert.deepEqual(order, ['second', 'first'])
    assert.equal(tool.calls.length, 1)
})

test('a failure that names its own verdict is believed before anything is read', () => {
    assert.equal(isWorthRetrying({retryable: false, reason: 'it used all its steps'}, model), false)
    assert.equal(isWorthRetrying({retryable: true, reason: 'a blip'}, model), true)
})

test('a turn that ended empty is worth asking again', () => {
    assert.equal(isWorthRetrying({stopReason: 'error', errorMessage: EMPTY_ANSWER}, model), true)
})

test('the error a delegation throws is classified by the sentence it carries', () => {
    // The shape the child throws: no `errorMessage`, only a reason written for a model to read.
    assert.equal(isWorthRetrying({reason: 'fetch failed'}, model), true)
    assert.equal(isWorthRetrying({reason: 'insufficient_quota: quota exceeded'}, model), false)
    // And the shape it throws when it kept the message that caused it.
    assert.equal(
        isWorthRetrying(
            {
                reason: 'the model returned an error',
                assistantMessage: {
                    stopReason: 'error',
                    errorMessage: 'upstream connect error: connection refused'
                }
            },
            model
        ),
        true
    )
})

test('a context that will not fit is never waited on, by either loop', () => {
    const overflowed = {
        stopReason: 'error',
        errorMessage:
            "This model's maximum context length is 120064 tokens. However, your messages "
            + 'resulted in 130000 tokens.'
    }
    assert.equal(isWorthRetrying(overflowed, model), false)
    assert.equal(isWorthRetrying({reason: overflowed.errorMessage}, model), false)
})

/** A clock that owes nothing: every wait is written down and then run at once. */
function instantTimers() {
    const waited = []
    return {
        waited,
        now: () => 0,
        schedule(fn, ms) {
            waited.push(ms)
            queueMicrotask(fn)
            return waited.length
        },
        cancel: () => undefined
    }
}

test('a wait is served by the clock it was handed', async () => {
    const timers = instantTimers()
    await abortableWait(60_000, undefined, timers)
    assert.deepEqual(timers.waited, [60_000])
})

test('a wait with no signal at all is an ordinary timer', async () => {
    // The turn's own retry has never had a signal in production, and the wait must still be a wait.
    await abortableWait(0, undefined)
})

test('a wait that is already stopped rejects without arming anything', async () => {
    const timers = instantTimers()
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(abortableWait(60_000, controller.signal, timers), /The turn was stopped/u)
    assert.deepEqual(timers.waited, [])
})

test('a wait that is stopped part-way through gives its timer back', async () => {
    const cancelled = []
    const timers = {
        now: () => 0,
        schedule: () => 'handle',
        cancel: handle => cancelled.push(handle)
    }
    const controller = new AbortController()
    const waiting = abortableWait(60_000, controller.signal, timers, 'the delegation was stopped')
    controller.abort()

    await assert.rejects(waiting, /the delegation was stopped/u)
    assert.deepEqual(cancelled, ['handle'])
})
