import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const reportPath = resolve(process.argv[2] ?? 'src-tauri/target/critical-coverage.json')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const coverage = report.data?.[0]
if (!coverage) throw new Error(`Rust coverage data is missing from ${reportPath}`)

const aggregateThresholds = {lines: 80, branches: 75}
let failed = false
for (const [metric, minimum] of Object.entries(aggregateThresholds)) {
    const actual = coverage.totals?.[metric]?.percent
    if (typeof actual !== 'number') throw new Error(`Rust ${metric} coverage is missing`)
    console.log(`${metric}: ${actual.toFixed(2)}% (minimum ${String(minimum)}%)`)
    if (actual < minimum) failed = true
}

const requiredGroups = new Set([
    'attachment',
    'cache',
    'cancellation',
    'credential',
    'path',
    'protocol'
])
const ranges = new Map()

for (const file of coverage.files) {
    if (!file.filename.includes('/src-tauri/src/')) continue
    const lines = readFileSync(file.filename, 'utf8').split('\n')
    const starts = new Map()
    for (const [index, line] of lines.entries()) {
        const start = line.match(/coverage-critical-start: ([a-z-]+)/)?.[1]
        if (start) starts.set(start, index + 1)
        const end = line.match(/coverage-critical-end: ([a-z-]+)/)?.[1]
        if (!end) continue
        const startLine = starts.get(end)
        if (!startLine)
            throw new Error(`Critical coverage marker '${end}' is unpaired in ${file.filename}`)
        const entries = ranges.get(end) ?? []
        entries.push({filename: file.filename, start: startLine, end: index + 1})
        ranges.set(end, entries)
        starts.delete(end)
    }
    if (starts.size > 0) throw new Error(`Critical coverage marker is unpaired in ${file.filename}`)
}

for (const group of requiredGroups) {
    if (!ranges.has(group))
        throw new Error(`Critical coverage group '${group}' has no source markers`)
}

for (const group of [...requiredGroups].sort()) {
    const decisions = new Map()
    for (const range of ranges.get(group)) {
        const file = coverage.files.find(entry => entry.filename === range.filename)
        for (const branch of file.branches) {
            if (branch[0] < range.start || branch[0] > range.end) continue
            const key = `${file.filename}:${branch.slice(0, 4).join(':')}`
            const counts = decisions.get(key) ?? [0, 0]
            counts[0] += branch[4]
            counts[1] += branch[5]
            decisions.set(key, counts)
        }
    }
    const uncovered = [...decisions].filter(([, counts]) => counts.some(count => count === 0))
    const outcomes = decisions.size * 2
    const covered =
        outcomes
        - uncovered.reduce((total, [, counts]) => {
            return total + counts.filter(count => count === 0).length
        }, 0)
    const percent = outcomes === 0 ? 100 : (covered / outcomes) * 100
    console.log(`${group}: ${percent.toFixed(2)}% branch coverage (${covered}/${outcomes})`)
    if (uncovered.length === 0) continue
    failed = true
    for (const [key, counts] of uncovered) console.error(`  uncovered ${key} (${counts.join('/')})`)
}

if (failed) process.exitCode = 1
