import {describe, expect, it} from 'vitest'
import {buildPathTree, filterSceneTree, formatGodotValue} from './godot-format'
import type {GodotNode} from '../models/godot'

const scene: GodotNode = {
    name: 'Main',
    type: 'Node2D',
    path: 'Main',
    children: [
        {
            name: 'Player',
            type: 'CharacterBody2D',
            path: 'Main/Player',
            children: [
                {name: 'Hitbox', type: 'CollisionShape2D', path: 'Main/Player/Hitbox', children: []}
            ]
        },
        {name: 'Coin', type: 'Area2D', path: 'Main/Coin', children: []}
    ]
}

describe('formatGodotValue', () => {
    it('prints each primitive as its own text', () => {
        expect(formatGodotValue({type: 'null', value: null})).toBe('null')
        expect(formatGodotValue({type: 'bool', value: true})).toBe('true')
        expect(formatGodotValue({type: 'bool', value: false})).toBe('false')
        expect(formatGodotValue({type: 'int', value: 42})).toBe('42')
        expect(formatGodotValue({type: 'float', value: 1.5})).toBe('1.5')
        expect(formatGodotValue({type: 'string', value: 'res://main.tscn'})).toBe('res://main.tscn')
    })

    // A value the addon sent in a shape this version does not know must not reach the screen as
    // `[object Object]`, so anything that is not a primitive prints as nothing at all.
    it('prints a non-primitive payload as nothing', () => {
        expect(formatGodotValue({type: 'string', value: {unexpected: true}})).toBe('')
        expect(formatGodotValue({type: 'int', value: undefined})).toBe('')
    })

    it('prints an array by its entries, tagged or not', () => {
        expect(
            formatGodotValue({
                type: 'array',
                value: [{type: 'int', value: 1}, {type: 'string', value: 'two'}, {plain: 'three'}]
            })
        ).toBe('[1, two, ]')
        expect(formatGodotValue({type: 'array', value: 'not an array'})).toBe('[]')
    })

    it('prints a dictionary as its key and value pairs', () => {
        expect(
            formatGodotValue({
                type: 'dictionary',
                value: [
                    {key: {type: 'string', value: 'speed'}, value: {type: 'float', value: 220}},
                    {key: {type: 'int', value: 7}, value: {type: 'bool', value: false}}
                ]
            })
        ).toBe('{speed: 220, 7: false}')
        expect(formatGodotValue({type: 'dictionary', value: null})).toBe('{}')
    })

    it('names a resource and a node by their class and path', () => {
        expect(
            formatGodotValue({
                type: 'resource',
                value: {resourceType: 'Texture2D', path: 'res://art/coin.png'}
            })
        ).toBe('Texture2D res://art/coin.png')
        expect(formatGodotValue({type: 'resource', value: {}})).toBe('Resource ')
        expect(
            formatGodotValue({type: 'node', value: {nodeType: 'Camera2D', path: 'Main/Camera2D'}})
        ).toBe('Camera2D Main/Camera2D')
        expect(formatGodotValue({type: 'node', value: {}})).toBe('Node ')
    })

    it('names an object by its class, and an opaque value by whatever it carries', () => {
        expect(formatGodotValue({type: 'object', value: {className: 'PlayerStats'}})).toBe(
            'PlayerStats'
        )
        expect(formatGodotValue({type: 'object', value: {}})).toBe('Object')
        expect(formatGodotValue({type: 'opaque', value: {text: '<Callable>'}})).toBe('<Callable>')
        expect(formatGodotValue({type: 'opaque', value: {typeName: 'Callable'}})).toBe('Callable')
        expect(formatGodotValue({type: 'opaque', value: {}})).toBe('')
    })

    // Vectors, colors, transforms, and quaternions all arrive as flat number arrays, so one
    // fallback prints every one of them by the type tag the addon gave it.
    it('prints an unknown type with numbers as a constructor call', () => {
        expect(formatGodotValue({type: 'vector2', value: [1, 2]})).toBe('vector2(1, 2)')
        expect(formatGodotValue({type: 'color', value: [1, 0, 0, 1]})).toBe('color(1, 0, 0, 1)')
        expect(formatGodotValue({type: 'rid', value: 9})).toBe('9')
    })
})

describe('buildPathTree', () => {
    it('folds a flat listing into folders, sorted before files', () => {
        expect(
            buildPathTree([
                'project.godot',
                'scripts/player.gd',
                'art/coin.png',
                'scripts/enemies/slime.gd'
            ])
        ).toEqual([
            {
                name: 'art',
                path: 'art',
                isDirectory: true,
                children: [
                    {name: 'coin.png', path: 'art/coin.png', isDirectory: false, children: []}
                ]
            },
            {
                name: 'scripts',
                path: 'scripts',
                isDirectory: true,
                children: [
                    {
                        name: 'enemies',
                        path: 'scripts/enemies',
                        isDirectory: true,
                        children: [
                            {
                                name: 'slime.gd',
                                path: 'scripts/enemies/slime.gd',
                                isDirectory: false,
                                children: []
                            }
                        ]
                    },
                    {
                        name: 'player.gd',
                        path: 'scripts/player.gd',
                        isDirectory: false,
                        children: []
                    }
                ]
            },
            {name: 'project.godot', path: 'project.godot', isDirectory: false, children: []}
        ])
    })

    it('gives a folder named twice one node', () => {
        const [scripts] = buildPathTree(['scripts/a.gd', 'scripts/b.gd'])

        expect(buildPathTree([])).toEqual([])
        expect(scripts?.children.map(child => child.name)).toEqual(['a.gd', 'b.gd'])
    })
})

describe('filterSceneTree', () => {
    it('returns the whole tree when nothing is being looked for', () => {
        expect(filterSceneTree(scene, '   ')).toBe(scene)
    })

    it('keeps the branch that reaches a match, so the match keeps its path', () => {
        const filtered = filterSceneTree(scene, 'hitbox')

        expect(filtered?.name).toBe('Main')
        expect(filtered?.children.map(child => child.name)).toEqual(['Player'])
        expect(filtered?.children[0]?.children.map(child => child.name)).toEqual(['Hitbox'])
    })

    it('matches a class as readily as a name', () => {
        expect(filterSceneTree(scene, 'area2d')?.children.map(child => child.name)).toEqual([
            'Coin'
        ])
    })

    it('reports nothing when the filter reaches no node', () => {
        expect(filterSceneTree(scene, 'tilemap')).toBeUndefined()
    })
})
