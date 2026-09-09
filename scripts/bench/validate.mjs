import {readFileSync, writeFileSync} from 'node:fs'
import Ajv from 'ajv'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools, normalizeGodotCall} from '../godot-tools.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const corpus = JSON.parse(readFileSync(`${S}/corpus.json`, 'utf8'))
const domains = await declaredDomains()
const tools = createGodotTools(domains, {call: async () => ({})})
const ajv = new Ajv({strict: false, allErrors: false})
const validators = Object.fromEntries(tools.map(t => [t.name, ajv.compile(t.parameters)]))

const byName = {}
for (const c of corpus) byName[c.name] = (byName[c.name] ?? 0) + 1

const rows = []
for (const call of corpus) {
    const validate = validators[call.name]
    if (!validate) {
        rows.push({...call, domain: false})
        continue
    }
    const ok = validate(call.arguments)
    let repaired,
        repairedOk,
        threw = null
    if (!ok) {
        try {
            repaired = normalizeGodotCall(domains, call.name, call.arguments)
            repairedOk = validate(repaired)
        } catch (e) {
            threw = e.message
            repairedOk = false
        }
    }
    rows.push({
        db: call.db,
        id: call.id,
        name: call.name,
        model: call.model,
        provider: call.provider,
        domain: true,
        ok,
        error: ok ? null : ajv.errorsText(validate.errors).slice(0, 300),
        arguments: ok ? undefined : call.arguments,
        repaired: ok ? undefined : repaired,
        repairedOk: ok ? undefined : repairedOk,
        threw
    })
}
writeFileSync(`${S}/rows-validated.json`, JSON.stringify(rows, null, 1))
const domainRows = rows.filter(r => r.domain)
console.log('total calls', corpus.length)
console.log('by tool', JSON.stringify(byName, null, 0))
console.log('domain (ops-schema) calls', domainRows.length)
console.log('invalid under strict schema', domainRows.filter(r => !r.ok).length)
console.log('  repaired to valid by worker', domainRows.filter(r => !r.ok && r.repairedOk).length)
console.log('  worker threw', domainRows.filter(r => r.threw).length)
console.log('  still invalid', domainRows.filter(r => !r.ok && !r.repairedOk && !r.threw).length)
const models = {}
for (const r of domainRows)
    models[`${r.provider}/${r.model}`] = (models[`${r.provider}/${r.model}`] ?? 0) + 1
console.log('models', models)
const badModels = {}
for (const r of domainRows.filter(r => !r.ok))
    badModels[`${r.provider}/${r.model}`] = (badModels[`${r.provider}/${r.model}`] ?? 0) + 1
console.log('invalid by model', badModels)
