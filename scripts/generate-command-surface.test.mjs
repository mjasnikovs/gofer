import assert from 'node:assert/strict'
import test from 'node:test'
import {Readable} from 'node:stream'
import {collectText} from './generate-command-surface.mjs'

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
