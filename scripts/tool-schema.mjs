import {tagPayloads} from './godot-vocabulary.mjs'

/**
 * Where the 36 tag branches live, once, for every tagged parameter to point at.
 *
 * llama.cpp constrains a `$ref` into the tool's own `$defs` — `scripts/bench/ref-probe.mjs` asked
 * for a Vector2 payload written as a string under one and the sampler could not write it — and so
 * do pi-ai's TypeBox validator and ajv. So the branches are named once rather than copied into
 * every tagged parameter, which is what closing them by inlining would have cost.
 */
export const TAGGED_VALUE_REF = '#/$defs/taggedValue'

/** The words a parameter accepts, when it names a vocabulary and its kind is one a word fits. */
function wordsOf(kind) {
    return Array.isArray(kind.vocabulary) && kind.vocabulary.length > 0 ?
            kind.vocabulary
        :   undefined
}

export function jsonSchemaOfKind(kind) {
    switch (kind.kind) {
        case 'text': {
            const words = wordsOf(kind)
            return words ? {type: 'string', enum: words} : {type: 'string'}
        }
        case 'int':
            return {type: 'integer'}
        case 'number':
            return {type: 'number'}
        case 'flag':
            return {type: 'boolean'}
        case 'object':
            return {type: 'object'}
        case 'list':
            return {type: 'array'}
        case 'hash':
            return {type: 'string', pattern: '^[0-9a-f]{64}$'}
        case 'choice':
            return {type: 'string', enum: kind.of ?? []}
        case 'tagged':
            return {$ref: TAGGED_VALUE_REF}
        case 'listOf':
            return {type: 'array', items: jsonSchemaOfKind(kind.of ?? {kind: 'text'})}
        default:
            return {}
    }
}

// A parameter is its shape and nothing else: no `description`, no vocabulary sentence beside the
// `enum`. Both were measured out — the sampler wrote one of the 25 names the sentence recited, and
// the arm with every per-parameter note cut tied on success 2,500 tokens a turn cheaper.
export function jsonSchemaOfParam(param) {
    const schema = jsonSchemaOfKind(param)
    const inside = Array.isArray(param.entry) && param.entry.length > 0
    if (inside && param.kind === 'list') schema.items = jsonSchemaOfParams(param.entry)
    if (inside && param.kind === 'object') Object.assign(schema, jsonSchemaOfParams(param.entry))
    if ('minItems' in param) schema.minItems = param.minItems
    if ('default' in param) schema.default = param.default
    return schema
}

// A hidden parameter is the router's to fill in. Leaving it in the schema lets the grammar permit
// the one key the prose forbids, and a live turn wrote it.
export function jsonSchemaOfParams(params) {
    const visible = params.filter(param => !param.hidden)
    return {
        type: 'object',
        properties: Object.fromEntries(
            visible.map(param => [param.name, jsonSchemaOfParam(param)])
        ),
        required: visible.filter(param => param.required).map(param => param.name),
        additionalProperties: false
    }
}

// One branch per op rather than every op's parameters merged into one open object: the merged
// shape made a bare {op} and any key at all legal, so a constrained sampler wrote keys that
// swallowed their value ("nameUnit1") and the router had to repair what it should never receive.
// The summary is in the tool description already; a copy here cost 5,286 tokens a turn.
export function jsonSchemaOfEntry(operations) {
    return {
        oneOf: operations.map(operation => {
            const body = jsonSchemaOfParams(operation.params ?? [])
            return {
                type: 'object',
                properties: {
                    op: {const: operation.op},
                    ...body.properties
                },
                required: ['op', ...body.required],
                additionalProperties: false
            }
        })
    }
}

/** Every tagged parameter of every operation, however deep its entry list goes. */
function taggedParams(params) {
    return (params ?? []).flatMap(param =>
        param.kind === 'tagged' ? [param] : taggedParams(param.entry)
    )
}

/**
 * The `$defs` block the tagged parameters point at, or nothing when no operation takes one.
 *
 * One branch per tag, each pinning its own payload, so a payload the tag cannot carry is refused
 * by the grammar the sampler is constrained by rather than by a sentence three layers later.
 */
export function taggedValueDefs(operations) {
    const spoken = operations.flatMap(operation => taggedParams(operation.params))
    if (spoken.length === 0) return undefined
    const words = spoken.map(param => (wordsOf(param) ?? []).join(','))
    if (new Set(words).size > 1)
        throw new Error(
            'the tagged parameters speak more than one vocabulary, so they cannot share one $defs'
        )
    const payloads = tagPayloads(TAGGED_VALUE_REF)
    return {
        taggedValue: {
            oneOf: (wordsOf(spoken[0]) ?? []).map(tag => {
                const payload = payloads[tag]
                if (!payload) throw new Error(`the tag ${tag} has no payload shape`)
                return {
                    type: 'object',
                    properties: {type: {const: tag}, value: payload},
                    required: ['type', 'value'],
                    additionalProperties: false
                }
            })
        }
    }
}
