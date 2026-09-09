import {strict as assert} from 'node:assert'
import test from 'node:test'
import {createTranscript, withoutEmptyToolCalls, withoutTrailingAnswer} from './ai-transcript.mjs'

const user = text => ({role: 'user', content: [{type: 'text', text}]})
const assistant = text => ({role: 'assistant', content: [{type: 'text', text}]})
const toolResult = id => ({role: 'tool', content: [{type: 'tool_result', toolCallId: id}]})

function fakeAgent(messages) {
    return {state: {messages}}
}

function recorder() {
    const emitted = []
    return {emitted, emit: event => emitted.push(event)}
}

test('the trailing answer comes off, and nothing else does', () => {
    assert.deepEqual(withoutTrailingAnswer([user('a'), assistant('b')]), [user('a')])
    assert.deepEqual(withoutTrailingAnswer([user('a'), toolResult('t1')]), [
        user('a'),
        toolResult('t1')
    ])
    assert.deepEqual(withoutTrailingAnswer([user('a')]), [user('a')])
    assert.deepEqual(withoutTrailingAnswer([]), [])
})

test('only one answer comes off, however many are on the end', () => {
    assert.deepEqual(withoutTrailingAnswer([user('a'), assistant('b'), assistant('c')]), [
        user('a'),
        assistant('b')
    ])
})

test('every checkpoint reports what the model remembers at that moment', () => {
    const agent = fakeAgent([user('a')])
    const {emitted, emit} = recorder()
    const transcript = createTranscript(agent, emit)

    transcript.checkpoint()
    agent.state.messages = [user('a'), assistant('b')]
    transcript.checkpoint()

    assert.deepEqual(emitted, [
        {type: 'turn-state', agentMessages: [user('a')]},
        {type: 'turn-state', agentMessages: [user('a'), assistant('b')]}
    ])
})

test('a compaction leaves stored and sent holding the same thing', () => {
    const agent = fakeAgent([user('a'), assistant('b'), user('c')])
    const {emitted, emit} = recorder()
    const transcript = createTranscript(agent, emit)

    const compacted = [user('summary'), user('c')]
    const sent = transcript.replaceWith(compacted)

    assert.deepEqual(sent, compacted)
    assert.deepEqual(transcript.messages(), compacted)
    transcript.checkpoint()
    assert.deepEqual(emitted.at(-1), {type: 'turn-state', agentMessages: compacted})
})

test('a compaction followed by a retry drops the answer from the compacted transcript', () => {
    const agent = fakeAgent([user('a'), assistant('long'), user('b'), assistant('failed')])
    const transcript = createTranscript(agent, recorder().emit)

    transcript.replaceWith([user('summary'), user('b'), assistant('failed')])
    transcript.dropTrailingAnswer()

    assert.deepEqual(transcript.messages(), [user('summary'), user('b')])
})

test('an overflow recovery followed by a transient failure takes only one answer off', () => {
    const agent = fakeAgent([user('a'), assistant('too big')])
    const transcript = createTranscript(agent, recorder().emit)

    const withoutError = withoutTrailingAnswer(transcript.messages())
    assert.deepEqual(withoutError, [user('a')])
    transcript.replaceWith([user('summary')])

    agent.state.messages = [user('summary'), assistant('transient error')]
    transcript.dropTrailingAnswer()

    assert.deepEqual(transcript.messages(), [user('summary')])
})

test('dropping an answer that is not there changes nothing', () => {
    const agent = fakeAgent([user('a'), toolResult('t1')])
    const transcript = createTranscript(agent, recorder().emit)

    transcript.dropTrailingAnswer()

    assert.deepEqual(transcript.messages(), [user('a'), toolResult('t1')])
})

const emptyCall = id => ({
    role: 'assistant',
    content: [{type: 'toolCall', id, name: 'godot', arguments: {ops: [{op: 'set_property'}]}}]
})
const fullCall = id => ({
    role: 'assistant',
    content: [
        {
            type: 'toolCall',
            id,
            name: 'godot',
            arguments: {
                ops: [
                    {
                        op: 'node.set_properties',
                        properties: [{node: 'Player', name: 'speed', value: 3}]
                    }
                ]
            }
        }
    ]
})
const failed = id => ({
    role: 'toolResult',
    toolCallId: id,
    isError: true,
    content: [{type: 'text', text: 'missing_param: node.set_properties requires `properties`.'}]
})
const succeeded = id => ({role: 'toolResult', toolCallId: id, isError: false, content: []})
const refusedForAnotherReason = id => ({
    role: 'toolResult',
    toolCallId: id,
    isError: true,
    content: [{type: 'text', text: 'read_only: a sub-agent changes nothing.'}]
})

test('an empty call and its refusal both leave the history', () => {
    assert.deepEqual(withoutEmptyToolCalls([user('a'), emptyCall('c1'), failed('c1'), user('b')]), [
        user('a'),
        user('b')
    ])
})

test('a call with parameters stays, refused or not', () => {
    const kept = [user('a'), fullCall('c1'), failed('c1')]
    assert.deepEqual(withoutEmptyToolCalls(kept), kept)
})

test('an empty call that somehow worked stays', () => {
    const kept = [emptyCall('c1'), succeeded('c1')]
    assert.deepEqual(withoutEmptyToolCalls(kept), kept)
})

test('a call with no result stays, because the API refuses an orphan', () => {
    const kept = [emptyCall('c1')]
    assert.deepEqual(withoutEmptyToolCalls(kept), kept)
})

test('a message holding one empty call and one good one stays whole', () => {
    const mixed = {
        role: 'assistant',
        content: [...emptyCall('c1').content, ...fullCall('c2').content]
    }
    const kept = [mixed, failed('c1'), succeeded('c2')]
    assert.deepEqual(withoutEmptyToolCalls(kept), kept)
})

test('a message whose every empty call failed goes with all of its results', () => {
    const both = {
        role: 'assistant',
        content: [...emptyCall('c1').content, ...emptyCall('c2').content]
    }
    assert.deepEqual(withoutEmptyToolCalls([user('a'), both, failed('c1'), failed('c2')]), [
        user('a')
    ])
})

test('a bare operation with no ops wrapper counts as empty', () => {
    const bare = {
        role: 'assistant',
        content: [{type: 'toolCall', id: 'c1', name: 'godot', arguments: {op: 'set_property'}}]
    }
    assert.deepEqual(withoutEmptyToolCalls([bare, failed('c1')]), [])
})

test('plain text and results nobody called are untouched', () => {
    const kept = [user('a'), assistant('b'), succeeded('c9')]
    assert.deepEqual(withoutEmptyToolCalls(kept), kept)
})

test('an operation refused for anything but its parameters stays', () => {
    const kept = [emptyCall('c1'), refusedForAnotherReason('c1')]
    assert.deepEqual(withoutEmptyToolCalls(kept), kept)
})

test('the refusal that says it has heard this call before goes too', () => {
    const worn = {
        role: 'toolResult',
        toolCallId: 'c1',
        isError: true,
        content: [{type: 'text', text: 'godot has now refused this exact call 3 times, …'}]
    }
    assert.deepEqual(withoutEmptyToolCalls([emptyCall('c1'), worn]), [])
})
