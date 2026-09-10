import {DatabaseSync} from 'node:sqlite'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

export const LEDGER_DB = resolve('logs/tool-ledger.sqlite')
export const TASK_BANK = resolve('fixtures/live-tasks.json')
const TOOL = resolve('protocol/schemas/v2/godot-tool.json')

// A refusal raised before the op reached its handler: the call's shape, not the editor's answer.
export const CONTRACT_CODES = new Set([
    'schema',
    'invalid_params',
    'missing_param',
    'unknown_param',
    'unknown_operation',
    'must_be_alone',
    'op_repeated',
    'policy_enforced'
])

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    task_id TEXT,
    task TEXT NOT NULL,
    fixture TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    seconds REAL,
    exit_status INTEGER,
    completion TEXT,
    failure TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS calls (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    tool TEXT NOT NULL,
    target TEXT,
    is_error INTEGER NOT NULL,
    code TEXT,
    ms INTEGER,
    output TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS ops (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    op TEXT NOT NULL,
    code TEXT,
    message TEXT,
    ms INTEGER,
    params TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS verdicts (
    op TEXT NOT NULL,
    code TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('model', 'gofer', 'fixed', 'environment')),
    note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (op, code)
) STRICT;
CREATE INDEX IF NOT EXISTS ops_op ON ops(op);
CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);
`

export function openLedger(path = LEDGER_DB) {
    const db = new DatabaseSync(path)
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    return db
}

export function catalogueOperations(tool = TOOL) {
    const found = []
    const walk = node => {
        if (!node || typeof node !== 'object') return
        if (Array.isArray(node)) return node.forEach(walk)
        if (node.properties?.op?.const) found.push(node.properties.op.const)
        Object.values(node).forEach(walk)
    }
    walk(JSON.parse(readFileSync(tool, 'utf8')))
    return [...new Set(found)].sort()
}

export function loadTaskBank(path = TASK_BANK) {
    const bank = JSON.parse(readFileSync(path, 'utf8'))
    const seen = new Set()
    for (const task of bank.tasks) {
        if (seen.has(task.id)) throw new Error(`The task bank names ${task.id} twice`)
        seen.add(task.id)
    }
    return bank.tasks
}

// The failure code a refused call carries: Gofer writes `code: sentence`, and pi-ai's schema
// check writes a sentence that starts with `Validation failed`.
export function codeOf(output, isError) {
    if (!isError) return null
    if (/^Validation failed/u.test(output)) return 'schema'
    const match = /^([a-z][a-z0-9_]*):/u.exec(output)
    return match ? match[1] : 'unknown'
}

// The tool calls of one turn, read from the tool-start/tool-end events rather than the
// transcript: the agent prunes its transcript on long turns and the events are complete.
export function callsFromEvents(lines) {
    const started = new Map()
    const calls = []
    for (const line of lines) {
        if (!line.trim()) continue
        const {event} = JSON.parse(line)
        if (event.type === 'tool-start') started.set(event.id, event)
        if (event.type !== 'tool-end') continue
        const start = started.get(event.id)
        const output =
            typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? null)
        calls.push({
            seq: calls.length,
            tool: start?.name ?? 'unknown',
            target: start?.target ?? null,
            isError: event.isError === true,
            code: codeOf(output, event.isError === true),
            ms: start ? event.endedAt - start.startedAt : null,
            output: output.slice(0, 2000)
        })
    }
    return calls
}

export function opsFromLedger(lines) {
    return lines
        .filter(line => line.trim())
        .map((line, seq) => {
            const entry = JSON.parse(line)
            return {
                seq,
                op: entry.op,
                code: entry.code ?? null,
                message: entry.message ?? null,
                ms: entry.ms ?? null,
                params: JSON.stringify(entry.params ?? null)
            }
        })
}

export function recordRun(db, run, calls, ops) {
    db.prepare('DELETE FROM runs WHERE name = ?').run(run.name)
    const inserted = db
        .prepare(
            `INSERT INTO runs (name, task_id, task, fixture, model, started_at, seconds, exit_status, completion, failure)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            run.name,
            run.taskId ?? null,
            run.task,
            run.fixture,
            run.model,
            run.startedAt,
            run.seconds ?? null,
            run.exitStatus ?? null,
            run.completion ?? null,
            run.failure ?? null
        )
    const runId = Number(inserted.lastInsertRowid)
    const call = db.prepare(
        'INSERT INTO calls (run_id, seq, tool, target, is_error, code, ms, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const c of calls)
        call.run(runId, c.seq, c.tool, c.target, c.isError ? 1 : 0, c.code, c.ms, c.output)
    const op = db.prepare(
        'INSERT INTO ops (run_id, seq, op, code, message, ms, params) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const o of ops) op.run(runId, o.seq, o.op, o.code, o.message, o.ms, o.params)
    return runId
}

export function setVerdict(db, op, code, reason, note = '') {
    db.prepare(
        `INSERT INTO verdicts (op, code, reason, note, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(op, code) DO UPDATE SET reason = excluded.reason, note = excluded.note, updated_at = excluded.updated_at`
    ).run(op, code, reason, note, Date.now())
}

// One row per catalogue op: how often it ran, how often it failed, which codes, and the verdict
// each code has. `open` counts failures nobody has judged yet.
export function opStats(db, catalogue) {
    const counts = new Map(
        catalogue.map(op => [
            op,
            {op, calls: 0, errors: 0, runs: 0, codes: {}, open: 0, verdicts: {}}
        ])
    )
    const rows = db
        .prepare(
            `SELECT op, code, COUNT(*) AS n, COUNT(DISTINCT run_id) AS runs FROM ops GROUP BY op, code`
        )
        .all()
    const verdicts = new Map(
        db
            .prepare('SELECT op, code, reason FROM verdicts')
            .all()
            .map(v => [`${v.op}\n${v.code}`, v.reason])
    )
    for (const row of rows) {
        const stat = counts.get(row.op) ?? {
            op: row.op,
            calls: 0,
            errors: 0,
            runs: 0,
            codes: {},
            open: 0,
            verdicts: {}
        }
        counts.set(row.op, stat)
        stat.calls += Number(row.n)
        if (row.code === null) continue
        stat.errors += Number(row.n)
        stat.codes[row.code] = Number(row.n)
        const verdict = verdicts.get(`${row.op}\n${row.code}`)
        if (verdict) stat.verdicts[row.code] = verdict
        else stat.open += Number(row.n)
    }
    const perRun = db
        .prepare('SELECT op, COUNT(DISTINCT run_id) AS runs FROM ops GROUP BY op')
        .all()
    for (const row of perRun) {
        const stat = counts.get(row.op)
        if (stat) stat.runs = Number(row.runs)
    }
    return [...counts.values()]
}

// Refusals the router raised before any op ran, grouped by code and by the call's target label.
export function contractRefusals(db) {
    return db
        .prepare(
            `SELECT code, target, COUNT(*) AS n FROM calls WHERE tool = 'godot' AND is_error = 1
             GROUP BY code, target ORDER BY n DESC`
        )
        .all()
        .filter(row => CONTRACT_CODES.has(row.code))
}

// A shape that repeats inside one run is Gofer's: the same op refused with the same code twice
// in one turn.
export function repeatsWithinRuns(db) {
    return db
        .prepare(
            `SELECT run_id, op, code, COUNT(*) AS n FROM ops WHERE code IS NOT NULL
             GROUP BY run_id, op, code HAVING n >= 2 ORDER BY n DESC`
        )
        .all()
}

// How much a task is worth running now. An op nobody has driven weighs most, then one with an
// unjudged failure, then one seen in fewer than three runs. A task's ops that are green and
// well-trodden add nothing.
export function need(stat) {
    if (stat.calls === 0) return 3
    if (stat.open > 0) return 4
    if (stat.runs < 3) return 1
    return 0
}

export function rankTasks(stats, bank, runsSoFar = new Map()) {
    const byOp = new Map(stats.map(stat => [stat.op, stat]))
    return bank
        .map(task => {
            const wanted = task.ops.map(op => ({op, need: byOp.has(op) ? need(byOp.get(op)) : 3}))
            const score =
                wanted.reduce((sum, w) => sum + w.need, 0) / Math.max(1, task.ops.length) ** 0.5
            return {
                ...task,
                score,
                ran: runsSoFar.get(task.id) ?? 0,
                wanted: wanted.filter(w => w.need > 0).map(w => w.op)
            }
        })
        .sort((a, b) => b.score - a.score || a.ran - b.ran || a.id.localeCompare(b.id))
}
