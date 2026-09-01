import type * as Monaco from 'monaco-editor'
import {goferTheme} from '../theme/gofer'

export const GOFER_EDITOR_THEME = 'gofer-dark'

function dark(name: string): string {
    const value = goferTheme.tokens[name]
    if (value === undefined) throw new Error(`The gofer theme has no token ${name}`)
    const match = /^light-dark\(\s*[^,]+,\s*(.+)\s*\)$/.exec(value)
    return (match?.[1] ?? value).trim()
}

function rule(token: string, name: string): Monaco.editor.ITokenThemeRule {
    return {token, foreground: dark(name).replace('#', '')}
}

export function goferEditorTheme(): Monaco.editor.IStandaloneThemeData {
    const background = dark('--color-syntax-background')
    const border = dark('--color-border')
    const popover = dark('--color-background-popover')
    return {
        base: 'vs-dark',
        inherit: true,
        rules: [
            rule('', '--color-syntax-variable'),
            rule('comment', '--color-syntax-comment'),
            rule('keyword', '--color-syntax-keyword'),
            rule('constant', '--color-syntax-constant'),
            rule('type', '--color-syntax-type'),
            rule('identifier', '--color-syntax-variable'),
            rule('number', '--color-syntax-number'),
            rule('string', '--color-syntax-string'),
            rule('string.quote', '--color-syntax-string'),
            rule('string.escape', '--color-syntax-constant'),
            rule('operator', '--color-syntax-operator'),
            rule('delimiter', '--color-syntax-punctuation'),
            rule('annotation', '--color-syntax-attribute'),
            rule('variable.predefined', '--color-syntax-property')
        ],
        colors: {
            'editor.background': background,
            'editor.foreground': dark('--color-syntax-variable'),
            'editorGutter.background': background,
            'editorLineNumber.foreground': dark('--color-text-disabled'),
            'editorLineNumber.activeForeground': dark('--color-text-primary'),
            'editor.lineHighlightBackground': dark('--color-overlay-hover'),
            'editorWhitespace.foreground': dark('--color-syntax-punctuation'),
            'editorIndentGuide.background1': border,
            'editorWidget.background': popover,
            'editorWidget.border': border,
            'editorSuggestWidget.background': popover,
            'editorHoverWidget.background': popover,
            'editorError.foreground': dark('--color-error'),
            'editorWarning.foreground': dark('--color-warning')
            // The diff fills are left to vs-dark: it paints them over the code, so they
            // have to be translucent, and no theme token is.
        }
    }
}
