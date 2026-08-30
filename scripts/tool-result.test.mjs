import assert from 'node:assert/strict'
import test from 'node:test'
import {modelReadsImages} from './agent-runtime.mjs'
import {toolResult, withoutPictures, withoutRepeatingARefusal} from './tool-result.mjs'

test('captured frames become image content and large results are bounded', () => {
    const captured = toolResult({
        running: true,
        frame: {encoding: 'png-base64', width: 320, height: 240, data: 'iVBORw0KGgo='}
    })

    assert.deepEqual(captured.content[1], {
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png'
    })
    assert.equal(JSON.parse(captured.content[0].text).frame.data, undefined)
    assert.equal(JSON.parse(captured.content[0].text).frame.width, 320)
    assert.equal(captured.details.frame.data, 'iVBORw0KGgo=')

    const huge = toolResult({nodes: 'x'.repeat(40_000)})
    assert.equal(huge.content.length, 1)
    assert.ok(huge.content[0].text.length <= 24_000)
    assert.match(JSON.parse(huge.content[0].text).nodes, /… \[truncated, 40000 characters\]$/u)
    assert.equal(huge.details.nodes.length, 40_000)

    const listed = toolResult({
        ops: [
            {op: 'inspect', result: {node: '/Main', properties: {mesh: 'm'.repeat(60_000)}}},
            {op: 'inspect', result: {node: '/Main/Player', properties: {position: '(0, 0)'}}},
            {op: 'inspect', result: {node: '/Main/Camera', properties: {zoom: '(2, 2)'}}}
        ]
    })
    const answered = JSON.parse(listed.content[0].text)
    assert.equal(listed.content[0].text.length <= 24_000, true)
    assert.equal(answered.ops.length, 3)
    assert.deepEqual(
        answered.ops.map(entry => entry.result.node),
        ['/Main', '/Main/Player', '/Main/Camera']
    )
    assert.equal(answered.ops[1].result.properties.position, '(0, 0)')
    assert.equal(answered.ops[2].result.properties.zoom, '(2, 2)')
    assert.match(answered.ops[0].result.properties.mesh, /… \[truncated, 60000 characters\]$/u)

    const two = toolResult({
        ops: [
            {op: 'open', result: {path: 'a.gd', text: 'a'.repeat(40_000)}},
            {op: 'open', result: {path: 'b.gd', text: 'b'.repeat(40_000)}}
        ]
    })
    const both = JSON.parse(two.content[0].text)
    assert.equal(two.content[0].text.length <= 24_000, true)
    assert.deepEqual(
        both.ops.map(entry => entry.result.path),
        ['a.gd', 'b.gd']
    )
    for (const entry of both.ops)
        assert.match(entry.result.text, /… \[truncated, 40000 characters\]$/u)

    const listing = toolResult({
        ops: [
            {
                op: 'list',
                result: {
                    files: Array.from({length: 100}, (_, index) => ({
                        path: `scripts/s${String(index)}.gd`,
                        text: 'x'.repeat(30_000)
                    }))
                }
            }
        ]
    })
    const files = JSON.parse(listing.content[0].text).ops[0].result.files
    assert.equal(listing.content[0].text.length <= 24_000, true)
    assert.equal(files.length, 100)
    assert.equal(files[99].path, 'scripts/s99.gd')
    assert.equal(new Set(files.map(file => file.text.length)).size, 1)

    const wide = toolResult({
        ops: [
            {
                op: 'inspect',
                result: {
                    path: '/Main/Panel',
                    type: 'PanelContainer',
                    properties: Array.from({length: 400}, (_, i) => ({
                        name: `theme_override_constants/margin_${String(i)}`,
                        value: {type: 'int', value: i},
                        stored: false
                    }))
                }
            }
        ]
    })
    assert.ok(wide.content[0].text.length <= 24_000)
    const inspected = JSON.parse(wide.content[0].text).ops[0].result
    assert.equal(inspected.type, 'PanelContainer', 'the keys around the list all survive')
    assert.ok(inspected.properties.length > 40, 'a useful number of entries survives whole')
    assert.deepEqual(
        inspected.properties[0],
        {name: 'theme_override_constants/margin_0', value: {type: 'int', value: 0}, stored: false},
        'and the ones that survive are untouched, names and all'
    )
    assert.match(inspected.properties.at(-1), /^… \[truncated, \d+ more entries\]$/u)

    const paired = toolResult({
        ops: [
            {
                op: 'inspect',
                result: {
                    path: '/Main/Panel',
                    type: 'PanelContainer',
                    properties: Object.fromEntries(
                        Array.from({length: 400}, (_, i) => [
                            `theme_override_constants/margin_${String(i)}`,
                            {type: 'vector2', value: [12.5 + i, 34.25 + i]}
                        ])
                    )
                }
            }
        ]
    })
    assert.doesNotMatch(
        paired.content[0].text,
        /more entries/u,
        'a two-entry list costs more to shorten than to keep, so it is kept'
    )
    assert.match(paired.content[0].text, /\[12\.5,34\.25\]/u, 'and its values are still there')

    const many = toolResult(Object.fromEntries(Array.from({length: 4_000}, (_, i) => [`k${i}`, i])))
    assert.ok(many.content[0].text.length <= 24_100)
    assert.match(many.content[0].text, /… \[truncated, \d+ characters\]$/u)
})

test('a tool answering with an image is stripped for a model that cannot see', async () => {
    const png = {
        content: [
            {type: 'text', text: 'Read image file [image/png]'},
            {type: 'image', data: 'iVBOR', mimeType: 'image/png'}
        ]
    }
    const tool = {name: 'read', execute: () => Promise.resolve(png)}

    const blind = await withoutPictures(tool).execute('id', {})
    assert.equal(blind.content.length, 2)
    assert.equal(blind.content[1].type, 'text')
    assert.match(blind.content[1].text, /you cannot see/u)

    assert.equal(modelReadsImages({input: ['text', 'image']}), true)
    assert.equal(modelReadsImages({input: ['text']}), false)
    assert.equal(modelReadsImages(undefined), false)
    const plain = {content: [{type: 'text', text: 'hello'}]}
    assert.equal(
        await withoutPictures({name: 'read', execute: () => plain}).execute('id', {}),
        plain
    )
})

test('says so when the same call keeps meeting the same refusal', async () => {
    const refusing = {
        name: 'godot_node',
        execute: () => Promise.reject(new Error('missing_param: requires `parent`'))
    }
    const guarded = withoutRepeatingARefusal(refusing)
    const said = []
    for (let attempt = 0; attempt < 4; attempt += 1)
        await guarded
            .execute('id', {ops: [{op: 'create'}]})
            .catch(error => said.push(error.message))
    assert.equal(said[0], 'missing_param: requires `parent`')
    assert.equal(said[1], 'missing_param: requires `parent`')
    assert.match(said[2], /refused this exact call 3 times/u)
    assert.match(said[3], /refused this exact call 4 times/u)
    assert.doesNotMatch(said[2], /coming apart/u)

    let answer = 'first'
    const varying = {
        name: 'godot_runtime',
        execute: () => Promise.reject(new Error(answer))
    }
    const patient = withoutRepeatingARefusal(varying)
    const heard = []
    for (const next of ['first', 'second', 'third', 'fourth']) {
        answer = next
        await patient.execute('id', {ops: [{op: 'wait'}]}).catch(error => heard.push(error.message))
    }
    assert.deepEqual(heard, ['first', 'second', 'third', 'fourth'])

    const reordered = withoutRepeatingARefusal({
        name: 'godot_node',
        execute: () => Promise.reject(new Error('missing_param: requires `parent`'))
    })
    const shuffled = []
    for (const params of [
        {a: 1, b: 2},
        {b: 2, a: 1},
        {a: 1, b: 2}
    ])
        await reordered.execute('id', params).catch(error => shuffled.push(error.message))
    assert.match(shuffled[2], /refused this exact call 3 times/u)

    const stopped = new AbortController()
    stopped.abort()
    const cancelled = withoutRepeatingARefusal({
        name: 'bash',
        execute: () => Promise.reject(new Error('aborted'))
    })
    const stops = []
    for (let attempt = 0; attempt < 3; attempt += 1)
        await cancelled
            .execute('id', {command: 'ls'}, stopped.signal)
            .catch(error => stops.push(error.message))
    assert.deepEqual(stops, ['aborted', 'aborted', 'aborted'])

    const working = {name: 'read', execute: () => Promise.resolve({content: []})}
    assert.deepEqual(await withoutRepeatingARefusal(working).execute('id', {}), {content: []})
})

test('the two decorators stack in either order', async () => {
    const answering = {
        name: 'read',
        execute: () =>
            Promise.resolve({content: [{type: 'image', data: 'iVBOR', mimeType: 'image/png'}]})
    }
    for (const stacked of [
        withoutPictures(withoutRepeatingARefusal(answering)),
        withoutRepeatingARefusal(withoutPictures(answering))
    ]) {
        const result = await stacked.execute('id', {})
        assert.equal(result.content[0].type, 'text')
        assert.match(result.content[0].text, /you cannot see/u)
    }

    const refusing = {name: 'read', execute: () => Promise.reject(new Error('missing_param'))}
    for (const stacked of [
        withoutPictures(withoutRepeatingARefusal(refusing)),
        withoutRepeatingARefusal(withoutPictures(refusing))
    ]) {
        const said = []
        for (let attempt = 0; attempt < 3; attempt += 1)
            await stacked.execute('id', {a: 1}).catch(error => said.push(error.message))
        assert.match(said[2], /refused this exact call 3 times/u)
    }
})

test('an input frame another frame in the same call replaces is not sent', () => {
    const frame = data => ({encoding: 'png-base64', width: 640, height: 360, data})
    const stepped = toolResult({
        ops: [
            {op: 'input', result: {applied: 1, frame: frame('down')}},
            {op: 'wait', result: {frames: 6, ms: 100}},
            {op: 'input', result: {applied: 1, frame: frame('up')}},
            {op: 'capture', result: {frame: frame('after')}}
        ]
    })
    const images = stepped.content.filter(part => part.type === 'image')
    assert.deepEqual(
        images.map(part => part.data),
        ['after']
    )

    const answered = JSON.parse(stepped.content[0].text)
    assert.equal(answered.ops[0].result.applied, 1)
    assert.equal(answered.ops[0].result.frame, undefined)
    assert.equal(answered.ops[2].result.frame, undefined)
    assert.equal(answered.ops[3].result.frame.width, 640)

    const alone = toolResult({
        ops: [
            {op: 'input', result: {applied: 1, frame: frame('only')}},
            {op: 'inspect_node', result: {name: 'Player'}}
        ]
    })
    assert.deepEqual(
        alone.content.filter(part => part.type === 'image').map(part => part.data),
        ['only']
    )

    assert.equal(stepped.details.ops[0].result.frame.data, 'down')
    assert.equal(stepped.details.ops[2].result.frame.data, 'up')

    const launched = toolResult({
        ops: [
            {op: 'run', result: {running: true, frame: frame('launch')}},
            {op: 'capture', result: {frame: frame('later')}}
        ]
    })
    assert.deepEqual(
        launched.content.filter(part => part.type === 'image').map(part => part.data),
        ['launch', 'later']
    )
})
