import assert from 'node:assert/strict'
import test from 'node:test'

import {elidePackedLiterals, holdsPackedLiterals, withoutPackedLiterals} from './scene-text.mjs'

/** The line as Godot writes it, at the length a live project's tilemap wrote it. */
const TILE_DATA = `tile_map_data = PackedByteArray("${'AAAAAAAAAAALAAwA'.repeat(2379)}")`

test('a tilemap line is replaced by its shape, and the scene around it is not', () => {
    const scene = [
        '[gd_scene format=4 uid="uid://ci0257e7da2eh"]',
        '',
        '[ext_resource type="Script" path="res://scripts/main.gd" id="1_lquwl"]',
        '',
        '[node name="Terrain" type="TileMapLayer" parent="."]',
        TILE_DATA,
        'position = Vector2(640, 360)'
    ].join('\n')

    const elided = elidePackedLiterals(scene)
    assert.ok(scene.length > 38_000, 'the fixture has to be the size the real one was')
    assert.ok(elided.length < 1000, `elided to ${String(elided.length)} characters`)
    assert.match(
        elided,
        /PackedByteArray\(<\d+ characters elided; read the cells with godot_node get_cells>\)/u
    )
    // Everything a reader came for survives: the header, the resources, the nodes, the properties.
    for (const kept of [
        '[gd_scene format=4 uid="uid://ci0257e7da2eh"]',
        'res://scripts/main.gd',
        '[node name="Terrain" type="TileMapLayer" parent="."]',
        'position = Vector2(640, 360)'
    ])
        assert.ok(elided.includes(kept), `${kept} was taken out too`)
})

test('a literal short enough to read is left alone', () => {
    const scene =
        'animations = PackedStringArray("idle", "walk", "run")\npoints = PackedVector2Array(0, 0, 8, 0, 8, 8)\n'
    assert.equal(elidePackedLiterals(scene), scene)
})

test('a file with nothing packed in it passes through unchanged', () => {
    const script = 'extends Node2D\n\nfunc _ready() -> void:\n\tprint("hello")\n'
    assert.equal(elidePackedLiterals(script), script)
    assert.equal(elidePackedLiterals(undefined), undefined)
})

test('only the files the write tool refuses are rewritten', () => {
    for (const path of ['main.tscn', 'a.scn']) assert.ok(holdsPackedLiterals(path), path)
    // A `.tres` holds packed literals too, and the agent is allowed to write one. Reading it with
    // its bytes replaced by a summary and writing it back would put the summary on disk.
    for (const path of [
        'resources/tiles.tres',
        'x.res',
        'scripts/main.gd',
        'project.godot',
        'assets/tiles.png',
        undefined
    ])
        assert.ok(!holdsPackedLiterals(path), `${String(path)} must not be rewritten`)
})

test('a literal the read tool cut in half is still elided', () => {
    // `read` caps its answer at 50KB, mid-line, so the file this feature exists for arrives without
    // the literal's closing paren. Requiring one passed exactly those through whole.
    const cut = `tile_map_data = PackedByteArray("${'AAAA'.repeat(15_000)}`
    const elided = elidePackedLiterals(cut)
    assert.ok(cut.length > 50_000, 'the fixture has to be past the read cap')
    assert.ok(elided.length < 200, `elided to ${String(elided.length)} characters`)
    assert.doesNotMatch(elided, /AAAA/u)

    // And a closed literal still ends with its own paren rather than losing it.
    assert.match(
        elidePackedLiterals(`x = PackedByteArray("${'A'.repeat(500)}")\ny = 1`),
        /elided[^)]*\)\ny = 1$/u
    )
})

test('the wrapped read elides a scene and leaves every other answer alone', async () => {
    const answers = {
        'main.tscn': {content: [{type: 'text', text: TILE_DATA}]},
        'scripts/main.gd': {content: [{type: 'text', text: TILE_DATA}]},
        'assets/tiles.png': {
            content: [
                {type: 'text', text: 'Read image file [image/png]'},
                {type: 'image', data: 'AAAA', mimeType: 'image/png'}
            ]
        }
    }
    const read = withoutPackedLiterals({
        name: 'read',
        execute: async (_id, {path}) => answers[path]
    })

    const scene = await read.execute('1', {path: 'main.tscn'})
    assert.ok(scene.content[0].text.length < 200, 'the scene is elided')

    // A `.gd` holding the same characters is not a scene, so nothing is taken out of it.
    const script = await read.execute('2', {path: 'scripts/main.gd'})
    assert.equal(script.content[0].text, TILE_DATA)

    // An image answer keeps its parts, in order, with the pixels untouched.
    const image = await read.execute('3', {path: 'assets/tiles.png'})
    assert.deepEqual(image, answers['assets/tiles.png'])

    // An answer in a shape this does not understand is handed back rather than reshaped.
    const odd = withoutPackedLiterals({name: 'read', execute: async () => 'not a tool answer'})
    assert.equal(await odd.execute('4', {path: 'main.tscn'}), 'not a tool answer')
})
