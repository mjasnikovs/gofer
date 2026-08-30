import {readFile} from 'node:fs/promises'
import {findViolations, parseThemeTokens, partitionAgainstBaseline} from './design-rules.mjs'

const themePath = new URL('../src/theme/gofer-theme.css', import.meta.url)
const baselinePath = new URL('./design-baseline.json', import.meta.url)

const [css, baselineFile] = await Promise.all([
    readFile(themePath, 'utf8'),
    readFile(baselinePath, 'utf8').then(JSON.parse)
])

const violations = findViolations(parseThemeTokens(css))
const {introduced, fixed} = partitionAgainstBaseline(violations, baselineFile.allowed)

for (const violation of introduced) {
    process.stderr.write(
        `\n  ${violation.rule} (${violation.mode})\n    ${violation.detail}\n    ${violation.why}\n`
    )
}

if (introduced.length > 0) {
    process.stderr.write(
        `\n${String(introduced.length)} new theme violation(s). Edit src/theme/theme.ts and rebuild with\n`
            + `  npm run astryx -- theme build src/theme/theme.ts --out src/theme/gofer-theme.css\n`
            + 'Read `npm run astryx -- docs color` before changing a token.\n\n'
    )
    process.exit(1)
}

if (fixed.length > 0) {
    process.stderr.write(
        `\nThese are fixed — delete them from scripts/design-baseline.json:\n${fixed.map(id => `  ${id}\n`).join('')}\n`
    )
    process.exit(1)
}

process.stdout.write(`design: ${String(violations.length)} known violation(s), none new\n`)
