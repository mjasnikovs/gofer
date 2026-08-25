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

for (const name of traces) {
    const run = name.replace(/\.jsonl$/u, '')
    const started = new Map()
    let calls = 0
    let refused = 0
    let answered = 0
    let fresh = 0
    let cached = 0
    let requests = 0
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
