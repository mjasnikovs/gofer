import type * as Monaco from 'monaco-editor'
import {goferTheme} from '../theme/gofer'

/**
 * Monaco's colours, taken from Gofer's own theme.
 *
 * Monaco cannot read CSS custom properties — a theme is a plain object of hex strings — so the
 * values are lifted out of the built theme instead of being written twice. The editor is always
 * dark, whichever mode the rest of the application is in: code is read against a near-black page
 * the way every Godot and desktop editor shows it, so only the dark half of each token is used.
 */

export const GOFER_EDITOR_THEME = 'gofer-dark'

/**
 * The dark half of a theme token. Tokens that vary by mode are written `light-dark(a, b)`; a token
 * that does not vary has the one value it has. A name the built theme no longer carries is a
 * mistake in this file rather than something to paint over, so it is reported instead of guessed.
 */
function dark(name: string): string {
    const value = goferTheme.tokens[name]
    if (value === undefined) throw new Error(`The gofer theme has no token ${name}`)
    const match = /^light-dark\(\s*[^,]+,\s*(.+)\s*\)$/.exec(value)
    return (match?.[1] ?? value).trim()
}

/** Monaco writes colours without the leading `#`. */
function rule(token: string, name: string): Monaco.editor.ITokenThemeRule {
    return {token, foreground: dark(name).replace('#', '')}
}

export function goferEditorTheme(): Monaco.editor.IStandaloneThemeData {
    const background = dark('--color-syntax-background')
    const border = dark('--color-border')
    const popover = dark('--color-background-popover')
    return {
        // Inheriting keeps every widget Gofer does not name — the find box, the peek view, the
        // scrollbar — on vs-dark's dark values rather than falling back to the light defaults.
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
            // GDScript's own two: `@export` and friends, and `$Node`/`%Unique` scene paths.
            rule('annotation', '--color-syntax-attribute'),
            rule('variable.predefined', '--color-syntax-property')
        ],
        colors: {
            'editor.background': background,
            'editor.foreground': dark('--color-syntax-variable'),
            'editorGutter.background': background,
            // Punctuation is tuned to disappear between the tokens it separates, which on the
            // editor's near-black page left the gutter at 2.53:1 — a column of numbers nobody can
            // read is a column that may as well not be drawn. The weakest text role carries it
            // instead: 6.1:1 here, still plainly quieter than the code beside it.
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
            'editorWarning.foreground': dark('--color-warning'),
            'diffEditor.insertedTextBackground': dark('--color-success-muted'),
            'diffEditor.removedTextBackground': dark('--color-error-muted')
        }
    }
}
