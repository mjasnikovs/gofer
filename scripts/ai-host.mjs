/**
 * The worker's half of the duplex channel to Rust.
 *
 * Rust sends the startup context as the first stdin line and then answers tool requests on the
 * same stream; the worker writes agent events and tool requests to stdout, each on its own line
 * behind its own prefix so unprefixed diagnostics stay diagnostics. Nothing here implements a
 * Godot operation: every tool call is forwarded, and the router in `src-tauri/src/ai_tools.rs` is
 * the only place an operation exists.
 */

/** Beyond this, a tool result is summarized for the model. Details keep the whole value. */
const MAX_TOOL_TEXT_CHARS = 24_000

export const EVENT_PREFIX = 'GOFER_AI_EVENT:'
export const TOOL_PREFIX = 'GOFER_AI_TOOL:'
export const CREDENTIAL_PREFIX = 'GOFER_AI_CREDENTIAL:'

/**
 * Correlates outgoing tool requests with the results Rust sends back.
 *
 * A pending call is settled exactly once — by a result, by the caller's AbortSignal, or by the
 * channel closing — because an agent turn that ends with a promise nobody will ever resolve hangs
 * the worker instead of failing it.
 *
 * `channel` names the id space. Rust answers on one stream that every host reads, so two hosts
 * counting from one would both claim the reply to `call-1` and one of them would settle a promise
 * that was never its own.
 */
export function createToolHost(send, channel = 'call') {
    const pending = new Map()
    let nextId = 0
    let closed
    return {
        call(tool, params, signal) {
            return new Promise((resolve, reject) => {
                if (closed) return reject(new Error(closed))
                if (signal?.aborted) return reject(new Error('The tool call was cancelled'))
                const id = `${channel}-${String((nextId += 1))}`
                const settle = outcome => {
                    if (!pending.delete(id)) return
                    if (outcome.ok) resolve(outcome.result)
                    else reject(outcome.error)
                }
                pending.set(id, settle)
                signal?.addEventListener(
                    'abort',
                    () => settle({ok: false, error: new Error('The tool call was cancelled')}),
                    {once: true}
                )
                // A write that throws — a closed stdout — must fail this call rather than leave a
                // promise the backend can no longer answer.
                try {
                    send({id, tool, params})
                } catch (error) {
                    settle({ok: false, error})
                }
            })
        },
        deliver(message) {
            if (!message || message.type !== 'tool-result') return
            const settle = pending.get(String(message.id))
            if (!settle) return
            if (message.ok) return settle({ok: true, result: message.result})
            const error = message.error ?? {}
            settle({
                ok: false,
                error: new Error(
                    `${error.code ?? 'tool_failed'}: ${error.message ?? 'The tool call failed'}`
                )
            })
        },
        close(reason) {
            closed = reason
            for (const settle of [...pending.values()])
                settle({ok: false, error: new Error(reason)})
        },
        get pendingCount() {
            return pending.size
        }
    }
}

/**
 * The parameter list an operation declares, as ` {node, property, value, expectedRevision}`.
 *
 * Rust sends it beside the summary, generated from the same table that refuses a call, so what the
 * model is told and what the router accepts cannot drift apart. An operation with no table sends no
 * signature and reads exactly as it did before — absence is "not written down yet", never "takes
 * nothing", so nothing is quietly advertised as parameterless.
 */
function signatureOf(operation) {
    return operation.signature ? ` ${operation.signature}` : ''
}

/** The names a model writes the parameter wrapper under. `params` is the one the schema declares. */
const PARAM_KEYS = ['params', 'parameters', 'arguments', 'args', 'input']

/**
 * The names a model writes the operation under. `op` is the one the schema declares.
 *
 * `operation` is the word the summaries and this prompt use in prose, and a live turn wrote it into
 * the JSON: `{"operation": "save", "path": …}`, refused by validation with four `must not have
 * additional properties` lines that never mentioned the word it should have used.
 *
 * `method` and `name` are deliberately not here. Both are real parameters — `connect_signal` takes
 * a `method`, half the project domain takes a `name` — so reading either as the operation would
 * throw away a value the caller meant.
 */
const OP_KEYS = ['op', 'operation', 'action']

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One entry of an `ops` list, out of whatever the model wrote for it.
 *
 * Every shape here was counted in the recorded turns of four projects, not imagined. A model that
 * reads the operation line writes what that line shows and puts the wrapper wherever: the whole
 * parameter list flat beside `op` (`{op: "open", path}`, nine calls), the wrapper under the name
 * the schema gives it in prose rather than in JSON (`parameters`, ten calls), one parameter hoisted
 * out of an otherwise correct wrapper (`expectedRevision`, one call), or no `op` at all on a tool
 * that has only one (four calls). All twenty-four were refused, each costing a round trip, and none
 * of them was ambiguous.
 *
 * Flat is what the schema now asks for, so the wrapper shapes are the ones being repaired rather
 * than the ones being accepted. A flat key is kept only when the operation declares a parameter by
 * that name — the catalog carries the same table that refuses the call, so this cannot invent a
 * parameter the router would then reject. An explicit wrapper still wins over a flat key of the
 * same name, because a model that wrote both meant the one it wrote deliberately.
 */
function normalizeEntry(operations, args) {
    const raw = isObject(args) ? args : {}
    const only = operations.length === 1 ? operations[0].op : undefined
    const namedBy = OP_KEYS.find(key => typeof raw[key] === 'string')
    const op = namedBy ? raw[namedBy] : only
    const wrapperKey = PARAM_KEYS.find(key => isObject(raw[key]))
    const wrapped = wrapperKey ? raw[wrapperKey] : {}
    const declared = operations.find(operation => operation.op === op)?.params
    // An unknown key is only dropped when a wrapper was written as well, which is the shape this
    // filter was measured on: the parameters in their wrapper, and something else loose beside it.
    // With flat as the shape the schema asks for, a lone unknown key is not stray metadata — it is
    // the mistake, and `tool_params::check` refuses it by name with the parameters it does take and
    // a `Did you mean` for the near miss. Dropping it here would run the call without it instead.
    const dropUnknown = wrapperKey !== undefined && Array.isArray(declared)
    const salvaged = Object.fromEntries(
        Object.entries(raw).filter(
            ([key]) =>
                key !== namedBy
                && key !== 'ops'
                && key !== wrapperKey
                && (!dropUnknown || declared.some(param => param.name === key))
        )
    )
    return {...salvaged, ...wrapped, ...(op === undefined ? {} : {op})}
}

/**
 * The `{ops: [...]}` call a model meant, out of the one it wrote.
 *
 * Every call is a list, including a call of one operation, so that a model wanting three
 * inspections writes one call rather than three. It would not write three otherwise: ten live
 * sweeps recorded it calling one domain operation per turn and waiting for each, and never once
 * emitting parallel tool calls of its own even where the harness runs them in parallel.
 *
 * A bare entry — no `ops` at all, just an operation and its parameters — becomes a list of one
 * rather than a refusal. That is the previous shape, and it is what a model reaches for when it
 * only wants one thing; refusing it would spend a round trip teaching a bracket.
 */
export function normalizeToolCalls(operations, args) {
    const raw = isObject(args) ? args : {}
    const listed = Array.isArray(raw.ops) ? raw.ops : [raw]
    return {ops: listed.map(entry => normalizeEntry(operations, entry))}
}

/**
 * One parameter's kind as JSON Schema, from the kind the router enforces.
 *
 * The two are generated from the same table, so what the model is shown and what the call is held
 * to cannot say different things. Before this, every operation's parameters were one
 * `additionalProperties: true` object: the model was told a tool takes "parameters", and found out
 * what kind each one was by getting it wrong.
 */
function jsonSchemaOfKind(kind) {
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
            // The protocol's own `{type, value}` pair. `value` is deliberately unconstrained: what
            // it may hold depends on `type`, and only the engine knows whether it fits.
            return {
                type: 'object',
                properties: {type: {type: 'string'}, value: {}},
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
function jsonSchemaOfParam(param) {
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
function jsonSchemaOfParams(params) {
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
function jsonSchemaOfEntry(operations) {
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

/**
 * Builds one agent tool per domain in the catalog Rust sent. The operations are the router's, so a
 * tool the model can call always has a handler and one it cannot call never does.
 *
 * Every call is an `ops` list, including a call of one operation. Ten live sweeps recorded the
 * model calling one operation per turn and waiting for each — three inspections of three nodes as
 * three turns — and never once emitting parallel tool calls of its own, though the harness runs
 * them in parallel when it does. A list is what makes the batch reachable without asking the model
 * to choose between two shapes on every call.
 *
 * Parameters sit beside `op` rather than under a wrapper, because flat is what models write
 * unprompted: nine of the twenty-four miswritten calls counted across four projects were flat
 * against a schema that asked for a wrapper. Everything else they get wrong is repaired by
 * [`normalizeToolCalls`].
 */
export function createGodotTools(domains, host) {
    if (!Array.isArray(domains)) return []
    return domains.map(domain => {
        // Two narrowings, and they read differently to a caller. `exclusive` is an operation that
        // cannot share a call at all; `repeat` is one that may sit beside anything and may not
        // appear twice. Naming them together as "alone" is what produced ten refusals across ten
        // of sixteen live tasks, every one of them a two-step list the router could already run.
        const exclusive = domain.operations.filter(
            operation => operation.alone?.scope === 'exclusive'
        )
        const once = domain.operations.filter(operation => operation.alone?.scope === 'repeat')
        return {
            name: domain.name,
            label: domain.name.replace(/_/gu, ' '),
            description: `${domain.description}\nOperations:\n${domain.operations
                .map(operation => {
                    const narrowing =
                        operation.alone?.scope === 'exclusive' ?
                            ` (only entry of its call: ${operation.alone.why})`
                        : operation.alone ? ` (not twice in one call: ${operation.alone.why})`
                        : ''
                    return `- ${operation.op}${signatureOf(operation)}: ${operation.summary}${narrowing}`
                })
                .join('\n')}`,
            parameters: {
                type: 'object',
                properties: {
                    ops: {
                        type: 'array',
                        minItems: 1,
                        description:
                            'The operations to run, in order, each with its parameters beside'
                            + ' its `op`. One operation is a list of one; several run in this'
                            + ' one call rather than one call each.'
                            + (exclusive.length > 0 ?
                                ` These have to be the only entry of their call: ${exclusive
                                    .map(operation => operation.op)
                                    .join(', ')}.`
                            :   '')
                            + (once.length > 0 ?
                                ` These may sit beside others and may not appear twice: ${once
                                    .map(operation => operation.op)
                                    .join(', ')}.`
                            :   ''),
                        items: jsonSchemaOfEntry(domain.operations)
                    }
                },
                required: ['ops']
            },
            // Repair runs here rather than inside `execute`, because the agent loop validates the
            // arguments against the schema above in between, and a call reshaped after that point
            // has already been refused. `prepareArguments` is the one hook that runs before it: a
            // model that wrote the parameters under a wrapper now passes validation instead of
            // spending a round trip on a bracket.
            prepareArguments: args => normalizeToolCalls(domain.operations, args),
            execute: async (_toolCallId, args, signal) => {
                const result = await host.call(domain.name, args, signal)
                return toolResult(result)
            }
        }
    })
}

/** A captured frame as an image part, or nothing when this answer holds no frame. */
function pictureOf(answer) {
    const frame = answer?.frame
    return frame?.encoding === 'png-base64' && typeof frame.data === 'string' ?
            {type: 'image', data: frame.data, mimeType: 'image/png'}
        :   undefined
}

/** The same answer with the frame's bytes replaced by its shape. */
function withoutPixels(answer) {
    const {encoding, width, height} = answer.frame
    return {...answer, frame: {encoding, width, height}}
}

/**
 * Every captured frame in a call, lifted out of the JSON.
 *
 * A call is a list, so a capture can sit in any entry of it and a call may hold several — a run and
 * a capture, or one capture of the game beside one of the editor. Each becomes its own image part,
 * and the JSON keeps the frame's shape where the bytes were so the entry still reads as an answer.
 */
function withoutTheirPixels(result) {
    const entries = result?.ops
    if (!Array.isArray(entries)) {
        const image = pictureOf(result)
        return {described: image ? withoutPixels(result) : result, images: image ? [image] : []}
    }
    const images = []
    const described = entries.map(entry => {
        const image = pictureOf(entry?.result)
        if (!image) return entry
        images.push(image)
        return {...entry, result: withoutPixels(entry.result)}
    })
    return {described: {...result, ops: described}, images}
}

/**
 * Turns a tool result into model-visible content. A captured frame becomes a real image part —
 * base64 PNG in a text blob is worth nothing to the model and would swamp the context — and the
 * remaining JSON is bounded, because a scene tree is allowed to be large.
 */
/**
 * The same tool, with every picture taken out of what it answers.
 *
 * `read` hands back a real image part for a PNG, and a model with no vision refuses the whole
 * request rather than the part it cannot use: one llama.cpp turn died on `failed to process mtmd
 * chunk` after the agent read a tileset to match the game's art. A tool result the model cannot use
 * must cost it nothing, so the bytes are replaced by a sentence saying what was there.
 *
 * Applied by whoever knows the model, because only they do — the parent and its child may be
 * different models with different eyes.
 */
export function withoutPictures(tool) {
    return {
        ...tool,
        execute: async (id, params, signal, onUpdate, context) => {
            const result = await tool.execute(id, params, signal, onUpdate, context)
            const parts = result?.content
            if (!Array.isArray(parts) || !parts.some(part => part?.type === 'image')) return result
            return {
                ...result,
                content: parts.map(part =>
                    part?.type === 'image' ?
                        {
                            type: 'text',
                            text:
                                `[a ${String(part.mimeType ?? 'image')} you cannot see: this model `
                                + 'takes text only. Ask the user about it, or capture the game and '
                                + 'describe what you need from the answer.]'
                        }
                    :   part
                )
            }
        }
    }
}

export function toolResult(result) {
    const {described, images} = withoutTheirPixels(result)
    let text = JSON.stringify(described ?? null)
    if (text.length > MAX_TOOL_TEXT_CHARS)
        text = `${text.slice(0, MAX_TOOL_TEXT_CHARS)}… [truncated, ${String(text.length)} characters]`
    return {
        content: [{type: 'text', text}, ...images],
        details: result
    }
}
