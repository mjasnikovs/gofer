import {defineTheme} from '@astryxdesign/core/theme'
import {stoneTheme} from '@astryxdesign/theme-stone/built'

export const goferTheme = defineTheme({
    name: 'gofer',
    extends: stoneTheme,
    radius: {base: 4, multiplier: 0.25},
    typography: {
        body: {
            family: 'Figtree Variable',
            fallbacks:
                "Figtree, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        },
        // Stone asks for JetBrains Mono, which nothing here loads.
        code: {
            family: 'ui-monospace',
            fallbacks: '"SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
        }
    },
    tokens: {
        // Stone's own stops fail WCAG AA on the surfaces gofer puts them on — the
        // placeholder disappears. Moved along the same H=291 ramp until axe is green
        // on every background and the 12 L* text ramp still holds.
        '--color-text-secondary': ['#46464b', '#b8b8be'],
        '--color-text-disabled': ['#6a6a6f', '#909095'],
        // Stone's dark border is 2.66:1 on the surface; WCAG 1.4.11 wants 3:1 for a
        // control edge, and axe never checks it because it is not text.
        '--color-border-emphasized': ['#83838a', '#77777c'],
        // Tokens rather than a `color.accent` seed, which would re-tint every neutral.
        // Stone bakes all five as literals, so each has to be moved by hand.
        '--color-accent': ['#00695c', '#2fa88f'],
        '--color-on-accent': ['#ffffff', '#1b1b1f'],
        // Re-picked alpha: stone's byte was tuned against a near-white accent, and the
        // same alpha on a mid-tone teal lifts half as far.
        '--color-accent-muted': ['#00695c19', '#2fa88f38'],
        '--color-text-accent': ['#00695c', '#2fa88f'],
        '--color-icon-accent': ['#00695c', '#2fa88f'],
        '--radius-chat': '3px'
    },
    components: {
        // Stone rounds buttons to a full pill, which fights a dense tool workspace.
        button: {base: {borderRadius: 'var(--radius-element)'}},
        tab: {base: {paddingInline: '8px'}},
        // Stone remaps the muted status fills for Banner and FieldStatus but not here.
        'chat-composer': {
            base: {
                '--color-error-muted': 'var(--color-background-red)',
                '--color-warning-muted': 'var(--color-background-yellow)'
            }
        },
        // A filled chip on each of a reply's five paths turned the sentence into blocks.
        // Scoped to the default colour, or it would beat `Code color='inherit'` too.
        code: {
            'color:primary': {
                backgroundColor: 'transparent',
                paddingInline: '0',
                color: 'var(--color-text-accent)',
                fontWeight: 'var(--font-weight-medium)'
            }
        },
        'text-input': {base: {backgroundColor: 'var(--color-background-body)'}},
        'tree-list-item': {
            selected: {
                backgroundColor: 'var(--color-overlay-pressed)',
                boxShadow: 'inset 2px 0 0 0 var(--color-accent)'
            }
        },
        'tree-list-item-label': {selected: {fontWeight: 'var(--font-weight-semibold)'}},
        'chat-message-bubble': {
            base: {maxWidth: '100%'},
            'variant:filled': {backgroundColor: 'var(--color-background-popover)'},
            'variant:ghost': {paddingInline: '0'}
        }
    }
})
