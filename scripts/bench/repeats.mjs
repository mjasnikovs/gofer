import {readFileSync, writeFileSync} from 'node:fs'
import Ajv from 'ajv'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools} from '../godot-tools.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const corpus = JSON.parse(readFileSync(`${S}/corpus.json`, 'utf8'))
const domains = await declaredDomains()
const tools = createGodotTools(domains, {call: async () => ({})})
const ajv = new Ajv({strict: false})
const valid = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))

const isLocal = m => String(m.provider) === 'local'

/** the one word for why the schema refused it */
function shapeOf(call) {
    const raw = call.arguments
    if (typeof raw?.ops === 'string') return 'ops written as a JSON string'
    if (!Array.isArray(raw?.ops)) return 'no ops array'
    if (raw.op !== undefined) return 'op beside ops (double-named call)'
    if (raw.ops.length === 0) return 'empty ops list'
    const entries = raw.ops.filter(e => e && typeof e === 'object')
    if (entries.some(e => Object.keys(e).some(k => /["{}\[\]]|: /u.test(k))))
        return 'torn key (JSON came apart into the key)'
    if (entries.some(e => e.op === undefined)) return 'entry with no op'
    if (entries.some(e => Object.keys(e).some(k => /placeholder|_note$|Error\d+$/u.test(k))))
        return 'invented key (placeholder / pathErrorN)'
    return 'unknown key for this op'
}

/** the fingerprint two calls share when the second is the first sent again */
function print(call) {
    const ops = Array.isArray(call.arguments?.ops) ? call.arguments.ops : []
    const keys = ops
        .map(e => (e && typeof e === 'object' ? Object.keys(e).sort().join(',') : typeof e))
        .join('|')
    return `${call.name}::${ops.map(e => e?.op ?? '-').join('|')}::${keys}`
}
const argKey = call => JSON.stringify(call.arguments)

// order within each task is the order the messages were stored in
const perTask = new Map()
const rows = []
for (const call of corpus) {
    if (!valid[call.name]) continue
    const seat = (perTask.get(call.task) ?? 0) + 1
    perTask.set(call.task, seat)
    const ok = valid[call.name](call.arguments)
    rows.push({...call, seat, ok, side: isLocal(call) ? 'local' : 'cloud'})
}

const failing = rows.filter(r => !r.ok)
// a repeat: the previous FAILING call of the same task has the same fingerprint
const lastBad = new Map()
for (const f of failing) {
    const before = lastBad.get(f.task)
    f.repeatOfPrev = Boolean(before && print(before) === print(f))
    f.identicalArgs = Boolean(before && argKey(before) === argKey(f))
    // the looser, and the one that matters: the same operation failing the same way again
    f.sameMistakeAsPrev = Boolean(
        before
        && before.name === f.name
        && (Array.isArray(before.arguments?.ops) ? before.arguments.ops : [])
            .map(e => e?.op)
            .join('|')
            === (Array.isArray(f.arguments?.ops) ? f.arguments.ops : []).map(e => e?.op).join('|')
        && shapeOf(before) === shapeOf(f)
    )
    f.sameShapeAsPrev = Boolean(before && shapeOf(before) === shapeOf(f))
    f.gap = before ? f.seat - before.seat : null
    lastBad.set(f.task, f)
}

const short = m => String(m).split('/').pop()
console.log('=== every failing call, in order')
console.log(
    [
        'side',
        'db',
        'task(head)',
        'seat/total',
        'tool op',
        'shape',
        'repeat',
        'sameArgs',
        'gap'
    ].join(' | ')
)
for (const f of failing) {
    const ops = Array.isArray(f.arguments?.ops) ? f.arguments.ops : []
    console.log(
        [
            f.side,
            f.db,
            f.task.slice(0, 8),
            `${f.seat}/${perTask.get(f.task)}`,
            `${f.name} ${ops
                .map(e => e?.op ?? '-')
                .slice(0, 2)
                .join(',')}`,
            shapeOf(f),
            f.repeatOfPrev ? 'REPEAT' : '-',
            f.identicalArgs ? 'identical' : '-',
            f.gap ?? '-'
        ].join(' | ')
    )
}

for (const side of ['local', 'cloud']) {
    const all = rows.filter(r => r.side === side)
    const bad = failing.filter(r => r.side === side)
    const tasks = [...new Set(bad.map(r => r.task))]
    const repeats = bad.filter(r => r.repeatOfPrev)
    const collapsed = bad.length - repeats.length
    const perTaskRate = tasks
        .map(t => {
            const inTask = all.filter(r => r.task === t)
            const badIn = bad.filter(r => r.task === t)
            return {
                id: t,
                task: t.slice(0, 8),
                calls: inTask.length,
                bad: badIn.length,
                exactRepeats: badIn.filter(r => r.repeatOfPrev).length,
                sameMistake: badIn.filter(r => r.sameMistakeAsPrev).length,
                collapsed: badIn.filter(r => !r.sameMistakeAsPrev).length
            }
        })
        .sort((a, b) => b.bad - a.bad)
    const worst = perTaskRate[0]
    const withoutWorst = all.filter(r => r.task !== worst?.id)
    const badWithoutWorst = bad.filter(r => r.task !== worst?.id)
    console.log(`\n=== ${side}`)
    console.log(
        'calls',
        all.length,
        'failing',
        bad.length,
        `(${((100 * bad.length) / all.length).toFixed(2)}%)`
    )
    console.log(
        'distinct tasks the failures come from',
        tasks.length,
        'of',
        new Set(all.map(r => r.task)).size,
        'tasks with calls'
    )
    const loose = bad.filter(r => r.sameMistakeAsPrev)
    const shapeOnly = bad.filter(r => r.sameShapeAsPrev)
    console.log('repeat of the previous failing call, identical op+key set   ', repeats.length)
    console.log('same op failing the same way again (the poisoning shape)    ', loose.length)
    console.log('same failure shape again, any op                            ', shapeOnly.length)
    console.log(
        'collapsed to one per run of the same mistake',
        bad.length - loose.length,
        `(${((100 * (bad.length - loose.length)) / all.length).toFixed(2)}%)`
    )
    console.table(perTaskRate)
    console.log(
        'worst task removed:',
        badWithoutWorst.length,
        '/',
        withoutWorst.length,
        `= ${((100 * badWithoutWorst.length) / withoutWorst.length).toFixed(2)}%`,
        '| and repeats collapsed:',
        badWithoutWorst.filter(r => !r.sameMistakeAsPrev).length,
        `= ${((100 * badWithoutWorst.filter(r => !r.sameMistakeAsPrev).length) / withoutWorst.length).toFixed(2)}%`
    )
}
