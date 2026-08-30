import {defineTheme} from '@astryxdesign/core/theme'
import {neutralTheme} from '@astryxdesign/theme-neutral/built'

export const goferTheme = defineTheme({
    name: 'gofer',
    extends: neutralTheme,
    radius: {base: 4, multiplier: 0.25},
    typography: {
        body: {
            family: 'Figtree Variable',
            fallbacks:
                "Figtree, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
        }
    },
    tokens: {
        '--color-text-secondary': ['#454545', '#c2c2c2'],
        '--color-text-disabled': ['#636363', '#a1a1a1'],
        '--color-background-body': ['#e1e1e1', '#1b1b1b'],
        '--color-background-surface': ['#ebebeb', '#262626'],
        '--color-background-card': ['#f5f5f5', '#2e2e2e'],
        '--color-background-popover': ['#ffffff', '#363636'],
        '--color-border': ['#868686', '#6f6f6f'],
        '--color-border-emphasized': ['#767676', '#8a8a8a'],
        '--color-accent': ['#0064e0', '#2694fe'],
        '--color-text-accent': ['#0064e0', '#3e9efb'],
        '--color-icon-accent': ['#0064e0', '#2694fe'],
        '--color-accent-muted': ['#0082fb33', '#0082fb3f'],
        '--radius-chat': '3px'
    },
    components: {
        tab: {base: {paddingInline: '8px'}},
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
