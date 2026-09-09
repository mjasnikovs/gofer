// The schema helper as it stood when these arms were measured (commit 4ba1aaa). The live one has
// moved on (enums, a closed tagged value); the arms it built are evidence and must not move with it.
export function signatureOf(operation) {
    return operation.signature ? ` ${operation.signature}` : ''
}

const TAGGED_PAYLOAD =
    'The payload is the bare value itself: a string, a number, an array of numbers, or {path} for'
    + ' a resource. Never a second {type, value} pair around it.'

export function jsonSchemaOfKind(kind) {
    switch (kind.kind) {
        case 'text':
            return {type: 'string'}
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
            return {
                type: 'object',
                properties: {type: {type: 'string'}, value: {description: TAGGED_PAYLOAD}},
                required: ['type', 'value']
            }
        case 'either':
            return {anyOf: (kind.of ?? []).map(jsonSchemaOfKind)}
        case 'listOf':
            return {type: 'array', items: jsonSchemaOfKind(kind.of ?? {kind: 'text'})}
        default:
            return {}
    }
}

export function jsonSchemaOfParam(param) {
    const schema = jsonSchemaOfKind(param)
    const inside = Array.isArray(param.entry) && param.entry.length > 0
    if (inside && param.kind === 'list') schema.items = jsonSchemaOfParams(param.entry)
    if (inside && param.kind === 'object') Object.assign(schema, jsonSchemaOfParams(param.entry))
    const words =
        Array.isArray(param.vocabulary) && param.vocabulary.length > 0 ?
            `Each entry's \`key\` is one of: ${param.vocabulary.join(', ')}.`
        :   ''
    const description = [param.note, words].filter(Boolean).join(' ')
    return description ? {...schema, description} : schema
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
