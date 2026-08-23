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
 * The parameter wrapper a model wrote under a key it invented, or nothing.
 *
 * `{"op": "set_autoload", "enabled": true, "path": "res://score.gd", "nameScore": {"name":
 * "Score", "path": "res://score.gd"}}` is what one live turn wrote: the parameter it was about to
 * write glued to the value it was about to write there, and the whole parameter set parked under
 * the result. Refused, resent unchanged, then written as `pathScore` and refused again — three
 * round trips, each answered "has no `nameScore` parameter … Did you mean `name`?", which is the
 * near miss and not the shape.
 *
 * The same repair [`PARAM_KEYS`] already makes, for a wrapper whose name is not on that list.
 * Narrow on purpose, and every clause is load-bearing: the key names no parameter, its object names
 * only parameters and holds every required one, it is the only key in the entry that does, and the
 * entry is missing a required parameter without it. A call that is already complete keeps its stray
 * key and the refusal that names it — a model that wrote a whole wrapper deliberately did not also
 * write the flat parameters.
 */
function gluedWrapperKey(declared, raw, namedBy) {
    if (!Array.isArray(declared)) return undefined
    const names = declared.map(param => param.name)
    const required = declared.filter(param => param.required).map(param => param.name)
    if (required.every(name => name in raw)) return undefined
    const fitting = Object.entries(raw).filter(
        ([key, held]) =>
            key !== namedBy
            && key !== 'ops'
            && !names.includes(key)
            && isObject(held)
            && Object.keys(held).every(inner => names.includes(inner))
            && required.every(name => name in held)
    )
    return fitting.length === 1 ? fitting[0][0] : undefined
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
    const declared = operations.find(operation => operation.op === op)?.params
    const wrapperKey =
        PARAM_KEYS.find(key => isObject(raw[key])) ?? gluedWrapperKey(declared, raw, namedBy)
    const wrapped = wrapperKey ? raw[wrapperKey] : {}
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
/**
 * The one list parameter of `op` whose entries look exactly like `keys`, or nothing.
 *
 * "Exactly" both ways: every required key of an entry is present, and every key present is one an
 * entry declares. A stray carrying anything else is not one of these, and two parameters that both
 * fit make it a guess — neither is folded.
 */
function listParamShapedLike(operations, op, keys) {
    const params = operations.find(operation => operation.op === op)?.params
    if (!Array.isArray(params)) return undefined
    const fitting = params.filter(
        param =>
            param.kind === 'list'
            && Array.isArray(param.entry)
            && param.entry.length > 0
            && param.entry.every(inner => !inner.required || keys.includes(inner.name))
            && keys.every(key => param.entry.some(inner => inner.name === key))
    )
    return fitting.length === 1 ? fitting[0].name : undefined
}

/**
 * The entries a model wrote beside the list they belong in, put back into it.
 *
 * A model asked for several files in one `godot_script edit` writes the first one properly and
 * then, having opened a list already, writes the rest as siblings of the entry instead of siblings
 * of the first file: `[{op: "edit", files: [a]}, b, c]` where it meant `[{op: "edit", files: [a, b,
 * c]}]`. Recorded four times in one project, the largest losing six files at once, and every one
 * refused by validation with `ops.1.op: must have required properties op` — which names the key
 * that is missing and not the list it should have been in.
 *
 * Only a stray with no `op` at all is folded, only into the entry directly before it, and only when
 * one list parameter of that entry's operation is shaped exactly like it. Anything else is left
 * where it is: the router refuses it by name, which is a better sentence than a file quietly folded
 * into an edit it was never part of.
 */
function foldStrayEntries(operations, entries) {
    const kept = []
    for (const entry of entries) {
        const previous = kept.at(-1)
        const name =
            entry.op === undefined && previous !== undefined ?
                listParamShapedLike(operations, previous.op, Object.keys(entry))
            :   undefined
        if (name === undefined || !Array.isArray(previous[name])) kept.push(entry)
        else kept[kept.length - 1] = {...previous, [name]: [...previous[name], entry]}
    }
    return kept
}

/**
 * The operation an entry named its parameters for but never named itself.
 *
 * A model that has written one entry properly writes the ones after it as parameters alone: an
 * `edit` followed by four `{path, timeoutMs}`, which is the pair only `diagnostics` takes. The
 * operation is read back out of the keys, and only when exactly one operation's parameters fit
 * them exactly — every required parameter present, every key a parameter it declares. `{path}` on
 * its own fits four operations and stays a guess, so it is left for the router to refuse by name.
 */
function nameTheOperation(operations, entry) {
    if (entry.op !== undefined) return entry
    const keys = Object.keys(entry)
    if (keys.length === 0) return entry
    const fitting = operations.filter(
        operation =>
            Array.isArray(operation.params)
            && operation.params.every(param => !param.required || keys.includes(param.name))
            && keys.every(key => operation.params.some(param => param.name === key))
    )
    return fitting.length === 1 ? {...entry, op: fitting[0].op} : entry
}

/**
 * The tagged value a model wrapped twice, unwrapped.
 *
 * `{type: "vector2", value: {type: "vector2", value: [32, 48]}}` is what one live turn against a
 * local Qwen3.6-27B wrote 51 times in 114 tool calls. The router refused every one of them by
 * naming the payload it wanted, and the payload it wanted was inside the value it was handed.
 *
 * Only the same tag twice. Two different tags is not a wrapper anybody meant to write, and deciding
 * which of them is the real one is not this layer's to do — the router refuses it and says what it
 * received. A `resource`, whose payload is an object with a `path`, is untouched for the same
 * reason: it is not a tag inside a tag.
 *
 * The same tag, whatever case it is written in, because the two spellings are the protocol's and
 * the engine's. `{type: "string", value: {type: "String", value: "Resume"}}` is one wrapper written
 * by one model that knew both words: the protocol tag outside and Godot's own class name inside.
 * It was refused sixteen times in one live turn — the same call resent unchanged, then split into
 * single properties and resent again — and cost that turn most of its twelve minutes, while the
 * `bool` beside it in the same call went through. Every tag the protocol carries is lowercase and
 * no two of them differ only in case, so the comparison folds case and the unwrapped value keeps
 * the lowercase spelling whichever side wrote it.
 *
 * A tag written once is folded the same way, because it is the same mistake with one wrapper
 * instead of two. The router looks a tag up case-sensitively, so `{type: "String", value:
 * "Resume"}` was refused with "`String` is not a value type" while the double-wrapped form beside
 * it in the same call was repaired.
 */
function unwrapDoubleTag(value) {
    if (!isObject(value) || typeof value.type !== 'string') return value
    const folded =
        value.type === value.type.toLowerCase() ? value : {...value, type: value.type.toLowerCase()}
    const inner = value.value
    if (!isObject(inner) || typeof inner.type !== 'string') return folded
    if (inner.type.toLowerCase() !== value.type.toLowerCase()) return folded
    const keys = Object.keys(inner)
    if (keys.length !== 2 || !keys.includes('type') || !keys.includes('value')) return folded
    return unwrapDoubleTag({type: value.type.toLowerCase(), value: inner.value})
}

/**
 * One entry whose parameter names were written with whitespace around them, written without it.
 *
 * `{"op": "connect_signal", "node ": "/Coin", "signal ": "body_entered", "method": "…"}` is what
 * one live turn wrote three times: the same call, refused three times by name, resent unchanged
 * twice. The router already knew the answer — its refusal reads "has no `node ` parameter … Did you
 * mean `node`?" — and a correction a model reads and resends unchanged is one that cannot help it.
 *
 * The parameter table is walked rather than the entry, so a padded key is only ever renamed onto a
 * name the operation declares, and never onto one the entry already carries. Recursion follows the
 * declared structure alone, so it reaches `set_properties`' entries and stops at a tagged value —
 * whose payload may be a dictionary whose keys are the caller's own.
 */
function trimPaddedKeys(params, entry) {
    if (!Array.isArray(params) || !isObject(entry)) return entry
    const shaped = Object.fromEntries(
        Object.entries(entry).map(([key, held]) => {
            const trimmed = key.trim()
            const renameable =
                trimmed !== key
                && !(trimmed in entry)
                && params.some(param => param.name === trimmed)
            return [renameable ? trimmed : key, held]
        })
    )
    return params.reduce((walked, param) => {
        const held = walked[param.name]
        if (held === undefined || !Array.isArray(param.entry) || param.entry.length === 0)
            return walked
        if (param.kind === 'list' && Array.isArray(held))
            return {...walked, [param.name]: held.map(one => trimPaddedKeys(param.entry, one))}
        if (param.kind === 'object')
            return {...walked, [param.name]: trimPaddedKeys(param.entry, held)}
        return walked
    }, shaped)
}

/**
 * One entry with every value its operation declares as tagged unwrapped, however deep it sits.
 *
 * The parameter table is walked rather than the entry, so this can only reach a key the operation
 * actually declares as a tagged value — `set_property`'s `value`, and the same key inside every
 * entry of `set_properties`' list.
 */
function unwrapTaggedParams(params, entry) {
    if (!Array.isArray(params) || !isObject(entry)) return entry
    return params.reduce((shaped, param) => {
        const held = shaped[param.name]
        if (held === undefined) return shaped
        if (param.kind === 'tagged') return {...shaped, [param.name]: unwrapDoubleTag(held)}
        if (!Array.isArray(param.entry) || param.entry.length === 0) return shaped
        if (param.kind === 'list' && Array.isArray(held))
            return {...shaped, [param.name]: held.map(one => unwrapTaggedParams(param.entry, one))}
        if (param.kind === 'object')
            return {...shaped, [param.name]: unwrapTaggedParams(param.entry, held)}
        return shaped
    }, entry)
}

export function normalizeToolCalls(operations, args) {
    const raw = isObject(args) ? args : {}
    const listed = Array.isArray(raw.ops) ? raw.ops : [raw]
    const entries = foldStrayEntries(
        operations,
        listed.map(entry => normalizeEntry(operations, entry))
    )
    return {
        ops: entries
            .map(entry => nameTheOperation(operations, entry))
            .map(entry => {
                const declared = operations.find(operation => operation.op === entry.op)?.params
                return unwrapTaggedParams(declared, trimPaddedKeys(declared, entry))
            })
    }
}

/**
 * What goes inside a tagged value, said where the model is filling that field in.
 *
 * A live turn wrote `{type: "string", value: {type: "String", value: "Resume"}}` and was refused
 * sixteen times over twelve minutes. Across five such turns 41 of 86 tagged values were wrapped
 * twice. `normalizeToolCall` unwraps them; this stops most of them being written.
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

/**
 * How many times the same call may be refused with the same words before the words change.
 *
 * Two, so a caller hears the real refusal twice — once to read and once to act on — before it hears
 * anything else. The loops this exists for ran far past that: twelve, thirteen, seventeen and
 * twenty-four identical calls in four separate live turns, each answered identically every time.
 */
const REFUSALS_BEFORE_SAYING_SO = 2

/**
 * One value as a string, with every object's keys in the same order however they arrived.
 *
 * The loops this is for wrote byte-identical calls, but a model that reorders two keys between
 * attempts is sending the same call and would otherwise start the count again.
 */
function sameWhateverTheOrder(value) {
    return (
        JSON.stringify(value, (_, held) =>
            held && typeof held === 'object' && !Array.isArray(held) ?
                Object.fromEntries(
                    Object.keys(held)
                        .sort()
                        .map(key => [key, held[key]])
                )
            :   held
        ) ?? ''
    )
}

/**
 * Says so when a caller sends the same call again and gets the same refusal again.
 *
 * Four live turns went into loops that no wording escaped. The worst sent
 * `{"expression": "velocity", "expression}: ": ", ", …}` seventeen times running, and the refusal it
 * met was already the best one available — it named the parameter that was missing, listed the keys
 * that had survived, and said the object rather than the word was what went wrong. The model could
 * not see the key it had written, so it wrote it again.
 *
 * The lever left is not a better sentence, it is a *different* one. Both the arguments and the
 * answer have to match for a call to count as the same: a `runtime.wait` that times out twice is a
 * caller waiting, not a caller stuck, and its answer carries different output each time.
 *
 * It says nothing about *why* the call is refused, because it does not know. The first wording did
 * — "an object coming apart as it is written" — and a live turn met it on a
 * `method_not_found: /Pickup has no method _on_body_entered`, which is a well-formed call about a
 * method that is genuinely not there. A guard that guesses the cause is worse than one that names
 * only what it can see: this call, this answer, this many times.
 *
 * Unmeasured. The loops are reproduced and this is not yet shown to break one; what it does
 * guarantee is that the identical string stops going back a third time.
 */
export function withoutRepeatingARefusal(tool) {
    const heard = new Map()
    return {
        ...tool,
        execute: async (id, params, signal, onUpdate, context) => {
            try {
                return await tool.execute(id, params, signal, onUpdate, context)
            } catch (error) {
                // A cancelled call is not a refused one. The turn was stopped; the caller wrote
                // nothing wrong and must not be told it did.
                if (signal?.aborted || error?.name === 'AbortError') throw error
                const said = error instanceof Error ? error.message : String(error)
                const key = `${sameWhateverTheOrder(params)}\u0000${said}`
                const seen = (heard.get(key) ?? 0) + 1
                heard.set(key, seen)
                if (seen <= REFUSALS_BEFORE_SAYING_SO) throw error
                throw new Error(
                    `${tool.name} has now refused this exact call ${String(seen)} times, with the `
                        + 'same answer every time, and nothing about the project changed between '
                        + 'them. A further one will be refused identically. Whatever is wrong is '
                        + 'in the call itself: build it again from nothing rather than sending the '
                        + 'one you have, or reach the same result another way.'
                )
            }
        }
    }
}

/** One string, cut, saying how long it was. */
function cutString(text, keep) {
    return `${text.slice(0, Math.max(0, keep))}… [truncated, ${String(text.length)} characters]`
}

/** One list, shortened, with a last entry saying how many are missing. */
function cutList(items, keep) {
    const kept = items.slice(0, Math.max(0, keep))
    return [...kept, `… [truncated, ${String(items.length - kept.length)} more entries]`]
}

/** Every list in a value, longest first, with the path that reaches it. */
function listsIn(value) {
    const found = []
    const walk = (node, path) => {
        if (Array.isArray(node)) {
            found.push({path, items: node})
            node.forEach((item, index) => walk(item, [...path, index]))
            return
        }
        if (node !== null && typeof node === 'object')
            for (const [key, item] of Object.entries(node)) walk(item, [...path, key])
    }
    walk(value, [])
    return found.sort((one, other) => other.items.length - one.items.length)
}

/** Every string in a value, with the path that reaches it. */
function stringsIn(value) {
    const found = []
    const walk = (node, path) => {
        if (typeof node === 'string') {
            found.push({path, text: node})
            return
        }
        if (Array.isArray(node)) {
            node.forEach((item, index) => walk(item, [...path, index]))
            return
        }
        if (node !== null && typeof node === 'object')
            for (const [key, item] of Object.entries(node)) walk(item, [...path, key])
    }
    walk(value, [])
    return found
}

function replaceAt(value, path, replacement) {
    if (path.length === 0) return replacement
    const [step, ...rest] = path
    if (Array.isArray(value)) {
        const copy = [...value]
        copy[step] = replaceAt(value[step], rest, replacement)
        return copy
    }
    return {...value, [step]: replaceAt(value[step], rest, replacement)}
}

/** The same answer with no string longer than `cap`. */
function withStringsCappedAt(value, strings, cap) {
    return strings.reduce(
        (shaped, {path, text}) =>
            text.length <= cap ? shaped : replaceAt(shaped, path, cutString(text, cap)),
        value
    )
}

/**
 * The answer, small enough to send, with its structure intact.
 *
 * Slicing the serialized answer was what this did, and it cost the model whole operations. A call
 * is a list, so a `[inspect, inspect, inspect]` whose first node carried a 380,000-character
 * property was cut in the middle of that first entry: the second and third operations were not
 * answered, not refused, and not mentioned — the model had asked three questions and could not tell
 * that two of them were missing. Measured over one project's recorded turns: 71 answers were cut,
 * 36 of them lists, and 23 operations produced nothing the model could see.
 *
 * The strings are cut instead, all of them to one length, which is the largest length they can all
 * keep and still fit. Every operation keeps its entry, every entry keeps its keys, the JSON stays
 * parseable, and each cut says inside itself how long the value really was — the sentence a model
 * needs to decide whether to ask again for less. One length rather than one budget each, because a
 * hundred scripts should each come back with its path and its first lines, not the first one whole
 * and ninety-nine missing.
 *
 * Capping cannot save every answer, and on one shape it makes things worse: four hundred short
 * properties whose longest string is 35 characters, where the marker that replaces one is 28. There
 * the lists are shortened instead, longest first, and each says how many entries went — see
 * [`withLongestListsShortened`]. The slice is what is left for an answer with neither a long string
 * nor a list in it, thousands of small keys and nothing to cut, which is what every oversized answer
 * used to get.
 */
function withinBudget(value, budget) {
    const text = JSON.stringify(value ?? null)
    if (text.length <= budget) return text
    const strings = stringsIn(value)
    if (strings.length === 0) return cutString(text, budget)
    const capped = withStringsCappedAt(value, strings, largestCapThatFits(value, strings, budget))
    const shaped = JSON.stringify(capped ?? null)
    if (shaped.length <= budget) return shaped

    // Capping alone was not enough, so start again from the answer as it arrived rather than from
    // the wreckage. Trimming lists keeps every string it keeps whole, and an answer whose problem
    // is repetition — four hundred properties, a thousand cells — is far more readable as sixty
    // whole entries and a count than as four hundred stubs.
    const trimmed = withLongestListsShortened(value, budget)
    const shortened = JSON.stringify(trimmed ?? null)
    if (shortened.length <= budget) return shortened
    // Both, for an answer that is long lists of long strings.
    return withinBudgetOfLastResort(trimmed, budget)
}

/** Strings capped over an already-shortened answer, and the slice only if even that will not fit. */
function withinBudgetOfLastResort(value, budget) {
    const strings = stringsIn(value)
    const text = JSON.stringify(value ?? null)
    if (strings.length === 0) return text.length > budget ? cutString(text, budget) : text
    const shaped = JSON.stringify(
        withStringsCappedAt(value, strings, largestCapThatFits(value, strings, budget)) ?? null
    )
    return shaped.length > budget ? cutString(text, budget) : shaped
}

/**
 * The longest every string can be cut to and still leave the whole answer inside the budget.
 *
 * Searched over that length rather than over the answer: the structure around the strings costs the
 * same whatever they are cut to, so only the strings are measured again per candidate.
 */
function largestCapThatFits(value, strings, budget) {
    const text = JSON.stringify(value ?? null)
    const structure =
        text.length - strings.reduce((total, one) => total + JSON.stringify(one.text).length, 0)
    const sizeAt = cap =>
        strings.reduce(
            (total, one) =>
                total
                + JSON.stringify(one.text.length <= cap ? one.text : cutString(one.text, cap))
                    .length,
            structure
        )
    let low = 0
    let high = Math.max(...strings.map(one => one.text.length))
    while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (sizeAt(middle) <= budget) low = middle
        else high = middle - 1
    }
    return low
}

/**
 * The answer with its longest list shortened until the whole thing fits, and its shape still intact.
 *
 * Capping strings cannot save an answer that is mostly structure. `godot_node inspect` on a Control
 * is four hundred short properties: a 38,719-character answer whose longest string is 35 characters,
 * so there is no cap that helps — and every cap makes it *worse*, because `… [truncated, N
 * characters]` is 28 characters and most of the strings are shorter than that. Measured on exactly
 * that answer: the search bottomed out, every property name became `… [truncated, 35 characters]`,
 * and the result was sliced anyway. What the model received was 24,031 characters of unparseable
 * rubble claiming 45,680 characters had been dropped — more than the answer had ever held.
 *
 * The list is what to cut there, because the entries are the repetition. The longest one loses its
 * tail, then the next longest, and each says how many entries went. Every key survives, every entry
 * that survives is whole, and the JSON still parses — which is the promise the string capping was
 * written to keep and cannot keep alone.
 *
 * The slice is still the last resort, for an answer with neither a long string nor a list in it.
 */
function withLongestListsShortened(value, budget) {
    let shaped = value
    for (const {path} of listsIn(value)) {
        const items = at(shaped, path)
        if (!Array.isArray(items) || items.length < 2) continue
        let low = 0
        let high = items.length - 1
        while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            const fits =
                JSON.stringify(replaceAt(shaped, path, cutList(items, middle)) ?? null).length
                <= budget
            if (fits) low = middle
            else high = middle - 1
        }
        const cut = replaceAt(shaped, path, cutList(items, low))
        // Only if it actually helped. `… [truncated, N more entries]` is 32 characters, and a list
        // shorter than that costs more to shorten than to keep — an encoded `vector2` is twelve.
        // Every list was cut whether it helped or not, so four hundred vector2 properties went from
        // 31,833 characters to 33,143 with every pair replaced by the marker, and were sliced
        // anyway: the unparseable rubble this was written to stop the string capping making, now
        // with the values gone as well.
        if (JSON.stringify(cut ?? null).length >= JSON.stringify(shaped ?? null).length) continue
        shaped = cut
        if (JSON.stringify(shaped ?? null).length <= budget) return shaped
    }
    return shaped
}

/** The value at a path, or undefined where the path does not reach one. */
function at(value, path) {
    return path.reduce(
        (held, step) => (held === undefined || held === null ? undefined : held[step]),
        value
    )
}

export function toolResult(result) {
    const {described, images} = withoutTheirPixels(result)
    return {
        content: [{type: 'text', text: withinBudget(described, MAX_TOOL_TEXT_CHARS)}, ...images],
        details: result
    }
}
