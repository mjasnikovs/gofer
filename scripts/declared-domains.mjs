/**
 * The domains as `createGodotTools` receives them, built from the declared parameter contract.
 *
 * The real catalogue is serialized by the Rust crate, which merges prose from `ai_tools.rs` with
 * `params.json`. Only the parameters and the narrowing reach the JSON schema — a summary is a
 * sentence in the description — so reading them here costs no cargo build, and
 * `check:command-surface` is what holds the two halves together.
 *
 * `accepts` is a parameter too, and leaving it out is what this file exists to stop. The generator
 * appends each accepted name to the Rust row as `hidden(name, Text)`, and a hidden parameter is a
 * property of the schema even though it is left out of the signature. Two test files rebuilt this
 * shape from `params` alone, in the same thirty lines twice, so both ran every repair and every
 * schema case against a call that could not carry `scene` — the one parameter whose absence from
 * the schema has already refused a real turn with `ops.0: must not have additional properties`.
 */

import {readFile} from 'node:fs/promises'

/** One accepted name as the hidden parameter the generator writes into the Rust row. */
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
