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

    // The value that is too big is what gets cut, so the answer around it is still an answer: it
    // parses, the key is still there, and the cut says how long the value really was.
    const huge = toolResult({nodes: 'x'.repeat(40_000)})
    assert.equal(huge.content.length, 1)
    assert.ok(huge.content[0].text.length <= 24_000)
    assert.match(JSON.parse(huge.content[0].text).nodes, /… \[truncated, 40000 characters\]$/u)
    assert.equal(huge.details.nodes.length, 40_000)

    // A call is a list, and one enormous entry used to take the whole list down with it: the
    // serialized answer was sliced, so the second and third operations were not answered, not
    // refused, and not mentioned. Every entry survives now, and only the value that was too big
    // is short.
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

    // Several large values in one answer are each cut, rather than the first one paying for all.
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

    // One length for all of them, not one budget each. A hundred scripts come back as a hundred
    // paths with their first lines, rather than the first one whole and ninety-nine missing.
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

    // An answer that is repetition rather than one big value: the list loses its tail, and every
    // entry that stays is whole.
    //
    // Capping cannot reach the budget here and every cap makes it worse: `godot_node inspect` on a
    // Control is four hundred short properties whose longest string is 35 characters, and
    // `… [truncated, N characters]` is 28. Measured on exactly that answer before this: the search
    // bottomed out, every property name became `… [truncated, 35 characters]`, the result was
    // sliced anyway, and what reached the model was 24,031 characters of unparseable rubble
    // claiming 45,680 characters had been dropped — more than the answer had ever held.
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

    // A short list is left whole, because cutting one makes the answer bigger.
    //
    // `… [truncated, N more entries]` is 32 characters and `[12.5,34.25]` is 12, so an encoded
    // vector2 costs more to shorten than to keep — and every list was shortened whether it helped
    // or not. Measured on four hundred vector2 properties keyed by name: 31,833 characters in,
    // 24,031 out, every pair replaced by the marker, and the result sliced anyway and unparseable.
    // The same rubble the list-shortening was written to stop the string capping making.
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

    // Nothing long enough to cut, no list to shorten, and still too big: the slice is the answer of
    // last resort, and it is the behaviour every oversized answer used to get.
    const many = toolResult(Object.fromEntries(Array.from({length: 4_000}, (_, i) => [`k${i}`, i])))
    assert.ok(many.content[0].text.length <= 24_100)
    assert.match(many.content[0].text, /… \[truncated, \d+ characters\]$/u)
})

/**
 * A picture a text-only model cannot see costs it a sentence, not the whole request.
 *
 * `read` hands back a real image part for a PNG, and llama.cpp refuses the request rather than the
 * part it cannot use: one live turn died on `failed to process mtmd chunk` after the agent read a
 * tileset to match the game's art. Which is exactly what an agent asked about a layout will do.
 */
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

    // A model that was declared as taking images keeps them, and a result with none is untouched.
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
    // Four live turns went into loops no wording escaped — twelve, thirteen, seventeen and
    // twenty-four identical calls, each answered identically. The lever left is a different
    // sentence rather than a better one.
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
    // And it does not guess why. The first wording said "an object coming apart as it is written",
    // and a live turn met it on a `method_not_found` about a method that was genuinely not there.
    assert.doesNotMatch(said[2], /coming apart/u)

    // A different call is a different count, and a different answer to the same call is a caller
    // waiting rather than a caller stuck: `runtime.wait` timing out twice carries different output.
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

    // The same call with its keys in another order is the same call, not a new one.
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

    // A cancelled call is not a refused one: the turn was stopped, and the caller wrote nothing.
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

    // And a call that succeeds is not counted at all.
    const working = {name: 'read', execute: () => Promise.resolve({content: []})}
    assert.deepEqual(await withoutRepeatingARefusal(working).execute('id', {}), {content: []})
})

test('the two decorators stack in either order', async () => {
    // Each wrap copies the tool's `execute` as it is, so the inner behaviour stays live inside
    // the outer: whichever decorator is on the outside, the picture is still stripped and the
    // refusal is still counted.
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
