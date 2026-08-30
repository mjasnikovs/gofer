import {readFile} from 'node:fs/promises'

function hidden(name) {
    return {name, kind: 'text', required: false, hidden: true}
}

export async function declaredDomains() {
    const {operations} = JSON.parse(
        await readFile(new URL('../protocol/schemas/v2/params.json', import.meta.url), 'utf8')
    )
    const domains = new Map()
    for (const entry of operations) {
        const declared = domains.get(entry.tool) ?? []
        declared.push({
            op: entry.op,
            summary: `${entry.op}.`,
            params: [...(entry.params ?? []), ...(entry.accepts ?? []).map(hidden)],
            alone: entry.alone ?? null
        })
        domains.set(entry.tool, declared)
    }
    return [...domains].map(([name, operations]) => ({name, description: name, operations}))
}
