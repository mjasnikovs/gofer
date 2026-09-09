/**
 * The answer half of the contract: `result` rows turned into Rust structs and TypeScript types.
 *
 * The model never reads any of this. It exists so that an answer shape written down in
 * `params.json` is held to the handler that produces it — Rust deserializes every addon answer
 * into the struct emitted here, and the renderer is typed off the same row rather than off a
 * hand-written list that covered sixteen of sixty-eight commands.
 */

const KINDS = ['text', 'int', 'number', 'flag', 'object', 'list', 'listOf', 'tagged', 'shape']

/** Holds one `result` row to the vocabulary, and to the shapes it points at. */
export function checkResult(where, result, shapes) {
    if (!result || typeof result !== 'object') throw new Error(`${where} declares no result shape`)
    checkResultKind(where, result, shapes)
    if (result.kind !== 'object' && result.kind !== 'shape')
        throw new Error(`${where} answers with a ${result.kind}, and every answer is an object`)
    if (result.kind === 'object' && !result.entry && !result.of) return
}

function checkResultKind(where, kind, shapes) {
    if (!KINDS.includes(kind.kind))
        throw new Error(`${where} is of unknown result kind ${JSON.stringify(kind.kind)}`)
    if (kind.kind === 'shape') {
        if (!shapes[kind.shape])
            throw new Error(`${where} names the shape ${kind.shape}, which no shape declares`)
        return
    }
    if (kind.kind === 'listOf') {
        if (!kind.of?.kind) throw new Error(`${where} is a listOf nothing`)
        checkResultKind(`${where}[]`, kind.of, shapes)
    }
    if (kind.entry) {
        if (kind.kind !== 'object')
            throw new Error(`${where} is a ${kind.kind}, which has no entries to shape`)
        const named = new Set()
        for (const inner of kind.entry) {
            if (!inner.name) throw new Error(`${where} shapes a field with no name`)
            if (named.has(inner.name)) throw new Error(`${where} shapes ${inner.name} twice`)
            named.add(inner.name)
            if (typeof inner.required !== 'boolean')
                throw new Error(`${where}.${inner.name} does not say whether it is always there`)
            checkResultKind(`${where}.${inner.name}`, inner, shapes)
        }
    }
    if (kind.of && kind.kind === 'object') checkResultKind(`${where}{}`, kind.of, shapes)
    if (kind.kind === 'object' && kind.entry && kind.of)
        throw new Error(`${where} is both a shaped object and an open map`)
}

/** Holds the `shapes` block to the same rules, including the ones that name themselves. */
export function checkShapes(path, shapes) {
    for (const [name, shape] of Object.entries(shapes)) {
        const where = `${path}: the ${name} shape`
        if (typeof shape.note !== 'string' || shape.note.trim() === '')
            throw new Error(`${where} does not say what it is`)
        if (!Array.isArray(shape.entry) || shape.entry.length === 0)
            throw new Error(`${where} shapes nothing`)
        checkResultKind(where, {kind: 'object', entry: shape.entry}, shapes)
    }
}

function pascal(words) {
    return words
        .split(/[._]/u)
        .filter(Boolean)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join('')
}

function snake(name) {
    return name.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`)
}

function camel(name) {
    return name.replace(/_([a-z])/gu, (_all, letter) => letter.toUpperCase())
}

/** Words Rust will not take as a field name, spelled the way Rust lets you take them anyway. */
const RUST_KEYWORDS = new Set([
    'type',
    'move',
    'ref',
    'match',
    'self',
    'fn',
    'impl',
    'loop',
    'where',
    'box'
])

function rustField(name) {
    const ident = snake(name)
    return RUST_KEYWORDS.has(ident) ? `r#${ident}` : ident
}

function rustString(text) {
    return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

/**
 * One Rust type per result kind, and the nested structs a shaped object needs beside it.
 *
 * `nest` collects those: a struct cannot be declared inside a field, so an inline object becomes a
 * struct of its own named after the field that holds it.
 */
function rustType(kind, owner, field, nest) {
    switch (kind.kind) {
        case 'text':
            return 'String'
        case 'int':
            return 'i64'
        case 'number':
            return 'f64'
        case 'flag':
            return 'bool'
        case 'tagged':
            return 'serde_json::Value'
        case 'shape':
            return pascal(kind.shape)
        case 'list':
            return 'Vec<serde_json::Value>'
        case 'listOf':
            return `Vec<${rustType(kind.of, owner, field, nest)}>`
        case 'object': {
            if (kind.of)
                return `std::collections::HashMap<String, ${rustType(kind.of, owner, field, nest)}>`
            if (!kind.entry) return 'serde_json::Map<String, serde_json::Value>'
            const name = `${owner}${pascal(field)}`
            nest.push(rustStruct(name, kind.entry, nest))
            return name
        }
        default:
            throw new Error(`no Rust type stands for the result kind ${kind.kind}`)
    }
}

function rustStruct(name, entry, nest) {
    const fields = entry
        .map(field => {
            const inner = rustType(field, name, field.name, nest)
            const type = field.required ? inner : `Option<${inner}>`
            const renamed =
                camel(snake(field.name)) === field.name ?
                    ''
                :   `    #[serde(rename = ${rustString(field.name)})]\n`
            const missing = field.required ? '' : '    #[serde(default)]\n'
            return `${renamed}${missing}    pub ${rustField(field.name)}: ${type},\n`
        })
        .join('')
    return (
        '#[derive(Debug, serde::Deserialize)]\n'
        + '#[serde(rename_all = "camelCase", deny_unknown_fields)]\n'
        + `pub struct ${name} {\n${fields}}\n`
    )
}

/** One declaration per result row: a struct, or an alias when the row is a shape and nothing more. */
function rustDeclaration(name, result, nest) {
    if (result.kind === 'shape') return `pub type ${name} = ${pascal(result.shape)};\n`
    if (!result.entry) return `pub type ${name} = serde_json::Map<String, serde_json::Value>;\n`
    return rustStruct(name, result.entry, nest)
}

export function commandStruct(command) {
    return `${pascal(command)}Result`
}

export function operationStruct(tool, op) {
    return `${pascal(`${tool}.${op}`)}Result`
}

/**
 * Every declared answer as a Rust struct, and the one lookup that deserializes into it.
 *
 * The lookup is what makes them reachable: a struct nothing names is a struct nothing holds, and
 * the whole point of these is that `godot_rpc` runs an answer through the right one.
 */
export function rustResults(shapes, commands, operations) {
    const nest = []
    const declared = []
    for (const [name, shape] of Object.entries(shapes))
        declared.push(`/// ${shape.note}\n` + rustStruct(pascal(name), shape.entry, nest))
    for (const row of commands)
        declared.push(rustDeclaration(commandStruct(row.command), row.result, nest))
    for (const row of operations)
        declared.push(rustDeclaration(operationStruct(row.tool, row.op), row.result, nest))
    const arms = [
        ...commands.map(
            row =>
                `        ${rustString(row.command)} => shaped::<${commandStruct(row.command)}>(answer),\n`
        ),
        ...operations.map(
            row =>
                `        ${rustString(`${row.tool}.${row.op}`)} => shaped::<${operationStruct(row.tool, row.op)}>(answer),\n`
        )
    ].join('')
    const lookup =
        '/// Whether an answer is the shape its command or operation declared, and how it is not.\n'
        + '///\n'
        + '/// The name is an addon command — `scene.get_tree` — or a tool operation the desktop\n'
        + '/// answers itself, written `godot_script.edit`.\n'
        + 'pub(crate) fn declared_shape_of(name: &str, answer: &serde_json::Value) -> Result<(), String> {\n'
        + '    fn shaped<T: serde::de::DeserializeOwned>(answer: &serde_json::Value) -> Result<(), String> {\n'
        + '        serde_json::from_value::<T>(answer.clone()).map(|_| ()).map_err(|why| why.to_string())\n'
        + '    }\n'
        + '    match name {\n'
        + arms
        + '        other => Err(format!("{other} declares no result shape")),\n'
        + '    }\n'
        + '}\n'
    return [...declared, ...nest, lookup].join('\n')
}

function typescriptType(kind, shapes) {
    switch (kind.kind) {
        case 'text':
            return 'string'
        case 'int':
        case 'number':
            return 'number'
        case 'flag':
            return 'boolean'
        case 'tagged':
            return 'GodotValue'
        case 'shape':
            return pascal(kind.shape)
        case 'list':
            return 'readonly unknown[]'
        case 'listOf':
            return `readonly ${wrapped(typescriptType(kind.of, shapes))}[]`
        case 'object':
            if (kind.of) return `Readonly<Record<string, ${typescriptType(kind.of, shapes)}>>`
            if (!kind.entry) return 'Readonly<Record<string, unknown>>'
            return typescriptObject(kind.entry, shapes)
        default:
            throw new Error(`no TypeScript type stands for the result kind ${kind.kind}`)
    }
}

/** Parenthesises a union or a readonly array so `[]` binds to the whole of it. */
function wrapped(type) {
    return /[ |]/u.test(type) ? `(${type})` : type
}

function typescriptObject(entry, shapes, of = typescriptType) {
    if (entry.length === 0) return 'Readonly<Record<string, never>>'
    return `Readonly<{${entry.map(field => typescriptField(field, of(field, shapes))).join('; ')}}>`
}

// `unknown | undefined` is `unknown`, and the linter says so.
function typescriptField(field, type) {
    if (field.required) return `${field.name}: ${type}`
    return type === 'unknown' ? `${field.name}?: unknown` : `${field.name}?: ${type} | undefined`
}

/** The kinds a parameter can be, as the renderer spells them. */
function typescriptParam(param, shapes) {
    // A command params.json does not describe names its parameters and not their kinds.
    if (param.kind === 'unknown') return 'unknown'
    if (param.kind === 'choice')
        return param.of?.length ? param.of.map(word => `'${word}'`).join(' | ') : 'string'
    if (param.kind === 'hash') return 'string'
    if (param.kind === 'list' && param.entry)
        return `readonly ${typescriptObject(param.entry, shapes, typescriptParam)}[]`
    if (param.kind === 'list') return 'readonly unknown[]'
    if (param.kind === 'listOf') return `readonly ${wrapped(typescriptParam(param.of, shapes))}[]`
    if (param.kind === 'object' && param.entry)
        return typescriptObject(param.entry, shapes, typescriptParam)
    return typescriptType(param, shapes)
}

function typescriptParams(params, shapes) {
    if (params.length === 0) return 'NoGodotParams'
    const fields = params
        .map(param => typescriptField(param, typescriptParam(param, shapes)))
        .join('; ')
    return `Readonly<{${fields}}>`
}

/**
 * The renderer's whole view of the protocol: the command names, the shapes their answers carry,
 * and one typed pair per command.
 *
 * All sixty-eight of them. The hand-written map this replaced typed sixteen and left the rest as
 * an open dictionary, so a renderer reading a key no answer carries typechecked perfectly.
 */
export function typescriptCommands(shapes, commands) {
    const names = commands.map(row => `    | '${row.command}'\n`).join('')
    const declared = Object.entries(shapes)
        .map(
            ([name, shape]) =>
                `/** ${shape.note} */\nexport type ${pascal(name)} = ${typescriptObject(shape.entry, shapes)}\n`
        )
        .join('\n')
    const rows = commands
        .map(
            row =>
                `    readonly '${row.command}': GodotCommandSpec<\n`
                + `        ${typescriptParams(row.params, shapes)},\n`
                + `        ${typescriptType(row.result, shapes)}\n`
                + '    >\n'
        )
        .join('')
    return (
        `export type GodotCommandName =\n${names}\n`
        + '/** A Godot value as the protocol tags it: the Variant type by name, and its payload. */\n'
        + 'export type GodotValue = Readonly<{type: string; value: unknown}>\n\n'
        + declared
        + '\n/** Every command the addon answers, with the parameters it takes and the answer it gives. */\n'
        + `export interface GodotCommandMap {\n${rows}}\n`
    )
}
