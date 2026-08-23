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
    return fitting.length === 1 ? {...entry, op: fitting[0].op} : entry
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
            .map(entry =>
                trimPaddedKeys(
                    operations.find(operation => operation.op === entry.op)?.params,
                    entry
                )
            )
    }
}
