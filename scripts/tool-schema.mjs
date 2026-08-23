/**
 * The JSON Schema a domain's operations are advertised under, generated from the same parameter
 * table the router holds a call to.
 *
 * The two are generated together so what the model is shown and what the call is checked against
 * cannot say different things. Where a schema cannot explain a refusal — which parameters belong to
 * which operation — it deliberately stays open and leaves the sentence to `tool_params::check`.
 */

/**
 * The parameter list an operation declares, as ` {node, property, value, expectedRevision}`.
 *
 * Rust sends it beside the summary, generated from the same table that refuses a call, so what the
 * model is told and what the router accepts cannot drift apart. An operation with no table sends no
 * signature and reads exactly as it did before — absence is "not written down yet", never "takes
 * nothing", so nothing is quietly advertised as parameterless.
 */
export function signatureOf(operation) {
    return operation.signature ? ` ${operation.signature}` : ''
}

/**
 * What goes inside a tagged value, said where the model is filling that field in.
 *
 * A live turn wrote `{type: "string", value: {type: "String", value: "Resume"}}` and was refused
 * sixteen times over twelve minutes. Across five such turns 41 of 86 tagged values were wrapped
 * twice. `tool_params::repair_tagged` unwraps them; this stops most of them being written.
 */
const TAGGED_PAYLOAD =
    'The payload is the bare value itself: a string, a number, an array of numbers, or {path} for'
    + ' a resource. Never a second {type, value} pair around it.'

/**
 * One parameter's kind as JSON Schema, from the kind the router enforces.
 *
 * The two are generated from the same table, so what the model is shown and what the call is held
 * to cannot say different things. Before this, every operation's parameters were one
 * `additionalProperties: true` object: the model was told a tool takes "parameters", and found out
 * what kind each one was by getting it wrong.
 */
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
            // Sixty-four lowercase hex characters. A caller copies this one by hand, and a copy
            // that drops a character is not a string problem — see `Kind::Hash`.
            return {type: 'string', pattern: '^[0-9a-f]{64}$'}
        case 'choice':
            return {type: 'string', enum: kind.of ?? []}
        case 'tagged':
            // The protocol's own `{type, value}` pair. `value` carries no type, deliberately: what
            // it may hold depends on `type`, and only the engine knows whether it fits. What it
            // carries instead is the one sentence that stops the pair being written twice.
            //
            // Measured interleaved against a local Qwen3.6-27B, 15 seeds, one scenario that sets
            // three properties: the shipped schema wrote a double-wrapped value in 12 turns of 15
            // and in 36 of the 45 values it wrote. The same sentence appended to the operation's
            // summary instead — where the tags are already listed with correct examples — reached
            // 10 of 15. Here it reached 0 of 15 and 0 of 45. Prose the model reads is not prose the
            // model is held to; this is the field it fills in.
            return {
                type: 'object',
                properties: {type: {type: 'string'}, value: {description: TAGGED_PAYLOAD}},
                required: ['type', 'value']
            }
        case 'either':
            return {anyOf: (kind.of ?? []).map(jsonSchemaOfKind)}
        // A kind the router knows and this does not. Constraining it to nothing would refuse calls
        // that are right, so it is left open and the router remains the one that decides.
        default:
            return {}
    }
}

/** One parameter, with whatever its kind cannot say written into its description. */
export function jsonSchemaOfParam(param) {
    const schema = jsonSchemaOfKind(param)
    const inside = Array.isArray(param.entry) && param.entry.length > 0
    // What one entry holds, where the kind stops at the outermost bracket. `files: list` says
    // nothing about the `{path, edits}` inside it, and a live turn nested five files inside each
    // other's `edits` on exactly that gap.
    if (inside && param.kind === 'list') schema.items = jsonSchemaOfParams(param.entry)
    if (inside && param.kind === 'object') Object.assign(schema, jsonSchemaOfParams(param.entry))
    // A vocabulary names words a key *inside* the entries accepts, which no kind can reach.
    const words =
        Array.isArray(param.vocabulary) && param.vocabulary.length > 0 ?
            `Each entry's \`key\` is one of: ${param.vocabulary.join(', ')}.`
        :   ''
    const description = [param.note, words].filter(Boolean).join(' ')
    return description ? {...schema, description} : schema
}

/**
 * An object schema from a parameter list, closed so an invented key is visibly not a parameter.
 *
 * A hidden parameter is a property here even though it is left out of the signature. Hidden means
 * "accepted and not advertised", and the schema is now what a call is checked against before the
 * router ever sees it — so leaving it out would make a parameter the router accepts one that
 * nothing can send. `scene` is the whole population, and a real editor answered exactly that:
 * `ops.0: must not have additional properties`, about the parameter every node command takes.
 */
export function jsonSchemaOfParams(params) {
    return {
        type: 'object',
        properties: Object.fromEntries(params.map(param => [param.name, jsonSchemaOfParam(param)])),
        required: params.filter(param => param.required).map(param => param.name),
        additionalProperties: false
    }
}

/**
 * One entry of the `ops` list: an operation of this domain, with this domain's parameters typed.
 *
 * Which parameters belong to which operation is left to the router, deliberately, and this is the
 * measurement behind that. A schema that branches per operation — `anyOf` of one closed object per
 * `op` — refuses a call by reporting every branch it did not match: `save` with a missing `text`
 * came back as eight lines, of which two were `must be equal to constant` about operations the
 * caller never named. `if`/`then` reports one line instead, and the line is `must match "then"
 * schema`, which names neither the parameter nor the operation. Neither is something a model can
 * act on, and a refusal it cannot act on is the failure this whole contract exists to prevent.
 *
 * So the types are enforced here, where an error is about one named key — `/ops/0/path must be
 * string` — and the operation's own parameter list is enforced in `tool_params::check`, which names
 * the parameter, says what arrived, and prints the corrected call with the caller's own values in
 * it. Both are generated from the same table, so neither can drift from the other.
 *
 * Two names in the whole catalog mean different shapes in different operations of one domain —
 * `path` and `files` — and they widen to accept either. Widening only moves the refusal to the
 * layer that can explain it.
 */
export function jsonSchemaOfEntry(operations) {
    const byName = new Map()
    const described = new Map()
    for (const operation of operations) {
        if (!Array.isArray(operation.params)) continue
        for (const param of operation.params) {
            const shapes = byName.get(param.name) ?? []
            // Flattened, and only ever one level deep: a parameter that is already an either, met
            // in a second operation as something else, would otherwise nest an anyOf inside an
            // anyOf — and every level of that nesting is another line in the refusal, all of them
            // about the same key.
            const shape = jsonSchemaOfParam(param)
            const {anyOf, description, ...rest} = shape
            for (const one of anyOf ?? [rest]) {
                const already = shapes.some(seen => JSON.stringify(seen) === JSON.stringify(one))
                if (!already) shapes.push(one)
            }
            byName.set(param.name, shapes)
            // The sentence rides on the merged property rather than on one of the branches, which
            // is where it would land for an either — six of them say what the two shapes mean.
            if (description) described.set(param.name, description)
        }
    }
    const properties = Object.fromEntries(
        [...byName].map(([name, shapes]) => {
            const merged = shapes.length === 1 ? shapes[0] : {anyOf: shapes}
            const description = described.get(name)
            return [name, description ? {...merged, description} : merged]
        })
    )
    return {
        type: 'object',
        properties: {
            op: {
                type: 'string',
                enum: operations.map(operation => operation.op),
                description: 'The operation this entry runs.'
            },
            ...properties
        },
        required: ['op'],
        // Open, for the same reason the parameter list is not branched per operation: a key no
        // operation declares comes back from here as `must not have additional properties`, which
        // names neither the key nor the operation, and comes back from the router as `godot_node
        // inspect has no `depth` parameter. It takes {node: text}. Did you mean `node`?`.
        additionalProperties: true
    }
}
