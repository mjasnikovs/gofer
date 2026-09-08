import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createRememberTool,
    MEMORY_KINDS,
    REMEMBER_PROBE_ANSWER,
    REMEMBER_TOOL_NAME
} from './ai-remember.mjs'
import {toolStepLine} from './tool-target.mjs'

function recording(answer = {memoryId: 'memory-1', stored: 'Stored.'}) {
    const calls = []
    return {
        calls,
        call: (name, params) => {
            calls.push({name, params})
            return Promise.resolve(answer)
        }
    }
}

test('the tool offers only the kinds a memory can be', () => {
    const tool = createRememberTool({host: recording()})

    assert.equal(tool.name, REMEMBER_TOOL_NAME)
    assert.deepEqual(tool.parameters.properties.kind.enum, MEMORY_KINDS)
    assert.deepEqual(tool.parameters.required, ['kind', 'content'])
    assert.ok(!MEMORY_KINDS.includes('summary'), 'a transcript is not a kind of memory')
})

test('the description says what is not worth remembering, not only what is', () => {
    const {description} = createRememberTool({host: recording()})

    assert.match(description, /Never worth remembering/u)
    assert.match(description, /already say/u)
    assert.match(description, /true only right now/u)
})

test('a memory reaches the backend with the call that made it', async () => {
    const host = recording()
    const tool = createRememberTool({host})

    const {content, details} = await tool.execute('call-7', {
        kind: 'preference',
        content: 'The user never wants a match statement.',
        why: 'a later turn would write one'
    })

    assert.deepEqual(host.calls, [
        {
            name: REMEMBER_TOOL_NAME,
            params: {
                kind: 'preference',
                content: 'The user never wants a match statement.',
                callId: 'call-7'
            }
        }
    ])
    assert.equal(details.memoryId, 'memory-1')
    assert.equal(content[0].text, 'Stored.')
})

test('the model is told the memory is not in play yet, so it does not ask about it', async () => {
    const stored =
        'The user has not kept it yet, so no later turn has been given it. Do not remember this '
        + 'again and do not ask them about it.'
    const tool = createRememberTool({host: recording({memoryId: 'memory-1', stored})})

    const {content} = await tool.execute('call-1', {kind: 'fact', content: 'x'})

    assert.equal(content[0].text, stored)
})

test('a probe routes the name without storing anything', async () => {
    const host = recording({tool: REMEMBER_TOOL_NAME, reachable: true})
    const tool = createRememberTool({host})

    const {content} = await tool.execute('call-1', {probe: true})

    assert.deepEqual(host.calls, [{name: REMEMBER_TOOL_NAME, params: {probe: true}}])
    assert.equal(content[0].text, REMEMBER_PROBE_ANSWER)
})

test('the step line names the fact, not a file it has no path for', () => {
    assert.equal(
        toolStepLine(REMEMBER_TOOL_NAME, {
            kind: 'fact',
            content: 'Audio is  pooled\n through an autoload.'
        }),
        'remember: Audio is pooled through an autoload.'
    )
})
