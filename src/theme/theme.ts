import {defineTheme} from '@astryxdesign/core/theme'
import {neutralTheme} from '@astryxdesign/theme-neutral/built'

export const goferTheme = defineTheme({
    name: 'gofer',
    extends: neutralTheme,
    radius: {base: 4, multiplier: 0.25},
    tokens: {
        /*
         * Three roles, three lightnesses. Making disabled text readable by lifting it onto
         * secondary's exact value bought legibility with meaning: a placeholder, a field's own
         * label, an inactive tab and a static caption all rendered #d4d4d4, so "Ask anything" read
         * as a sentence the user had typed. Each step here clears the twelve-point role distance,
         * and disabled still holds 4.7:1 on the panel surface, which is more than the neutral
         * theme's own #525252 ever did.
         */
        '--color-text-secondary': ['#525252', '#c2c2c2'],
        '--color-text-disabled': ['#7d7d7d', '#8f8f8f'],
        /*
         * Every rule in the window — the panel dividers, the header's underline, a card's outline —
         * is drawn with this one token, and the neutral theme spends it as a translucent white that
         * composites to #3c3c3c on the panel surface: 1.37:1, which is a line you can only find if
         * you already know it is there. These are solid so the gate can measure them, and both land
         * at 3:1 on the surface they are drawn on, the bar WCAG 1.4.11 sets for a boundary a user
         * has to find in order to work a control.
         */
        '--color-border': ['#949494', '#6f6f6f'],
        /*
         * The edge a user has to find in order to type in a box. At #525252 on the panel it was
         * 1.93:1, under WCAG 1.4.11, and it has to stay clearly stronger than the plain rule above
         * or the two roles collapse into one weight of line.
         */
        '--color-border-emphasized': ['#767676', '#8a8a8a'],
        /*
         * Gofer takes a hue.
         *
         * The neutral theme's accent is a near-white, six lightness points from body text, so the
         * one colour meant to say "this is the thing to press" said it in the same voice as an
         * ordinary paragraph and emphasis had to be carried entirely by fill and weight. A hue
         * cannot be confused with text at any lightness. The whole accent family moves together —
         * an accent icon or link left grey beside a blue button reads as a different system.
         *
         * The two modes take opposite labels, and that is arithmetic rather than taste. White on
         * this blue is 3.11:1, which axe fails on every screen; getting white to 4.5:1 needs a blue
         * dark enough that its own edge against the panel drops to about 3:1, so the button gains a
         * readable label by losing its outline. Dark type on the bright blue clears both — 5.8:1 for
         * the label, 4.9:1 for the fill against the panel — so the dark half keeps the inherited
         * near-black `--color-on-accent` and only the light half carries white.
         */
        '--color-accent': ['#0064e0', '#2694fe'],
        '--color-text-accent': ['#0064e0', '#3e9efb'],
        '--color-icon-accent': ['#0064e0', '#2694fe'],
        '--color-accent-muted': ['#0082fb33', '#0082fb3f']
    },
    components: {
        /*
         * Gofer's tab strips live in panels, not on pages. The bottom panel's four views measured
         * 321 px of tabs inside a 306 px strip, so `Import` was scroll-clipped through the middle of
         * its last letter with no scrollbar to explain why; the same strip has to hold a badge when
         * a script has errors. Twelve points of side padding is a page-width default. Eight buys
         * back thirty-two, which leaves the strip room to grow rather than only just fitting.
         */
        tab: {base: {paddingInline: '8px'}},
        /*
         * A field with no fill of its own is a rectangle of panel with a line around it: every
         * input in the app measured #262626, exactly the surface behind it, so the box relied
         * entirely on that one hairline to exist. Dropping the fill to the body colour makes the
         * field a well the text sits in, which is a boundary that survives at a glance and does not
         * depend on the border being noticed at all.
         */
        'text-input': {base: {backgroundColor: 'var(--color-background-body)'}},
        /*
         * Which node the inspector is describing was carried by a fill 1.18:1 away from the panel
         * and by nothing else — the selected row's own label rendered at the same colour and the
         * same weight as every row above it. The bar is the signal that survives a glance down a
         * scene tree; the fill and the weight are what confirm it once the eye arrives.
         */
        'tree-list-item': {
            selected: {
                backgroundColor: 'var(--color-overlay-pressed)',
                boxShadow: 'inset 2px 0 0 0 var(--color-accent)'
            }
        },
        'tree-list-item-label': {selected: {fontWeight: 'var(--font-weight-semibold)'}}
    }
})
