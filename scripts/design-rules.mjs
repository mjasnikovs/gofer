/**
 * Rules that keep the built theme legible as a hierarchy.
 *
 * A theme can satisfy every contrast requirement for text and still render an interface nobody can
 * read, because reading an interface is reading the differences between its parts: which text is a
 * value and which is a hint, which panel floats over which, which button is the one to press. Those
 * differences live in the gaps between tokens, and a token file is the one place a gap can be
 * measured before anyone has to look at a screenshot to notice it is gone.
 *
 * Distances are in CIE L*, not in contrast ratios. A ratio answers "can this be read at all", which
 * is the wrong question for two greys that are both perfectly readable and three points apart; L*
 * is perceptual lightness, so a fixed distance means the same amount of visible difference at the
 * dark end of the ramp as at the light end.
 */

/** WCAG 1.4.11 asks 3:1 of any boundary a user has to find in order to operate a control. */
const MIN_BOUNDARY_CONTRAST = 3

/**
 * Roles a reader has to tell apart at a glance, so they need more than a nudge. Twelve points is
 * roughly the step between the neutral ramp's own stops — below it, two roles read as one colour
 * that happened to render twice.
 */
const MIN_ROLE_DISTANCE = 12

/** Surfaces are told apart by their edge as much as their fill, so they need far less. */
const MIN_SURFACE_DISTANCE = 3

const HEX = /^#[0-9a-f]{6}$/i

const channel = value => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

/** Relative luminance, the Y of CIE XYZ, as both WCAG contrast and L* are defined against it. */
export function luminance(hex) {
    const [red, green, blue] = [1, 3, 5].map(at =>
        channel(Number.parseInt(hex.slice(at, at + 2), 16))
    )
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** Perceptual lightness, 0 for black and 100 for white. */
export function lightness(hex) {
    const y = luminance(hex)
    return y <= 216 / 24389 ? y * (24389 / 27) : 116 * Math.cbrt(y) - 16
}

export function contrastRatio(one, other) {
    const [darker, lighter] = [luminance(one), luminance(other)].sort((a, b) => a - b)
    return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Reads the pairs out of a built theme.
 *
 * Only `light-dark()` pairs of plain hex are collected: a token that resolves through `var()` or
 * carries an alpha channel has no fixed lightness to measure, and guessing at what it composites
 * over would make a rule that fails on a colour nobody chose.
 */
export function parseThemeTokens(css) {
    const tokens = new Map()
    const pattern = /(--[a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi
    for (const [, name, light, dark] of css.matchAll(pattern)) tokens.set(name, {light, dark})
    return tokens
}

const modes = ['light', 'dark']

/** A rule reports nothing when a token it needs is missing — an absent token is not a collapsed one. */
function read(tokens, mode, name) {
    const pair = tokens.get(name)
    return pair && HEX.test(pair[mode]) ? pair[mode] : undefined
}

function separation({tokens, rule, mode, from, to, minimum, why}) {
    const one = read(tokens, mode, from)
    const other = read(tokens, mode, to)
    if (one === undefined || other === undefined) return undefined
    const distance = Math.abs(lightness(one) - lightness(other))
    if (distance >= minimum) return undefined
    return {
        id: `${rule}:${mode}:${from}:${to}`,
        rule,
        mode,
        detail: `${from} (${one}) and ${to} (${other}) are ${distance.toFixed(1)} L* apart, need ${String(minimum)}`,
        why
    }
}

function boundary({tokens, rule, mode, edge, against, why}) {
    const one = read(tokens, mode, edge)
    const other = read(tokens, mode, against)
    if (one === undefined || other === undefined) return undefined
    const ratio = contrastRatio(one, other)
    if (ratio >= MIN_BOUNDARY_CONTRAST) return undefined
    return {
        id: `${rule}:${mode}:${edge}:${against}`,
        rule,
        mode,
        detail: `${edge} (${one}) on ${against} (${other}) is ${ratio.toFixed(2)}:1, need ${String(MIN_BOUNDARY_CONTRAST)}:1`,
        why
    }
}

/**
 * Every violation the built theme currently carries, in both modes.
 *
 * The rules are deliberately few. Each one names a distinction a user makes without being taught
 * it, and each one failed on a real screen before it was written here.
 */
export function findViolations(tokens) {
    const found = []
    for (const mode of modes) {
        found.push(
            separation({
                tokens,
                rule: 'text-ramp',
                mode,
                from: '--color-text-primary',
                to: '--color-text-secondary',
                minimum: MIN_ROLE_DISTANCE,
                why: 'a value and its supporting text read as one weight of text'
            }),
            separation({
                tokens,
                rule: 'text-ramp',
                mode,
                from: '--color-text-secondary',
                to: '--color-text-disabled',
                minimum: MIN_ROLE_DISTANCE,
                why: 'a placeholder reads as text the user typed'
            }),
            separation({
                tokens,
                rule: 'surface-ramp',
                mode,
                from: '--color-background-body',
                to: '--color-background-surface',
                minimum: MIN_SURFACE_DISTANCE,
                why: 'panels and the frame behind them read as one flat sheet'
            }),
            separation({
                tokens,
                rule: 'surface-ramp',
                mode,
                from: '--color-background-surface',
                to: '--color-background-popover',
                minimum: MIN_SURFACE_DISTANCE,
                why: 'a popover does not read as floating over the panel it covers'
            }),
            separation({
                tokens,
                rule: 'accent-distinct',
                mode,
                from: '--color-accent',
                to: '--color-text-primary',
                minimum: MIN_ROLE_DISTANCE,
                why: 'the primary action carries no more emphasis than body text'
            }),
            boundary({
                tokens,
                rule: 'control-boundary',
                mode,
                edge: '--color-border-emphasized',
                against: '--color-background-surface',
                why: 'the edge of an input or a button cannot be found (WCAG 1.4.11)'
            })
        )
    }
    return found.filter(violation => violation !== undefined)
}

/** Violations the theme is allowed to keep, keyed by id, so only new ones fail the build. */
export function partitionAgainstBaseline(violations, baseline) {
    const allowed = new Set(baseline)
    const present = new Set(violations.map(violation => violation.id))
    return {
        introduced: violations.filter(violation => !allowed.has(violation.id)),
        fixed: baseline.filter(id => !present.has(id))
    }
}
