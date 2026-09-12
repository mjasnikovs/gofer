import assert from 'node:assert/strict'
import test from 'node:test'
import {forwardsScriptsToTheServer} from './script-forwarding.mjs'

function inner(name) {
    const calls = []
    return {
        calls,
        tool: {
            name,
            execute: async (_id, params) => (
                calls.push(params),
                {content: [{type: 'text', text: 'inner'}]}
            )
        }
    }
}

function recording(
    answer = {
        ops: [{op: 'script.edit', result: {files: [{path: 'scripts/a.gd', diagnostics: []}]}}]
    }
) {
    const calls = []
    return {calls, host: {call: async (tool, params) => (calls.push({tool, params}), answer)}}
}

const run = (tool, params) =>
    tool.execute('call-1', params, new AbortController().signal, () => undefined)

test('an edit of a script goes through script.edit with the same anchors', async () => {
    const {calls: below, tool} = inner('edit')
    const {calls, host} = recording()
    const edits = [{oldText: 'a', newText: 'b'}]
    const answer = await run(forwardsScriptsToTheServer(tool, host), {
        path: 'res://scripts/a.gd',
        edits
    })
    assert.deepEqual(calls, [
        {
            tool: 'godot',
            params: {ops: [{op: 'script.edit', files: [{path: 'res://scripts/a.gd', edits}]}]}
        }
    ])
    assert.deepEqual(below, [])
    assert.match(
        answer.content[0].text,
        /^edit does not touch a \.gd, so this went through script\.edit: /u
    )
    assert.match(answer.content[0].text, /diagnostics/u)
})

test('a write of a script goes through script.save with the same text', async () => {
    const {tool} = inner('write')
    const {calls, host} = recording({ops: [{op: 'script.save', result: {path: 'b.gd', bytes: 12}}]})
    await run(forwardsScriptsToTheServer(tool, host), {path: 'b.gd', content: 'extends Node\n'})
    assert.deepEqual(calls, [
        {tool: 'godot', params: {ops: [{op: 'script.save', path: 'b.gd', text: 'extends Node\n'}]}}
    ])
})

test('anything but a script reaches the tool itself, and no host leaves the tool alone', async () => {
    const {calls: below, tool} = inner('edit')
    const {calls, host} = recording()
    const answer = await run(forwardsScriptsToTheServer(tool, host), {path: 'notes.md', edits: []})
    assert.equal(answer.content[0].text, 'inner')
    assert.equal(below.length, 1)
    assert.deepEqual(calls, [])
    assert.equal(forwardsScriptsToTheServer(tool, undefined), tool)
    const read = {name: 'read', execute: async () => undefined}
    assert.equal(forwardsScriptsToTheServer(read, host), read)
})

test("the server's refusal comes back named as the operation that refused it", async () => {
    const {tool} = inner('edit')
    const host = {
        call: async () =>
            Promise.reject(
                new Error('anchor_not_found: `files[0].edits[0].oldText` is not in a.gd')
            )
    }
    await assert.rejects(
        run(forwardsScriptsToTheServer(tool, host), {
            path: 'a.gd',
            edits: [{oldText: 'x', newText: 'y'}]
        }),
        /^Error: edit does not touch a \.gd, so this went through script\.edit, which refused it\. anchor_not_found/u
    )
})
