import {describe, expect, it} from 'vitest'
import {goferEditorTheme} from './monaco-theme'

const HEX = /^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

describe('goferEditorTheme', () => {
    it('paints the editor on the theme’s dark page', () => {
        const theme = goferEditorTheme()
        expect(theme.base).toBe('vs-dark')
        expect(theme.colors['editor.background']).toBe('#171719')
        expect(theme.colors['editor.foreground']).toBe('#ababb0')
    })

    it('takes the dark half of every colour, in the form Monaco reads', () => {
        const theme = goferEditorTheme()
        for (const rule of theme.rules) {
            expect(rule.foreground, rule.token).toMatch(HEX)
        }
        for (const [name, color] of Object.entries(theme.colors)) {
            expect(color, name).toMatch(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
        }
    })

    it('colours the tokens GDScript actually emits', () => {
        const tokens = goferEditorTheme().rules.map(rule => rule.token)
        expect(tokens).toEqual(
            expect.arrayContaining([
                'comment',
                'keyword',
                'type',
                'string',
                'number',
                'annotation',
                'variable.predefined'
            ])
        )
    })
})
