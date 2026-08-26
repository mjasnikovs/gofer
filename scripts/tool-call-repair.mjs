/**
 * The shape of a tool call a model wrote, turned into the one the schema accepts.
 *
 * Nothing here decides what an operation does, and nothing here decides what a value means. Repair
 * has one home, `src-tauri/src/tool_params.rs`, on the same table that refuses a call — so the
 * acceptance suites, the desktop client and every direct `dispatch` get the repairs the model gets.
 * This layer holds only what that one can no longer reach: the agent loop validates a call against
 * the generated schema between `prepareArguments` and the router, so a shape the schema refuses
 * outright never arrives at the table at all.
 *
 * That is the whole membership rule, and it is exactly four shapes: the `ops` bracket, the `op`
 * naming an entry, the wrapper the parameters were parked under, and a padded key inside a nested
 * entry — whose schema, unlike the entry's own, is closed and requires its own names.
 *
 * Each repair is one counted mistake from recorded live turns — the count is in the comment above
 * it — and each one is narrow enough that a call nobody got wrong comes out unchanged. What a
 * repair cannot name for certain is left alone, so the router refuses it by name rather than
 * running something the caller never asked for.
 */

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
 * The shape "exactly", written once: every required declared entry has its name held, and every
 * held name belongs to a declared entry. It was written three — `gluedWrapperKey`,
 * `listParamShapedLike`, `nameTheOperation` — over three slightly different tables, and three
 * copies of one clause are three chances for one to drift from the other two while each copy
 * still reads true on its own.
 */
function exactFit(declared, keys) {
    return (
        declared.every(param => !param.required || keys.includes(param.name))
        && keys.every(key => declared.some(param => param.name === key))
    )
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
export function gluedWrapperKey(declared, raw, namedBy) {
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
            && exactFit(declared, Object.keys(held))
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
export function normalizeEntry(operations, args) {
    // An entry written as the operation's name and nothing else. `{"ops": ["wait", {"op": "wait",
    // "ms": 2200}, …]}` is what one live turn wrote — the first entry as a bare string, the three
    // after it properly — and the whole call was refused with `ops.0.op: must have required
    // properties op`, which is pi's own sentence and not one this repo can improve. A string is
    // never a valid entry, and a string that is one of this domain's operation names carries no
    // other reading.
    if (typeof args === 'string' && operations.some(operation => operation.op === args))
        return {op: args}
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
export function listParamShapedLike(operations, op, keys) {
    const params = operations.find(operation => operation.op === op)?.params
    if (!Array.isArray(params)) return undefined
    const fitting = params.filter(
        param =>
            param.kind === 'list'
            && Array.isArray(param.entry)
            && param.entry.length > 0
            && exactFit(param.entry, keys)
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
export function foldStrayEntries(operations, entries) {
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
 * The one entry of a list, written flat on the operation instead of inside the list.
 *
 * `{op: "edit", path: "scripts/player.gd", edits: [...]}` where `godot_script edit` takes
 * `{files: [{path, edits}]}`. Three times across two live turns on 2026-08-25, and the router's
 * refusal — "godot_script edit has no `path` parameter. It takes {files: list of {path: text,
 * edits: list of {oldText: text, newText: text}}}" — was resent in the same shape once.
 *
 * The same mistake `foldStrayEntries` already repairs, one bracket earlier: there the entries after
 * the first are written beside the list, here the only entry is written instead of it. So it is the
 * same test — `listParamShapedLike` — asked about the entry's own keys.
 *
 * Three guards, and each one is a call this must not touch. The list has to be absent, or the model
 * meant both. Exactly one list parameter may fit, or folding is a guess. And no key may be a
 * parameter the operation declares itself, because then the flat shape is the right one and the
 * resemblance is a coincidence.
 */
export function foldFlatEntry(operations, entry) {
    if (typeof entry.op !== 'string') return entry
    const params = operations.find(operation => operation.op === entry.op)?.params
    if (!Array.isArray(params)) return entry
    const {op, ...rest} = entry
    const keys = Object.keys(rest)
    if (keys.length === 0) return entry
    if (keys.some(key => params.some(param => param.name === key))) return entry
    const name = listParamShapedLike(operations, op, keys)
    if (name === undefined || entry[name] !== undefined) return entry
    return {op, [name]: [rest]}
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
export function nameTheOperation(operations, entry) {
    if (entry.op !== undefined) return entry
    const keys = Object.keys(entry)
    if (keys.length === 0) return entry
    const fitting = operations.filter(
        operation => Array.isArray(operation.params) && exactFit(operation.params, keys)
    )
    if (fitting.length === 1) return {...entry, op: fitting[0].op}
    // The same entry written flat, which is `foldFlatEntry`'s shape with the operation left off as
    // well. `{"ops": [{"path": "scripts/player.gd", "edits": […]}]}` is one recorded call: `edit`'s
    // own `files` entry, written as the entry. `foldFlatEntry` cannot reach it — it starts from an
    // `op` — and neither can the fit above, because `{path, edits}` is nothing `edit` declares. It
    // is the entry of the one list parameter `edit` does declare, and exactly one operation in the
    // domain is shaped like that, which is what makes it a repair rather than a guess.
    const folding = operations.filter(
        operation => listParamShapedLike(operations, operation.op, keys) !== undefined
    )
    if (folding.length !== 1) return entry
    const name = listParamShapedLike(operations, folding[0].op, keys)
    return {op: folding[0].op, [name]: [entry]}
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
 *
 * **The one repair here that is about a value rather than a shape, and why it could not move.**
 * The whitespace round a *value* is trimmed in `tool_params::trim_a_name`, on the same table, and
 * the two are halves of one typo. They cannot share a home. A nested entry's generated schema is
 * closed and carries its own `required`, so `{properties: [{" node": …}]}` is answered by the
 * agent loop with `must NOT have additional properties` and `must have required property 'node'`
 * before the router is called at all — the padded key has to be gone before validation, and the
 * padded value has to be trimmed for callers that never pass through validation. Widening the
 * nested schema is what would let this one join the other half; the schema is measured prose the
 * model reads, so it is not something to widen in passing.
 */
export function trimPaddedKeys(params, entry) {
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
 * A key that swallowed its own value, split back into the two the model meant to write.
 *
 * Counted across the recorded corpus: **25 keys in 7 runs**, in two forms and no others that can be
 * named for certain.
 *
 * `{"limit 50": null, …}` is the first — the name, a space, the value, and `null` left where the
 * value should be. Twelve of those in one turn, all identical, sent after the refusal had named
 * the parameter and printed the whole shape back: `godot_logs read has no 'limit 50' parameter`.
 * The model could not see the key it had written, so it wrote it again, and the repeat guard
 * counted to twelve while the turn spent a third of its calls on it.
 *
 * `{"minSeverityWarning": "warning"}` is the second — the name with the value concatenated onto
 * it, capitalised, and the value *also* held. Thirteen of those, and one of them was in the very
 * same call as a `limit 50`.
 *
 * Both are unambiguous, which is the whole reason they are here: the key begins with a name the
 * operation declares, the operation does not declare the key itself, the entry does not already
 * carry that name, and the tail either *is* the held value or the held value is nothing at all.
 * A number is written back as a number when the declared kind says so, because `limit` is an
 * `int` and a repair that hands the schema `"50"` has moved the refusal rather than removed it.
 *
 * What is deliberately left alone, and it is most of what the scan found. A key like
 * `name": "Coin1"}, {"op": "create",` is a torn *structure*, not a torn name: the tail is a second
 * entry the caller wrote, and anything this did with it would be inventing one. And `afterCursor`
 * for `after`, `limit_per_source` for `limit`, `nodePlaceholder` for `node` are not tears at all —
 * they are a model guessing a name, and the router refusing them by name is the right answer,
 * because a guess repaired silently is a guess the caller never learns was wrong.
 */
export function splitKeyThatCarriesItsValue(params, entry) {
    if (!Array.isArray(params) || !isObject(entry)) return entry
    const shaped = Object.fromEntries(
        Object.entries(entry).flatMap(([key, held]) => {
            const param = params.find(
                one =>
                    key.length > one.name.length
                    && key.toLowerCase().startsWith(one.name.toLowerCase())
                    && !params.some(other => other.name === key)
                    && !(one.name in entry)
            )
            if (!param) return [[key, held]]
            const rest = key.slice(param.name.length)
            const tail = rest.trim()
            if (tail === '') return [[key, held]]
            // Whether the tail is a value at all, and it has to be decided before it is used.
            //
            // `{"limit 50": null}` separates the two with a space, and that space is the evidence:
            // without it `{"afterCursor": null}` reads as `after` carrying `"Cursor"`, which is a
            // model's guess at a name turned into a value nobody wrote. A guess must reach the
            // router and be refused by name.
            //
            // `{"minSeverityWarning": "warning"}` has no space and needs none, because the held
            // value says what the tail is: the same thing, twice.
            const detached = rest !== tail
            const carried =
                (held === null || held === undefined) && detached ? tail
                : typeof held === 'string' && held.toLowerCase() === tail.toLowerCase() ? held
                : undefined
            if (carried === undefined) return [[key, held]]
            // An `int` slot takes an integer and nothing else. `{"limit 3.7": null}` repaired to
            // `3.7` would be refused by the schema on the value having just been accepted on the
            // name, which is moving a refusal rather than removing one.
            const shape = param.kind === 'int' ? /^-?\d+$/u : /^-?\d+(?:\.\d+)?$/u
            const numeric =
                (param.kind === 'int' || param.kind === 'number')
                && typeof carried === 'string'
                && shape.test(carried)
            if (!numeric && (param.kind === 'int' || param.kind === 'number')) return [[key, held]]
            return [[param.name, numeric ? Number(carried) : carried]]
        })
    )
    return params.reduce((walked, param) => {
        const held = walked[param.name]
        if (held === undefined || !Array.isArray(param.entry) || param.entry.length === 0)
            return walked
        if (param.kind === 'list' && Array.isArray(held))
            return {
                ...walked,
                [param.name]: held.map(one => splitKeyThatCarriesItsValue(param.entry, one))
            }
        if (param.kind === 'object')
            return {...walked, [param.name]: splitKeyThatCarriesItsValue(param.entry, held)}
        return walked
    }, shaped)
}

/**
 * A resource written straight into a tagged value, put back inside the `value` it belongs in.
 *
 * `{"type": "resource", "path": "res://scripts/coin.gd"}` is what two live turns wrote against
 * `stealth/ox-alpha` on 2026-08-25 — eight values across two `set_properties` calls, and the whole
 * call was refused each time, because nothing is written unless every entry is accepted. The shape
 * it should have is `{"type": "resource", "value": {"path": "…"}}`, and the tag says so: only the
 * payload wrapper was left out.
 *
 * The opposite mistake — a second `{type, value}` pair around the payload — is the one
 * `TAGGED_PAYLOAD` in `tool-schema.mjs` and `tool_params::repair_tagged` already answer. This is
 * the same gap from the other side, and it has to be repaired here rather than there: the tagged
 * schema requires `value`, so the agent loop refuses the call with `must have required properties
 * value` before the router is reached, and the router's own sentence — which prints the corrected
 * call with the caller's path in it — is never written.
 *
 * `path` alone, and nothing else. Every other tag's payload is a bare value or a list of numbers,
 * so there is no second key this could read as a payload by mistake, and a tagged value that
 * already carries `value` is left exactly as it came.
 */
export function wrapBareResource(params, entry) {
    if (!Array.isArray(params) || !isObject(entry)) return entry
    return params.reduce((walked, param) => {
        const held = walked[param.name]
        if (held === undefined) return walked
        if (param.kind === 'tagged') {
            if (!isObject(held) || 'value' in held) return walked
            const {type, path, ...rest} = held
            if (type !== 'resource' || typeof path !== 'string') return walked
            if (Object.keys(rest).length > 0) return walked
            return {...walked, [param.name]: {type, value: {path}}}
        }
        if (!Array.isArray(param.entry) || param.entry.length === 0) return walked
        if (param.kind === 'list' && Array.isArray(held))
            return {...walked, [param.name]: held.map(one => wrapBareResource(param.entry, one))}
        if (param.kind === 'object')
            return {...walked, [param.name]: wrapBareResource(param.entry, held)}
        return walked
    }, entry)
}

/**
 * The refusal a model gets for an operation this domain does not have.
 *
 * `{"op": "save"}` sent to `godot_node`, twice across two live turns on 2026-08-25 — batched
 * beside `connect_signal`, which is a reasonable thing to want and is one tool away from being
 * right. What came back was `ops.2.op: must be equal to one of the allowed values`: it does not
 * name the value it refused, it does not name the values it would have taken, and it does not say
 * that `save` is a real operation living on `godot_scene`. The whole batch was refused with it.
 *
 * Thrown from `prepareArguments`, which the agent loop runs before it validates — and whose throw
 * it turns into the tool result the model reads. That is the only point at which Gofer can answer
 * an `op` the generated enum is about to refuse, and the enum is worth keeping: it is what the
 * model is shown while it writes the call.
 *
 * `elsewhere` answers which other tools have this operation, so the sentence can point at one. It
 * is optional because a caller holding a single domain has nothing to point at, and a wrong
 * signpost is worse than none.
 */
export function refuseUnknownOperation(operations, entry, elsewhere) {
    if (typeof entry.op !== 'string') return
    if (operations.some(operation => operation.op === entry.op)) return
    const known = operations.map(operation => operation.op).join(', ')
    const others = elsewhere?.(entry.op) ?? []
    const pointer =
        others.length > 0 ? ` '${entry.op}' is an operation of ${others.join(' and ')}.` : ''
    throw new Error(`This tool has no '${entry.op}' operation. It has: ${known}.${pointer}`)
}

/**
 * A parameter that belongs to a sibling operation, refused by name instead of by type.
 *
 * `godot_node create` written with `create_nodes`' `nodes` list — what a model does when it
 * flattens a batch back onto the single call — is answered `ops.0.nodes.0: must be object`, about
 * a parameter `create` does not have. The entry schema merges the domain's parameter types under
 * one open object, deliberately, for the reason `jsonSchemaOfEntry` measures; the design intends a
 * stray key to fall through to the router, which answers `godot_node create has no \`nodes\`
 * parameter. It takes {parent: text, type: text, name: text, index?: int}.` — but that only happens
 * for a name *no* operation declares.
 *
 * Same seam as `refuseUnknownOperation`, one level in: the generated schema refuses before the
 * router is reached, and `prepareArguments` is the one hook that runs first.
 *
 * **Exactly one sibling, and it has to have a shape inside it.** That narrowing is the whole rule,
 * and a live run bought it: `godot_script edit` sent `path` was refused with a signpost naming ten
 * operations, where the router's own sentence for the same call is shorter, carries the parameter's
 * note, and spells the nearest real name. A key many operations declare is a key the merged type
 * accepts and the router explains better. What it cannot explain is a key whose sibling declares an
 * `entry`: ajv walks *inside* the value against the wrong operation's shape, and every line of the
 * refusal is then about a parameter the caller never had.
 *
 * `signature` is the string Rust printed from the same parameter table, carried on the wire, so the
 * shape quoted here cannot drift from the shape the router accepts. An operation whose parameters
 * are all hidden signs as the empty string and takes nothing; one with no signature at all — a
 * caller holding the declared contract rather than the catalogue — says nothing about what it takes
 * rather than guessing.
 */
export function refuseSiblingParameter(operations, entry) {
    const operation = operations.find(one => one.op === entry.op)
    if (!Array.isArray(operation?.params)) return
    for (const key of Object.keys(entry)) {
        if (key === 'op') continue
        if (operation.params.some(param => param.name === key)) continue
        const owners = operations.filter(
            other =>
                other.op !== entry.op
                && Array.isArray(other.params)
                && other.params.some(param => param.name === key)
        )
        if (owners.length !== 1) continue
        const shaped = owners[0].params.find(param => param.name === key)
        if (!Array.isArray(shaped?.entry) || shaped.entry.length === 0) continue
        const takes =
            operation.signature ? ` It takes ${operation.signature}.`
            : operation.signature === '' && operation.params.every(param => param.hidden) ?
                ' It takes no parameters.'
            :   ''
        throw new Error(
            `${entry.op} has no \`${key}\` parameter.${takes}`
                + ` \`${key}\` is a parameter of ${owners[0].op}.`
        )
    }
}

/**
 * The entry a model opened and wrote nothing into, dropped rather than taking the batch with it.
 *
 * `{"ops": [{}, {"op": "wait", "ms": 2200}, {"op": "inspect_node", …}, {"op": "capture"}]}` is what
 * one live turn wrote: three operations it meant, behind a bracket it opened by mistake. The whole
 * call was refused with `ops.0.op: must have required properties op`, which names the empty entry
 * and says nothing about the three that were fine.
 *
 * An empty object carries no operation, no parameters and no intent, so there is nothing to lose by
 * dropping it — which is what makes this a repair rather than a guess. Every other torn shape here
 * is repaired by working out what the caller meant; this one is the single case where the answer is
 * that they meant nothing.
 *
 * A call that is *only* empty entries is left exactly as it came. Dropping them would leave an
 * empty `ops`, refused by `minItems` with a sentence no better than the one it already gets, and a
 * caller who sent nothing at all is better told so by name.
 */
export function dropEmptyEntries(entries) {
    const written = entries.filter(entry => !isObject(entry) || Object.keys(entry).length > 0)
    return written.length > 0 ? written : entries
}

/**
 * The same refusal, saying that the list it refused left nothing behind.
 *
 * These two throw before the router is reached, so no entry of the call has run — and nothing in
 * either sentence says so. A live turn sent `godot_scene [create, create_nodes, set_properties,
 * connect_signal, connect_signal, save]`, was refused because `create_nodes` lives on `godot_node`,
 * and then wrote "The scene is created and open — the node-level ops belong to `godot_node`.
 * Continuing there:". The scene did not exist. It took four more calls to find that out.
 *
 * The same sentence the router appends, in the same words, because a model that meets one of them
 * meets the other. Only a list: a refused call of one has plainly not run.
 */
function sayingNoneOfItRan(listed, refusal) {
    if (listed < 2) return refusal
    const said = (refusal instanceof Error ? refusal.message : String(refusal)).trimEnd()
    // A full stop first when the sentence it joins did not end in one, which the router's own
    // `node_not_found` does not: it ends on the path it could not find.
    const stop = /[.!?]$/u.test(said) ? '' : '.'
    return new Error(
        `${said}${stop} None of the ${String(listed)} operations in this call ran.`
            + ` A list is refused as one, so send all ${String(listed)} again with this one corrected.`
    )
}

export function normalizeToolCalls(operations, args, elsewhere) {
    const raw = isObject(args) ? args : {}
    const listed = Array.isArray(raw.ops) ? raw.ops : [raw]
    // `foldFlatEntry` before `foldStrayEntries`, and the order is the repair. Both mistakes at once
    // — `[{op: "edit", path: a, edits: […]}, {path: b, edits: […]}]` — is the one a model writes
    // when it flattens the first file and then keeps going. The stray fold needs the list to exist
    // before it can add to it, so run the other way round it repairs the first file, leaves the
    // second as an entry with no `op`, and validation refuses the batch and loses b entirely.
    const entries = foldStrayEntries(
        operations,
        dropEmptyEntries(listed)
            .map(entry => normalizeEntry(operations, entry))
            .map(entry => foldFlatEntry(operations, entry))
    )
    return {
        ops: entries
            .map(entry => nameTheOperation(operations, entry))
            .map(entry => {
                try {
                    refuseUnknownOperation(operations, entry, elsewhere)
                    const params = operations.find(operation => operation.op === entry.op)?.params
                    // After the repairs, so a padded key that was about to be renamed onto a real
                    // parameter is never refused as one belonging somewhere else.
                    const shaped = wrapBareResource(
                        params,
                        splitKeyThatCarriesItsValue(params, trimPaddedKeys(params, entry))
                    )
                    refuseSiblingParameter(operations, shaped)
                    return shaped
                } catch (refusal) {
                    throw sayingNoneOfItRan(entries.length, refusal)
                }
            })
    }
}
