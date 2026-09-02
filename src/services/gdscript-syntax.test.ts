import {describe, expect, it} from 'vitest'
import {TOKEN_TYPES, flatTokensToLines} from '@astryxdesign/core/CodeBlock'
import {gdscriptFenceLanguage, tokenizeGdscript} from './gdscript-syntax'

const SAMPLE = [
    '@export var speed := 5.0',
    'const MASK = 0xFF',
    'const BITS = 0b1010',
    'const BIG = 1_000',
    'const TINY = 1.5e-3',
    '',
    'func _is_open(p: Vector2) -> bool:',
    '\t# a comment about self',
    '\tvar c: Vector2i = Vector2i(floori(p.x), floori(p.y))',
    '\tvar hp = %Health',
    '\tvar node = $Player/Sprite2D',
    '\tvar odd = hp % 2',
    '\tvar text = "a \\" b"',
    "\tvar other = 'single'",
    '\tprint(self, true, PI)',
    '\treturn not nav.is_point_solid(c)',
    '',
    'var doc = """',
    'line two',
    'line three"""'
].join('\n')

function typesOf(code: string, literal: string) {
    return tokenizeGdscript(code)
        .filter(token => code.slice(token.start, token.end) === literal)
        .map(token => token.type)
}

describe('gdscriptFenceLanguage', () => {
    it('resolves every alias, whatever the case', () => {
        expect(gdscriptFenceLanguage('gd')).toBe('gdscript')
        expect(gdscriptFenceLanguage('GDScript')).toBe('gdscript')
        expect(gdscriptFenceLanguage('Godot')).toBe('gdscript')
    })

    it('leaves every other fence alone', () => {
        expect(gdscriptFenceLanguage('plaintext')).toBeUndefined()
        expect(gdscriptFenceLanguage('python')).toBeUndefined()
        expect(gdscriptFenceLanguage('')).toBeUndefined()
        expect(gdscriptFenceLanguage(undefined)).toBeUndefined()
    })
})

describe('tokenizeGdscript', () => {
    it('names a declaration the way the editor does', () => {
        const code = 'func _ready() -> void:'
        expect(tokenizeGdscript(code)).toEqual([
            {type: 'keyword', start: 0, end: 4},
            {type: 'function', start: 5, end: 11},
            {type: 'punctuation', start: 11, end: 12},
            {type: 'punctuation', start: 12, end: 13},
            {type: 'operator', start: 14, end: 16},
            {type: 'type', start: 17, end: 21},
            {type: 'operator', start: 21, end: 22}
        ])
    })

    it('separates annotations, keywords, types and numbers', () => {
        expect(typesOf(SAMPLE, '@export')).toEqual(['attribute'])
        expect(typesOf(SAMPLE, 'var')).toContain('keyword')
        expect(typesOf(SAMPLE, 'Vector2i')).toEqual(['type', 'type'])
        expect(typesOf(SAMPLE, '5.0')).toEqual(['number'])
        expect(typesOf(SAMPLE, '0xFF')).toEqual(['number'])
        expect(typesOf(SAMPLE, '0b1010')).toEqual(['number'])
        expect(typesOf(SAMPLE, '1_000')).toEqual(['number'])
        expect(typesOf(SAMPLE, '1.5e-3')).toEqual(['number'])
        expect(typesOf(SAMPLE, 'self')).toEqual(['constant'])
        expect(typesOf(SAMPLE, 'PI')).toEqual(['constant'])
        expect(typesOf(SAMPLE, 'floori')).toEqual(['function', 'function'])
    })

    it('tells a unique-name path from a modulo', () => {
        expect(typesOf(SAMPLE, '%Health')).toEqual(['property'])
        expect(typesOf(SAMPLE, '$Player/Sprite2D')).toEqual(['property'])
        expect(typesOf(SAMPLE, '%')).toEqual(['operator'])
    })

    it('keeps a comment and both quote styles whole', () => {
        expect(typesOf(SAMPLE, '# a comment about self')).toEqual(['comment'])
        expect(typesOf(SAMPLE, '"a \\" b"')).toEqual(['string'])
        expect(typesOf(SAMPLE, "'single'")).toEqual(['string'])
    })

    it('closes an unterminated string at the end of its line', () => {
        const code = 'var half = "still typ'
        expect(typesOf(code, '"still typ')).toEqual(['string'])
    })

    it('breaks a block string at every newline', () => {
        const tokens = tokenizeGdscript(SAMPLE).filter(token =>
            SAMPLE.slice(token.start, token.end).includes('line')
        )
        expect(tokens.map(token => SAMPLE.slice(token.start, token.end))).toEqual([
            'line two',
            'line three"""'
        ])
    })

    it('emits ascending, non-overlapping tokens that never cross a newline', () => {
        let previous = 0
        for (const token of tokenizeGdscript(SAMPLE)) {
            expect(token.start).toBeGreaterThanOrEqual(previous)
            expect(token.end).toBeGreaterThan(token.start)
            expect(SAMPLE.slice(token.start, token.end)).not.toContain('\n')
            previous = token.end
        }
    })

    it('emits only token types Astryx can colour', () => {
        const types = new Set(tokenizeGdscript(SAMPLE).map(token => token.type))
        for (const type of types) expect(TOKEN_TYPES).toContain(type)
    })

    it('survives the split Astryx does before rendering', () => {
        const lines = SAMPLE.split('\n')
        flatTokensToLines(tokenizeGdscript(SAMPLE), SAMPLE).forEach((line, index) => {
            for (const token of line) {
                expect(token.start).toBeGreaterThanOrEqual(0)
                expect(token.end).toBeLessThanOrEqual(lines[index]?.length ?? 0)
            }
        })
    })

    it('has nothing to say about an empty block', () => {
        expect(tokenizeGdscript('')).toEqual([])
    })
})
