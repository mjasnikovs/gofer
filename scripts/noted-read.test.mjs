import assert from 'node:assert/strict'
import test from 'node:test'
import {NOTED_READ_TOOL, notesTheRead} from './noted-read.mjs'

const shown = (text, details = {}) => ({content: [{type: 'text', text}], details})

function reading(answer) {
    return {name: 'read', execute: async () => answer}
}

function recording() {
    const calls = []
    return {
        calls,
        host: {call: async (tool, params) => (calls.push({tool, params}), {noted: true})}
    }
}

const run = (tool, params) =>
    tool.execute('read-1', params, new AbortController().signal, () => undefined)

test('a whole read names the file to the host the way the project spells it', async () => {
    const {calls, host} = recording()
    const tool = notesTheRead(reading(shown('extends Node2D\n')), host, '/work')
    const answer = await run(tool, {path: 'res://scripts/player.gd'})
    assert.equal(answer.content[0].text, 'extends Node2D\n')
    assert.deepEqual(calls, [{tool: NOTED_READ_TOOL, params: {path: 'scripts/player.gd'}}])

    calls.length = 0
    await run(tool, {path: '/work/scripts/player.gd'})
    assert.deepEqual(calls, [{tool: NOTED_READ_TOOL, params: {path: 'scripts/player.gd'}}])
})

test('a part of a file arms nothing', async () => {
    const {calls, host} = recording()
    await run(notesTheRead(reading(shown('x')), host, '/work'), {path: 'a.gd', offset: 2})
    await run(notesTheRead(reading(shown('x')), host, '/work'), {path: 'a.gd', limit: 5})
    await run(notesTheRead(reading(shown('x', {truncation: {truncated: true}})), host, '/work'), {
        path: 'a.gd'
    })
    await run(notesTheRead(reading(shown('a/\nb.gd', {entries: 2})), host, '/work'), {
        path: 'scripts'
    })
    await run(notesTheRead(reading({content: [{type: 'image', data: ''}]}), host, '/work'), {
        path: 'a.png'
    })
    assert.deepEqual(calls, [])
})

test('a file outside the project, or a host that cannot hear, changes nothing about the read', async () => {
    const {calls, host} = recording()
    await run(notesTheRead(reading(shown('x')), host, '/work'), {path: '../outside.gd'})
    await run(notesTheRead(reading(shown('x')), host, '/work'), {path: '.gofer-tool-probe'})
    await run(notesTheRead(reading(shown('x')), host, '/work'), {path: '.gofer/skills/a/SKILL.md'})
    assert.deepEqual(calls, [])

    const deaf = {call: async () => Promise.reject(new Error('gone'))}
    const answer = await run(notesTheRead(reading(shown('x')), deaf, '/work'), {path: 'a.gd'})
    assert.equal(answer.content[0].text, 'x')

    const bare = reading(shown('x'))
    assert.equal(notesTheRead(bare, undefined, '/work'), bare)
})
