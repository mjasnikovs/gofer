/**
 * What the recorded live turns actually failed at, ranked by how many of them failed at it.
 *
 * Written after the fifth iteration of the improvement loop had hand-rolled the same three
 * analyses: which calls were refused, how many tokens each answer cost, and how much of a run's
 * input was a cache read. The last of those hand-rolls found the corpus's single most common
 * failure — one configuration fact that killed `godot_docs_search` in seven of the nine runs that
 * reached it — and it would have found it hours earlier if it had been a command.
 *
 * The grouping is the part worth keeping. A refusal is a sentence with the caller's own paths,
 * node names and numbers in it, so two occurrences of one bug never look alike; those are blanked
 * before counting, and runs are counted rather than occurrences, because one model retrying one
 * mistake five times is one bug and five runs hitting it is five.
 *
 *   node scripts/ox-sweep.mjs [directory]     # default logs/oxloop
 */
import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

const directory = process.argv[2] ?? 'logs/oxloop'
const traces = readdirSync(directory)
    .filter(name => name.endsWith('.jsonl'))
    .sort()

/** One refusal reduced to its shape, so two occurrences of one bug count as one. */
function shapeOf(message) {
    return message
        .replace(/res:\/\/[^\s"'`,)]+/gu, 'PATH')
        .replace(/\/[A-Z][A-Za-z0-9_/]*/gu, 'NODE')
        .replace(/\d+/gu, 'N')
        .slice(0, 160)
}

const failures = new Map()
const runs = []
/** Per refusal code: how many there were, how many were followed by a call that worked, and how
 * many by the same code again. */
const recovery = new Map()

for (const name of traces) {
    const run = name.replace(/\.jsonl$/u, '')
    const started = new Map()
    let calls = 0
    let refused = 0
    let answered = 0
    let fresh = 0
    let cached = 0
    let requests = 0
    /** Every call of this run in order, as `[code or null, wasRefused]`. */
    const sequence = []
    for (const line of readFileSync(join(directory, name), 'utf8').trim().split('\n')) {
        let record
        try {
            record = JSON.parse(line)
        } catch {
            continue
        }
        const event = record.event
        if (event?.type === 'tool-start') started.set(event.id, event.name ?? event.toolName ?? '?')
        if (event?.type === 'usage') {
            requests += 1
            const usage = event.usage ?? event
            fresh += usage.input ?? usage.inputTokens ?? 0
            cached += usage.cacheRead ?? usage.cacheReadTokens ?? 0
        }
        if (event?.type !== 'tool-end') continue
        calls += 1
        const output =
            typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? '')
        answered += output.length
        sequence.push([/^([a-z_]+):/u.exec(output)?.[1] ?? null, Boolean(event.isError)])
        if (!event.isError) continue
        refused += 1
        const shape = shapeOf(output)
        const row = failures.get(shape) ?? {
            occurrences: 0,
            runs: new Set(),
            tool: started.get(event.id) ?? '?',
            sample: output
        }
        row.occurrences += 1
        row.runs.add(run)
        failures.set(shape, row)
    }
    // What the caller's very next call did. The closest thing this corpus holds to whether a
    // refusal's sentence worked: a message that says what to do next is one the next call acts on.
    for (const [index, [code, wasRefused]] of sequence.entries()) {
        if (!wasRefused || code === null) continue
        const row = recovery.get(code) ?? {total: 0, recovered: 0, repeated: 0}
        row.total += 1
        const next = sequence[index + 1]
        if (next && !next[1]) row.recovered += 1
        else if (next && next[0] === code) row.repeated += 1
        recovery.set(code, row)
    }
    if (calls > 0) runs.push({run, calls, refused, answered, requests, fresh, cached})
}

console.log(`${runs.length} runs with calls, of ${traces.length} traces in ${directory}\n`)
console.log('run'.padEnd(20), 'calls', 'refused', 'answerChars', 'requests', 'freshTok', 'cached%')
for (const one of runs) {
    const share = one.fresh + one.cached > 0 ? (100 * one.cached) / (one.fresh + one.cached) : 0
    console.log(
        one.run.padEnd(20),
        String(one.calls).padStart(5),
        String(one.refused).padStart(7),
        String(one.answered).padStart(11),
        String(one.requests).padStart(8),
        String(one.fresh).padStart(8),
        `${share.toFixed(1)}%`.padStart(7)
    )
}

console.log('\nrefusals, by how many runs hit them\n')
const ranked = [...failures.values()].sort(
    (a, b) => b.runs.size - a.runs.size || b.occurrences - a.occurrences
)
for (const row of ranked) {
    console.log(
        `${String(row.runs.size).padStart(2)} runs  ${String(row.occurrences).padStart(3)}x  `
            + `${row.tool.padEnd(18)} ${row.sample.slice(0, 120).replace(/\n/gu, ' ')}`
    )
}

// Ranked worst first, because a code every caller recovers from is one nobody has to work on.
console.log("\nrefusal codes, by what the caller's next call did\n")
console.log('code'.padEnd(24), 'n'.padStart(4), 'next ok'.padStart(8), 'same again'.padStart(11))
const scored = [...recovery.entries()]
    .filter(([, row]) => row.total >= 3)
    .sort((a, b) => a[1].recovered / a[1].total - b[1].recovered / b[1].total)
for (const [code, row] of scored) {
    console.log(
        code.padEnd(24),
        String(row.total).padStart(4),
        `${Math.round((100 * row.recovered) / row.total)}%`.padStart(8),
        `${Math.round((100 * row.repeated) / row.total)}%`.padStart(11)
    )
}
