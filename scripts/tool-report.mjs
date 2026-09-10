#!/usr/bin/env node
// What the ledger in logs/tool-ledger.sqlite says about every godot op.
//
//   node scripts/tool-report.mjs                 every op: calls, errors, codes, verdicts
//   node scripts/tool-report.mjs next [n]        the bank tasks worth running now
//   node scripts/tool-report.mjs run <name>      one run, call by call
//   node scripts/tool-report.mjs verdict <op> <code> <model|gofer|fixed|environment> [note]
import {
    catalogueOperations,
    contractRefusals,
    loadTaskBank,
    openLedger,
    opStats,
    rankTasks,
    repeatsWithinRuns,
    setVerdict
} from './tool-ledger.mjs'

const [command = 'ops', ...rest] = process.argv.slice(2)
const db = openLedger()
const out = line => process.stdout.write(`${line}\n`)

if (command === 'ops') {
    const stats = opStats(db, catalogueOperations())
    const never = stats.filter(s => s.calls === 0)
    const failing = stats.filter(s => s.open > 0).sort((a, b) => b.open - a.open)
    const judged = stats.filter(s => s.errors > 0 && s.open === 0)
    const green = stats.filter(s => s.calls > 0 && s.errors === 0)
    const runs = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n
    out(
        `${runs} runs, ${stats.length} ops: ${never.length} never called, ${failing.length} with open failures, ${judged.length} judged, ${green.length} green`
    )
    out('')
    out(`never called (${never.length}):`)
    out(`  ${never.map(s => s.op).join(' ')}`)
    out('')
    out(`open failures (${failing.length}):`)
    for (const s of failing)
        out(
            `  ${s.op.padEnd(30)} ${String(s.calls).padStart(4)} calls ${String(s.errors).padStart(3)} err  ${Object.entries(
                s.codes
            )
                .map(([c, n]) => `${c}×${n}${s.verdicts[c] ? `(${s.verdicts[c]})` : ''}`)
                .join(' ')}`
        )
    out('')
    out(`judged (${judged.length}):`)
    for (const s of judged)
        out(
            `  ${s.op.padEnd(30)} ${String(s.calls).padStart(4)} calls ${String(s.errors).padStart(3)} err  ${Object.entries(
                s.codes
            )
                .map(([c, n]) => `${c}×${n}(${s.verdicts[c]})`)
                .join(' ')}`
        )
    out('')
    out(`green (${green.length}):`)
    for (const s of green.sort((a, b) => a.runs - b.runs || a.op.localeCompare(b.op)))
        out(`  ${s.op.padEnd(30)} ${String(s.calls).padStart(4)} calls in ${s.runs} runs`)
    const refused = contractRefusals(db)
    if (refused.length > 0) {
        out('')
        out(`refused before any op ran (${refused.reduce((n, r) => n + Number(r.n), 0)} calls):`)
        for (const r of refused)
            out(`  ${String(r.n).padStart(3)}  ${r.code.padEnd(18)} ${r.target ?? ''}`)
    }
    const repeats = repeatsWithinRuns(db)
    if (repeats.length > 0) {
        out('')
        out('same op, same code, twice in one run — Gofer until judged otherwise:')
        for (const r of repeats) out(`  run ${r.run_id}  ${r.op.padEnd(30)} ${r.code} ×${r.n}`)
    }
}

if (command === 'next') {
    const n = Number(rest[0] ?? 8)
    const ranSoFar = new Map(
        db
            .prepare(
                'SELECT task_id, COUNT(*) AS n FROM runs WHERE task_id IS NOT NULL GROUP BY task_id'
            )
            .all()
            .map(r => [r.task_id, Number(r.n)])
    )
    const ranked = rankTasks(opStats(db, catalogueOperations()), loadTaskBank(), ranSoFar)
    for (const task of ranked.slice(0, n))
        out(
            `${task.score.toFixed(1).padStart(5)}  ${task.id.padEnd(24)} ran ${task.ran}  wants ${task.wanted.join(' ') || '-'}`
        )
}

if (command === 'run') {
    const run = db.prepare('SELECT * FROM runs WHERE name = ?').get(rest[0])
    if (!run) throw new Error(`no run named ${rest[0]}`)
    out(
        `${run.name}  ${run.task_id ?? ''}  ${run.fixture}  ${Number(run.seconds).toFixed(0)}s  exit ${run.exit_status}`
    )
    out(`task: ${run.task}`)
    out(`answer: ${(run.completion ?? run.failure ?? '').slice(0, 600)}`)
    out('')
    for (const call of db.prepare('SELECT * FROM calls WHERE run_id = ? ORDER BY seq').all(run.id))
        out(
            `${String(call.seq).padStart(3)} ${String(call.ms ?? '').padStart(6)}ms ${call.is_error ? 'ERR' : ' ok'} ${call.tool.padEnd(8)} ${(call.target ?? '').slice(0, 60)}${call.is_error ? `\n       ${call.output.slice(0, 300).replace(/\n/gu, ' ')}` : ''}`
        )
    out('')
    for (const op of db.prepare('SELECT * FROM ops WHERE run_id = ? ORDER BY seq').all(run.id))
        out(
            `${String(op.seq).padStart(3)} ${String(op.ms ?? '').padStart(6)}ms ${op.code ? 'ERR' : ' ok'} ${op.op.padEnd(28)} ${op.params.slice(0, 120)}${op.code ? `\n       ${op.code}: ${(op.message ?? '').slice(0, 300)}` : ''}`
        )
}

if (command === 'verdict') {
    const [op, code, reason, ...note] = rest
    setVerdict(db, op, code, reason, note.join(' '))
    out(`${op} ${code} → ${reason}`)
}

db.close()
