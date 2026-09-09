import {readFileSync} from 'node:fs'
const REPO = new URL('../..', import.meta.url).pathname

const S = process.env.SCRATCH ?? import.meta.dirname
const {operations} = JSON.parse(readFileSync(`${REPO}/protocol/schemas/v2/params.json`, 'utf8'))
const corpus = JSON.parse(readFileSync(`${S}/corpus.json`, 'utf8'))

const found = {either: [], tagged: [], object: []}
function walk(tool, op, params, where) {
    for (const p of params ?? []) {
        const at = {
            tool,
            op,
            path: where ? `${where}.${p.name}` : p.name,
            name: p.name,
            required: !!p.required,
            note: p.note,
            kind: p.kind,
            of: p.of
        }
        if (p.kind === 'either') found.either.push(at)
        if (p.kind === 'tagged') found.tagged.push(at)
        if (p.kind === 'object') found.object.push(at)
        if (Array.isArray(p.entry) && p.entry.length) walk(tool, op, p.entry, at.path)
    }
}
for (const entry of operations) walk(entry.tool, entry.op, entry.params, '')

const short = k => k.kind ?? k
console.log('== EITHER (' + found.either.length + ')')
for (const e of found.either)
    console.log(
        `${e.tool} ${e.op} ${e.path}${e.required ? '' : '?'}: ${(e.of ?? []).map(o => short(o) + (o.of ? '(' + o.of.join('|') + ')' : '')).join('|')}`
    )
console.log('== TAGGED (' + found.tagged.length + ')')
for (const e of found.tagged) console.log(`${e.tool} ${e.op} ${e.path}${e.required ? '' : '?'}`)
console.log('== OBJECT (' + found.object.length + ')')
for (const e of found.object) console.log(`${e.tool} ${e.op} ${e.path}${e.required ? '' : '?'}`)

// how the corpus used each Either side
const shapeOf = v =>
    Array.isArray(v) ? 'list'
    : v === null ? 'null'
    : typeof v === 'object' ? 'object'
    : typeof v === 'string' ? 'text'
    : typeof v === 'boolean' ? 'flag'
    : Number.isInteger(v) ? 'int'
    : 'number'
const use = {}
function readValue(tool, op, params, object, where) {
    if (!object || typeof object !== 'object') return
    for (const p of params ?? []) {
        const held = object[p.name]
        if (held === undefined) continue
        const path = where ? `${where}.${p.name}` : p.name
        if (p.kind === 'either' || p.kind === 'tagged' || p.kind === 'object') {
            const key = `${tool} ${op} ${path}`
            ;(use[key] ??= {})[shapeOf(held)] = ((use[key] ?? {})[shapeOf(held)] ?? 0) + 1
        }
        if (Array.isArray(p.entry) && p.entry.length) {
            if (p.kind === 'list' && Array.isArray(held))
                for (const one of held) readValue(tool, op, p.entry, one, path)
            if (p.kind === 'object') readValue(tool, op, p.entry, held, path)
        }
    }
}
const byOp = new Map()
for (const entry of operations) byOp.set(`${entry.tool} ${entry.op}`, entry.params ?? [])
for (const call of corpus) {
    const listed = Array.isArray(call.arguments?.ops) ? call.arguments.ops : []
    for (const e of listed) {
        if (!e || typeof e !== 'object') continue
        const params = byOp.get(`${call.name} ${e.op}`)
        if (!params) continue
        readValue(call.name, e.op, params, e, '')
    }
}
console.log('== corpus usage')
for (const [k, v] of Object.entries(use).sort()) console.log(k, JSON.stringify(v))
