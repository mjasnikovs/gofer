const MIN_BOUNDARY_CONTRAST = 3

const MIN_ROLE_DISTANCE = 12

const MIN_SURFACE_DISTANCE = 3

const HEX = /^#[0-9a-f]{6}$/i

const channel = value => {
    const scaled = value / 255
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

export function luminance(hex) {
    const [red, green, blue] = [1, 3, 5].map(at =>
        channel(Number.parseInt(hex.slice(at, at + 2), 16))
    )
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

export function lightness(hex) {
    const y = luminance(hex)
    return y <= 216 / 24389 ? y * (24389 / 27) : 116 * Math.cbrt(y) - 16
}

export function contrastRatio(one, other) {
    const [darker, lighter] = [luminance(one), luminance(other)].sort((a, b) => a - b)
    return (lighter + 0.05) / (darker + 0.05)
}

export function parseThemeTokens(css) {
    const tokens = new Map()
    const pattern = /(--[a-z0-9-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi
    for (const [, name, light, dark] of css.matchAll(pattern)) tokens.set(name, {light, dark})
    return tokens
}

const modes = ['light', 'dark']

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

function ascent({tokens, rule, mode, from, to, minimum, why}) {
    const one = read(tokens, mode, from)
    const other = read(tokens, mode, to)
    if (one === undefined || other === undefined) return undefined
    const rise = lightness(other) - lightness(one)
    if (rise >= minimum) return undefined
    const id = `${rule}:${mode}:${from}:${to}`
    if (rise <= 0) {
        return {
            id,
            rule,
            mode,
            detail: `${to} (${other}) is ${Math.abs(rise).toFixed(1)} L* below ${from} (${one}), and has to be ${String(minimum)} above it`,
            why
        }
    }
    return {
        id,
        rule,
        mode,
        detail: `${to} (${other}) is only ${rise.toFixed(1)} L* above ${from} (${one}), need ${String(minimum)}`,
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
            ascent({
                tokens,
                rule: 'surface-ramp',
                mode,
                from: '--color-background-body',
                to: '--color-background-surface',
                minimum: MIN_SURFACE_DISTANCE,
                why: 'panels and the frame behind them read as one flat sheet'
            }),
            ascent({
                tokens,
                rule: 'surface-ramp',
                mode,
                from: '--color-background-surface',
                to: '--color-background-card',
                minimum: MIN_SURFACE_DISTANCE,
                why: 'a card is the panel it sits on, with a hairline drawn round it'
            }),
            ascent({
                tokens,
                rule: 'surface-ramp',
                mode,
                from: '--color-background-card',
                to: '--color-background-popover',
                minimum: MIN_SURFACE_DISTANCE,
                why: 'a popover does not read as floating over what it covers'
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

export function partitionAgainstBaseline(violations, baseline) {
    const allowed = new Set(baseline)
    const present = new Set(violations.map(violation => violation.id))
    return {
        introduced: violations.filter(violation => !allowed.has(violation.id)),
        fixed: baseline.filter(id => !present.has(id))
    }
}
