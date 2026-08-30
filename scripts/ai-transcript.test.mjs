import {strict as assert} from 'node:assert'
import test from 'node:test'
import {createTranscript, withoutTrailingAnswer} from './ai-transcript.mjs'

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
