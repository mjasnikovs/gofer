import assert from 'node:assert/strict'
import test from 'node:test'
import {Readable} from 'node:stream'
import {collectText} from './generate-command-surface.mjs'
import {UNDECODABLE_TAGS, engineWords, readVocabulary} from './godot-vocabulary.mjs'

// The generated regions carry prose from protocol/*.json, and that prose has em dashes in it. Three
// bytes each, so a pipe can hand over the first one or two of them and the rest next time.
const EM_DASH = Buffer.from('—', 'utf8')

function split(buffer, at) {
    return Readable.from([buffer.subarray(0, at), buffer.subarray(at)])
}

async function read(stream) {
    let text = ''
    collectText(stream, chunk => (text += chunk))
    await new Promise(done => stream.on('end', done))
    return text
}

test('a character split across two chunks survives being read', async () => {
    const whole = Buffer.concat([Buffer.from('a'), EM_DASH, Buffer.from('b')])
    for (let at = 1; at < whole.length; at += 1)
        assert.equal(await read(split(whole, at)), 'a—b', `split after byte ${String(at)}`)
})

test('what a naive concatenation does to the same bytes, so the fix is not mistaken for taste', () => {
    let naive = ''
    for (const chunk of [EM_DASH.subarray(0, 2), EM_DASH.subarray(2)]) naive += chunk
    assert.notEqual(naive, '—')
    assert.match(naive, /�/u)
})

test('the value tags are the engine Variant types minus the four nothing can build', async () => {
    const engine = await readVocabulary()
    const tags = engineWords(engine, 'valueTags', 'the value tags')
    const spelled = engine.variantTypes.map(type => type.string)

    for (const tag of Object.keys(UNDECODABLE_TAGS)) {
        assert.ok(spelled.includes(tag), `${tag} is no longer a Variant type`)
        assert.ok(!tags.includes(tag), `${tag} is offered and cannot be built from JSON`)
    }
    assert.deepEqual(tags, [
        ...spelled.filter(name => !(name in UNDECODABLE_TAGS)),
        // No Variant type of its own: `{path}` is how the wire has always named a resource.
        'Resource'
    ])
    assert.equal(tags.length, spelled.length - Object.keys(UNDECODABLE_TAGS).length + 1)
})
