import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {NodeExecutionEnv, createReadTool} from '@earendil-works/pi-agent-core/node'

import {NUMBERED_NOTE, numberLines, withLineNumbers} from './numbered-read.mjs'

const SCRIPT = ['extends Node2D', '', 'func _ready() -> void:', '\tprint("hi")', ''].join('\n')
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
)

async function workspace(files) {
    const dir = await mkdtemp(join(tmpdir(), 'numbered-read-'))
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
    return {env: new NodeExecutionEnv({cwd: dir})}
}

test('every line carries its number, and the trailing newline is not a line', () => {
    assert.equal(
        numberLines(SCRIPT),
        ['1\textends Node2D', '2', '3\tfunc _ready() -> void:', '4\t\tprint("hi")'].join('\n')
    )
})

test('a page read from an offset counts from that offset', () => {
    assert.equal(numberLines('a\nb', {from: 41}), '41\ta\n42\tb')
})

test('an empty answer stays empty, and a CRLF file keeps its returns', () => {
    assert.equal(numberLines(''), '')
    assert.equal(numberLines('a\r\nb\r\n'), '1\ta\r\n2\tb\r')
})

test("the tool's own note stays as it was, and only where the tool wrote one", () => {
    const showing = '\n\n[Showing lines 1-2 of 9. Use offset=3 to continue.]'
    assert.equal(numberLines(`a\nb${showing}`, {truncated: true}), `1\ta\n2\tb${showing}`)
    const more = '\n\n[7 more lines in file. Use offset=3 to continue.]'
    assert.equal(numberLines(`a\nb${more}`, {limited: true}), `1\ta\n2\tb${more}`)
    // the same text as the last line of a whole file is a line like any other
    assert.equal(numberLines(`a\nb${more}`), `1\ta\n2\tb\n3\n4\t${more.slice(2)}`)
})

test('a line too long to show, and an omitted bitmap, are not listings', () => {
    const tooLong = "[Line 1 is 60KB, exceeds 50KB limit. Use bash: sed -n '1p' x | head -c 51200]"
    assert.equal(numberLines(tooLong), tooLong)
    const bmp =
        'Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]'
    assert.equal(numberLines(bmp), bmp)
    assert.equal(
        numberLines('[Line 7 is a note about parsing]\nb'),
        '1\t[Line 7 is a note about parsing]\n2\tb'
    )
})

test('the real read tool answers numbered text, from the offset it was given, and says so', async () => {
    const context = await workspace({'main.gd': SCRIPT})
    const tool = withLineNumbers(createReadTool())
    assert.ok(tool.description.endsWith(NUMBERED_NOTE))
    const whole = await tool.execute('1', {path: 'main.gd'}, undefined, undefined, context)
    assert.equal(whole.content[0].text.split('\n')[3], '4\t\tprint("hi")')
    const page = await tool.execute(
        '2',
        {path: 'main.gd', offset: 3, limit: 1},
        undefined,
        undefined,
        context
    )
    assert.match(page.content[0].text, /^3\tfunc _ready\(\) -> void:\n\n\[2 more lines in file/u)
})

test('a file the tool cuts short is numbered to agree with its own note', async () => {
    const lines = Array.from({length: 2500}, (_, i) => `line ${String(i + 1)}`)
    const context = await workspace({'big.gd': `${lines.join('\n')}\n`})
    const tool = withLineNumbers(createReadTool())
    const answer = await tool.execute('1', {path: 'big.gd'}, undefined, undefined, context)
    const shown = answer.content[0].text.split('\n')
    assert.equal(shown[1999], '2000\tline 2000')
    assert.equal(shown.at(-1), '[Showing lines 1-2000 of 2501. Use offset=2001 to continue.]')
    const rest = await tool.execute(
        '2',
        {path: 'big.gd', offset: 2001},
        undefined,
        undefined,
        context
    )
    assert.equal(rest.content[0].text.split('\n')[0], '2001\tline 2001')
})

test('an image read is handed over untouched', async () => {
    const context = await workspace({'dot.png': PNG})
    const tool = withLineNumbers(createReadTool())
    const answer = await tool.execute('1', {path: 'dot.png'}, undefined, undefined, context)
    assert.equal(answer.content[0].text, 'Read image file [image/png]')
    assert.equal(answer.content[1].type, 'image')
})
