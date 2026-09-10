import {readFile} from 'node:fs/promises'
import {engineWords, readVocabulary} from './godot-vocabulary.mjs'

function hidden(name) {
    return {name, kind: 'text', required: false, hidden: true}
}

/** A vocabulary name replaced by the words the engine publishes under it, everywhere it appears. */
function spoken(param, words) {
    const resolved = param.vocabulary ? words[param.vocabulary] : undefined
    return {
        ...param,
        ...(resolved ? {vocabulary: resolved} : {}),
        ...(param.kind === 'choice' && resolved ? {of: resolved} : {}),
        ...(param.of?.kind ? {of: spoken(param.of, words)} : {}),
        ...(param.entry ? {entry: param.entry.map(one => spoken(one, words))} : {})
    }
}

/**
 * The catalogue as the worker receives it, built from the two committed files rather than from a
 * running desktop: `params.json` for the operations and `godot-vocabulary.json` for the words.
 *
 * The same object the Rust `Wire` serializes — summary, resolved parameters — so a test that
 * builds the tool from this is building the tool the model is given.
 */
export async function declaredDomains() {
    const {operations, domains, vocabularies} = JSON.parse(
        await readFile(new URL('../protocol/schemas/v2/params.json', import.meta.url), 'utf8')
    )
    const engine = await readVocabulary()
    const words = Object.fromEntries(
        Object.entries(vocabularies).map(([name, entry]) => [
            name,
            engineWords(engine, entry.engine, `the ${name} vocabulary`)
        ])
    )
    return domains.map(domain => ({
        name: domain.name,
        operations: operations
            .filter(entry => entry.tool === domain.name)
            .map(entry => {
                const params = [
                    ...(entry.params ?? []).map(param => spoken(param, words)),
                    ...(entry.accepts ?? []).map(hidden)
                ]
                return {
                    op: entry.op,
                    summary: entry.summary,
                    params,
                    alone: entry.alone ?? null
                }
            })
    }))
}
