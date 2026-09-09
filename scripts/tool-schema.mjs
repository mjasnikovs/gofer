export function signatureOf(operation) {
    return operation.signature ? ` ${operation.signature}` : ''
}

const TAGGED_PAYLOAD =
    'The payload is the bare value itself: a string, a number, an array of numbers, or {path} for'
    + ' a resource. Never a second {type, value} pair around it.'

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
        case 'tagged': {
            const words = wordsOf(kind)
            return {
                type: 'object',
                properties: {
                    type: words ? {type: 'string', enum: words} : {type: 'string'},
                    value: {description: TAGGED_PAYLOAD}
                },
                required: ['type', 'value']
            }
        }
        case 'either':
            return {anyOf: (kind.of ?? []).map(jsonSchemaOfKind)}
        case 'listOf':
            return {type: 'array', items: jsonSchemaOfKind(kind.of ?? {kind: 'text'})}
        default:
            return {}
    }
}

// A vocabulary is the parameter's `enum` and no sentence beside it: measured, the same enum with
// the old 25-name sentence next to it lost, because the sampler wrote one of the 25.
export function jsonSchemaOfParam(param) {
    const schema = jsonSchemaOfKind(param)
    const inside = Array.isArray(param.entry) && param.entry.length > 0
    if (inside && param.kind === 'list') schema.items = jsonSchemaOfParams(param.entry)
    if (inside && param.kind === 'object') Object.assign(schema, jsonSchemaOfParams(param.entry))
    return param.note ? {...schema, description: param.note} : schema
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

/** The one word a signature spells a kind with. See `short` in tool_params.rs. */
function short(kind) {
    switch (kind.kind) {
        case 'listOf':
            return 'list'
        // A choice is text from a fixed set, and the schema carries which words. Spelling it
        // "choice" would name the declaration rather than what goes in the call.
        case 'choice':
            return 'text'
        case 'either':
            return 'either'
        default:
            return kind.kind
    }
}

/**
 * The signature the model reads, as `{node, property, value}`.
 *
 * The same string `signature` in tool_params.rs prints, because the model reads Rust's at runtime
 * and this one is what the committed `godot-tool.json` is built from. A Rust test holds the two
 * together over every operation; that is cheaper than teaching one of them to call the other
 * across a process boundary that only exists when an editor is running.
 */
export function signatureFrom(params) {
    const visible = params.filter(param => !param.hidden)
    if (visible.length === 0) return ''
    const names = visible.map(param => {
        const mark = param.required ? '' : '?'
        if (param.kind === 'choice')
            return `${param.name}${mark}: ${(param.of ?? []).map(word => `"${word}"`).join('|')}`
        if (Array.isArray(param.entry) && param.entry.length > 0)
            return param.kind === 'object' ?
                    `${param.name}${mark}: ${signatureFrom(param.entry)}`
                :   `${param.name}${mark}: ${short(param)} of ${signatureFrom(param.entry)}`
        if (param.kind === 'either')
            return `${param.name}${mark}: ${(param.of ?? []).map(short).join('|')}`
        if (param.kind === 'listOf')
            return `${param.name}${mark}: list of ${short(param.of ?? {kind: 'text'})}`
        return `${param.name}${mark}: ${short(param)}`
    })
    return `{${names.join(', ')}}`
}
