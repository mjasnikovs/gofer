/**
 * The repairs the router will never get the chance to make.
 *
 * A call is validated against the generated schema between `prepareArguments` and the router, so a
 * shape the schema refuses never reaches `tool_repair.rs` and has to be repaired here. Everything
 * the schema accepts is the router's, and a second copy of one of those repairs is drift waiting to
 * happen — a fix for the double-wrapped tag once existed only here while both suites stayed green.
 *
 * The line is not a preference and is no longer a comment: `tool-call-repair.test.mjs` runs every
 * row of `fixtures/tool-call-repairs.json` through pi-ai's own `validateToolArguments` and refuses
 * a row this file repairs that the schema would have let through.
 */
const PARAM_KEYS = ['params', 'parameters', 'arguments', 'args', 'input']

const OP_KEYS = ['op', 'operation', 'action']

function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asSentenceList(names) {
    if (names.length < 3) return names.join(' and ')
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function exactFit(declared, keys) {
    return (
        declared.every(param => !param.required || keys.includes(param.name))
        && keys.every(key => declared.some(param => param.name === key))
    )
}

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

export function normalizeEntry(operations, args) {
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

export function unwrapOperationNamedKey(operations, entry) {
    if (!isObject(entry)) return entry
    const keys = Object.keys(entry)
    if (keys.length !== 1) return entry
    const [key] = keys
    if (OP_KEYS.includes(key) || !isObject(entry[key])) return entry
    if (!operations.some(operation => operation.op === key)) return entry
    const inner = entry[key]
    if (OP_KEYS.some(named => typeof inner[named] === 'string' && inner[named] !== key))
        return entry
    return {
        ...Object.fromEntries(Object.entries(inner).filter(([named]) => !OP_KEYS.includes(named))),
        op: key
    }
}

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

export function nameTheOperation(operations, entry) {
    if (entry.op !== undefined) return entry
    const keys = Object.keys(entry)
    if (keys.length === 0) return entry
    const fitting = operations.filter(
        operation => Array.isArray(operation.params) && exactFit(operation.params, keys)
    )
    if (fitting.length === 1) return {...entry, op: fitting[0].op}
    const folding = operations.filter(
        operation => listParamShapedLike(operations, operation.op, keys) !== undefined
    )
    if (folding.length !== 1) return entry
    const name = listParamShapedLike(operations, folding[0].op, keys)
    return {op: folding[0].op, [name]: [entry]}
}

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

const TAG_KEYS = ['type', 'value']

export function unquoteATaggedKey(params, entry) {
    if (!Array.isArray(params) || !isObject(entry)) return entry
    return params.reduce((walked, param) => {
        const held = walked[param.name]
        if (param.kind === 'list' && Array.isArray(param.entry) && Array.isArray(held))
            return {...walked, [param.name]: held.map(one => unquoteATaggedKey(param.entry, one))}
        if (param.kind === 'object' && Array.isArray(param.entry) && isObject(held))
            return {...walked, [param.name]: unquoteATaggedKey(param.entry, held)}
        if (param.kind !== 'tagged' || !isObject(held)) return walked
        return {...walked, [param.name]: withoutQuotedTagKeys(held)}
    }, entry)
}

function withoutQuotedTagKeys(tagged) {
    const named = renamedWithoutQuotes(tagged, TAG_KEYS)
    if (named.type !== 'resource' || !isObject(named.value)) return named
    return {...named, value: renamedWithoutQuotes(named.value, ['path'])}
}

function renamedWithoutQuotes(object, wanted) {
    return Object.fromEntries(
        Object.entries(object).map(([key, held]) => {
            const bare = key.replace(/^["'\s]+|["'\s]+$/gu, '')
            const renameable = bare !== key && !(bare in object) && wanted.includes(bare)
            return [renameable ? bare : key, held]
        })
    )
}

export function readAValueWrittenAsAString(params, entry) {
    if (!Array.isArray(params) || !isObject(entry)) return entry
    const shaped = params.reduce((walked, param) => {
        const held = walked[param.name]
        if (typeof held !== 'string') return walked
        const wanted = shapeOfAValue(param)
        if (wanted === undefined) return walked
        const parsed = parsedOrNothing(held)
        const fits = wanted === 'list' ? Array.isArray(parsed) : isObject(parsed)
        return fits ? {...walked, [param.name]: parsed} : walked
    }, entry)
    return params.reduce((walked, param) => {
        const held = walked[param.name]
        if (held === undefined || !Array.isArray(param.entry) || param.entry.length === 0)
            return walked
        if (param.kind === 'list' && Array.isArray(held))
            return {
                ...walked,
                [param.name]: held.map(one => readAValueWrittenAsAString(param.entry, one))
            }
        if (param.kind === 'object')
            return {...walked, [param.name]: readAValueWrittenAsAString(param.entry, held)}
        return walked
    }, shaped)
}

function shapeOfAValue(param) {
    if (param.kind === 'list' || param.kind === 'listOf') return 'list'
    if (param.kind === 'object') return 'object'
    if (param.kind === 'either' && Array.isArray(param.of))
        return param.of.some(one => one?.kind === 'list') ? 'list' : undefined
    return undefined
}

function parsedOrNothing(text) {
    try {
        return JSON.parse(text)
    } catch {
        return undefined
    }
}

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

export function refuseUnknownOperation(operations, entry, elsewhere) {
    if (typeof entry.op !== 'string') return
    if (operations.some(operation => operation.op === entry.op)) return
    const known = operations.map(operation => operation.op).join(', ')
    const others = elsewhere?.(entry.op) ?? []
    const pointer =
        others.length > 0 ? ` '${entry.op}' is an operation of ${asSentenceList(others)}.` : ''
    throw new Error(`This tool has no '${entry.op}' operation. It has: ${known}.${pointer}`)
}

function refusalForAnEntryFittingNothing(operations, entry) {
    const known = operations.map(operation => operation.op)
    const asKey = Object.keys(entry).filter(key => known.includes(key))
    const asValue = Object.entries(entry).filter(
        ([, value]) => typeof value === 'string' && known.includes(value)
    )
    const misplaced =
        asKey.length === 1 ?
            ` \`${asKey[0]}\` is an operation of this tool: write it as \`"op": "${asKey[0]}"\``
            + ' with its parameters beside it rather than under it.'
        : asValue.length === 1 ?
            ` \`${asValue[0][0]}\` holds "${asValue[0][1]}", which is an operation of this tool:`
            + ` write it as \`"op": "${asValue[0][1]}"\`.`
        :   ` This tool's operations are: ${known.join(', ')}.`
    return (
        `This entry names no operation, and its keys — ${asSentenceList(Object.keys(entry))} —`
        + ` are not the parameters of any one operation of this tool.${misplaced}`
        + ' Every entry of an ops list names its own operation.'
    )
}

export function refuseUnnamedOperation(operations, entry) {
    if (entry.op !== undefined) return
    const keys = Object.keys(entry)
    if (keys.length === 0) return
    const fitting = operations.filter(
        operation => Array.isArray(operation.params) && exactFit(operation.params, keys)
    )
    if (fitting.length === 0) throw new Error(refusalForAnEntryFittingNothing(operations, entry))
    if (fitting.length < 2) return
    const named = fitting.map(operation => operation.op)
    const suggestion =
        named.length === 2 ?
            `add \`"op": "${named[0]}"\` or the one you meant`
        :   'name the one you meant in `op`'
    throw new Error(
        `This entry names no operation. Its parameters are what ${asSentenceList(named)}`
            + ` ${named.length === 2 ? 'both' : 'all'} take, so they cannot be told apart here:`
            + ` ${suggestion}. Every entry of an ops list names its own operation.`
    )
}

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

export function dropEmptyEntries(entries) {
    const written = entries.filter(entry => !isObject(entry) || Object.keys(entry).length > 0)
    return written.length > 0 ? written : entries
}

function sayingNoneOfItRan(listed, refusal) {
    if (listed < 2) return refusal
    const said = (refusal instanceof Error ? refusal.message : String(refusal)).trimEnd()
    const stop = /[.!?]$/u.test(said) ? '' : '.'
    return new Error(
        `${said}${stop} None of the ${String(listed)} operations in this call ran.`
            + ` A list is refused as one, so send all ${String(listed)} again with this one corrected.`
    )
}

export function normalizeToolCalls(operations, args, elsewhere) {
    const raw = isObject(args) ? args : {}
    const listed = Array.isArray(raw.ops) ? raw.ops : [raw]
    const entries = foldStrayEntries(
        operations,
        dropEmptyEntries(listed)
            .map(entry => unwrapOperationNamedKey(operations, entry))
            .map(entry => normalizeEntry(operations, entry))
            .map(entry => foldFlatEntry(operations, entry))
    )
    return {
        ops: entries
            .map(entry => nameTheOperation(operations, entry))
            .map(entry => {
                try {
                    refuseUnnamedOperation(operations, entry)
                    refuseUnknownOperation(operations, entry, elsewhere)
                    const params = operations.find(operation => operation.op === entry.op)?.params
                    const shaped = wrapBareResource(
                        params,
                        readAValueWrittenAsAString(
                            params,
                            unquoteATaggedKey(params, trimPaddedKeys(params, entry))
                        )
                    )
                    refuseSiblingParameter(operations, shaped)
                    return shaped
                } catch (refusal) {
                    throw sayingNoneOfItRan(entries.length, refusal)
                }
            })
    }
}
