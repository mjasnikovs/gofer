// One adapter per surface shape: how a call is written, how it decodes back to (domain, op,
// params), and what the router would answer it. Everything else in the sweep is shape-blind.
import {readFile} from 'node:fs/promises'

const S = process.env.SCRATCH ?? import.meta.dirname
const map = JSON.parse(await readFile(`${S}/surf-map.json`, 'utf8'))
const catalog = JSON.parse(await readFile(`${S}/catalog.json`, 'utf8'))
const DOMAINS = new Set(catalog.map(d => d.name))
const short = name => name.replace(/^godot_/u, '')

const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const wrapOps = entries => JSON.stringify({ops: entries})

export const ARMS = {
    S1: {
        isGodot: name => DOMAINS.has(name),
        write: (domain, op, params) => ({
            name: domain,
            arguments: JSON.stringify({ops: [{op, ...params}]})
        }),
        decode(name, args) {
            if (!DOMAINS.has(name)) return null
            const list = Array.isArray(args?.ops) ? args.ops : []
            return list.map(entry => ({tool: name, ...asObject(entry)}))
        },
        answer: (name, args, resultOf) =>
            wrapOps(
                (Array.isArray(args?.ops) ? args.ops : []).map(e => ({
                    op: e.op,
                    result: resultOf(e.op, e)
                }))
            )
    },
    S2: {
        isGodot: name => name === 'godot',
        write: (domain, op, params) => ({
            name: 'godot',
            arguments: JSON.stringify({ops: [{op: `${short(domain)}.${op}`, ...params}]})
        }),
        decode(name, args) {
            if (name !== 'godot') return null
            const list = Array.isArray(args?.ops) ? args.ops : []
            return list.map(entry => {
                const {op, ...rest} = asObject(entry)
                const found = map.dot[op]
                if (!found) return {tool: null, op, ...rest}
                return {tool: found[0], op: found[1], ...rest}
            })
        },
        answer: (name, args, resultOf) =>
            wrapOps(
                (Array.isArray(args?.ops) ? args.ops : []).map(e => ({
                    op: e.op,
                    result: resultOf(map.dot[e.op]?.[1] ?? e.op, e)
                }))
            )
    },
    S3: {
        isGodot: name => Boolean(map.flat[name]),
        write: (domain, op, params) => ({
            name: `${domain}_${op}`,
            arguments: JSON.stringify(params)
        }),
        decode(name, args) {
            const found = map.flat[name]
            if (!found) return null
            return [{tool: found[0], op: found[1], ...asObject(args)}]
        },
        answer: (name, args, resultOf) =>
            JSON.stringify(resultOf(map.flat[name]?.[1], asObject(args)))
    },
    S4b: {
        isGodot: name => DOMAINS.has(name),
        write: (domain, op, params) => ({
            name: domain,
            arguments: JSON.stringify({operation: {op, ...params}})
        }),
        decode(name, args) {
            if (!DOMAINS.has(name)) return null
            const {op, ...rest} = asObject(args?.operation)
            return [{tool: name, op, ...rest}]
        },
        answer: (name, args, resultOf) =>
            JSON.stringify(resultOf(asObject(args?.operation).op, asObject(args?.operation)))
    },
    S4: {
        isGodot: name => DOMAINS.has(name),
        write: (domain, op, params) => ({name: domain, arguments: JSON.stringify({op, ...params})}),
        decode(name, args) {
            if (!DOMAINS.has(name)) return null
            const {op, ...rest} = asObject(args)
            return [{tool: name, op, ...rest}]
        },
        answer: (name, args, resultOf) =>
            JSON.stringify(resultOf(asObject(args).op, asObject(args)))
    }
}
