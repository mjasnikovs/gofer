import {defineTheme} from '@astryxdesign/core/theme'
import {neutralTheme} from '@astryxdesign/theme-neutral/built'

export const goferTheme = defineTheme({
    name: 'gofer',
    extends: neutralTheme,
    radius: {base: 4, multiplier: 0.25},
    tokens: {
        '--color-text-secondary': ['#525252', '#d4d4d4'],
        '--color-text-disabled': ['#525252', '#d4d4d4']
    }
})
