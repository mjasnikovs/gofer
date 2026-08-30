import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {
    contrastRatio,
    findViolations,
    lightness,
    luminance,
    parseThemeTokens,
    partitionAgainstBaseline
} from './design-rules.mjs'

const close = (actual, expected, tolerance = 0.05) =>
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${String(actual)} to be within ${String(tolerance)} of ${String(expected)}`
    )

function theme(pairs) {
    const lines = Object.entries(pairs).map(
        ([name, [light, dark]]) => `${name}: light-dark(${light}, ${dark});`
    )
    return parseThemeTokens(lines.join('\n'))
}

test('lightness spans black to white', () => {
    close(lightness('#000000'), 0)
    close(lightness('#ffffff'), 100)
    close(lightness('#767676'), 49.6, 0.5)
})

test('lightness uses the linear segment for colours near black', () => {
    close(lightness('#010101'), lightness('#020202') / 2, 0.02)
})

test('luminance weights green the most', () => {
    assert.ok(luminance('#00ff00') > luminance('#ff0000'))
    assert.ok(luminance('#ff0000') > luminance('#0000ff'))
})

test('contrast ratio is symmetric and tops out at 21', () => {
    close(contrastRatio('#000000', '#ffffff'), 21)
    close(contrastRatio('#ffffff', '#000000'), 21)
    close(contrastRatio('#262626', '#262626'), 1)
})

test('parseThemeTokens keeps hex pairs and skips what it cannot measure', () => {
    const tokens = parseThemeTokens(`
        --color-text-primary: light-dark(#171717, #fafafa);
        --color-neutral: light-dark(#0000000f, #ffffff1a);
        --color-background-gray: light-dark(#e5e5e5, var(--color-neutral));
        --radius-full: 9999px;
    `)
    assert.deepEqual([...tokens.keys()], ['--color-text-primary'])
    assert.deepEqual(tokens.get('--color-text-primary'), {light: '#171717', dark: '#fafafa'})
})

test('a placeholder the same colour as supporting text is reported in that mode only', () => {
    const violations = findViolations(
        theme({
            '--color-text-primary': ['#171717', '#fafafa'],
            '--color-text-secondary': ['#737373', '#d4d4d4'],
            '--color-text-disabled': ['#a3a3a3', '#d4d4d4']
        })
    )
    const ids = violations.map(violation => violation.id)
    assert.deepEqual(ids, ['text-ramp:dark:--color-text-secondary:--color-text-disabled'])
    assert.match(violations[0].why, /reads as text the user typed/)
    assert.match(violations[0].detail, /0\.0 L\* apart, need 12/)
})

test('an accent no brighter than body text loses the primary action', () => {
    const violations = findViolations(
        theme({
            '--color-accent': ['#262626', '#ebebeb'],
            '--color-text-primary': ['#171717', '#fafafa']
        })
    )
    assert.deepEqual(
        violations.map(violation => violation.rule),
        ['accent-distinct', 'accent-distinct']
    )
})

test('a border below 3:1 against its surface fails the boundary rule', () => {
    const violations = findViolations(
        theme({
            '--color-border-emphasized': ['#767676', '#525252'],
            '--color-background-surface': ['#ffffff', '#262626']
        })
    )
    assert.deepEqual(
        violations.map(violation => violation.mode),
        ['dark']
    )
    assert.match(violations[0].detail, /1\.94:1, need 3:1/)
})

test('a surface that never rises above the one below it is reported per step', () => {
    const violations = findViolations(
        theme({
            '--color-background-body': ['#f1f1f1', '#1b1b1b'],
            '--color-background-surface': ['#ffffff', '#262626'],
            '--color-background-card': ['#ffffff', '#2f2f2f'],
            '--color-background-popover': ['#ffffff', '#383838']
        })
    )
    assert.deepEqual(
        violations.map(violation => violation.id),
        [
            'surface-ramp:light:--color-background-surface:--color-background-card',
            'surface-ramp:light:--color-background-card:--color-background-popover'
        ]
    )
    assert.match(violations[0].why, /a card is the panel it sits on/)
})

test('a popover below the panel it floats over fails, however far below', () => {
    const violations = findViolations(
        theme({
            '--color-background-body': ['#f1f1f1', '#1b1b1b'],
            '--color-background-surface': ['#ffffff', '#262626'],
            '--color-background-card': ['#f5f5f5', '#1b1b1b'],
            '--color-background-popover': ['#ffffff', '#1b1b1b']
        })
    )
    const dark = violations.filter(violation => violation.mode === 'dark')
    assert.deepEqual(
        dark.map(violation => violation.id),
        [
            'surface-ramp:dark:--color-background-surface:--color-background-card',
            'surface-ramp:dark:--color-background-card:--color-background-popover'
        ]
    )
    assert.match(dark[0].detail, /5\.4 L\* below --color-background-surface/)
    assert.match(dark[1].detail, /0\.0 L\* below --color-background-card/)
})

test('surfaces a short step apart are reported as short, not as inverted', () => {
    const violations = findViolations(
        theme({
            '--color-background-body': ['#e1e1e1', '#1b1b1b'],
            '--color-background-surface': ['#e5e5e5', '#262626'],
            '--color-background-card': ['#f5f5f5', '#303030'],
            '--color-background-popover': ['#ffffff', '#383838']
        })
    )
    assert.deepEqual(
        violations.map(violation => violation.id),
        ['surface-ramp:light:--color-background-body:--color-background-surface']
    )
    assert.match(violations[0].detail, /only 1\.4 L\* above/)
})

test('a rule stays silent when the theme has no such token', () => {
    assert.deepEqual(findViolations(theme({'--color-text-primary': ['#171717', '#fafafa']})), [])
    assert.deepEqual(findViolations(new Map()), [])
})

test('the baseline separates what is new from what has been fixed', () => {
    const violations = [{id: 'a'}, {id: 'b'}]
    const {introduced, fixed} = partitionAgainstBaseline(violations, ['a', 'c'])
    assert.deepEqual(
        introduced.map(violation => violation.id),
        ['b']
    )
    assert.deepEqual(fixed, ['c'])
})

test('the committed baseline matches the built theme exactly', async () => {
    const [css, baseline] = await Promise.all([
        readFile(new URL('../src/theme/gofer-theme.css', import.meta.url), 'utf8'),
        readFile(new URL('./design-baseline.json', import.meta.url), 'utf8').then(JSON.parse)
    ])
    const violations = findViolations(parseThemeTokens(css))
    const {introduced, fixed} = partitionAgainstBaseline(violations, baseline.allowed)
    assert.deepEqual(introduced, [], 'the theme gained a violation the baseline does not list')
    assert.deepEqual(fixed, [], 'the baseline lists a violation the theme no longer has')
})
