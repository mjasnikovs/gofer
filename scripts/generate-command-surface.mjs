// Some of the five command surfaces are not decisions. They are transcriptions: the window's
// allow-list is the backend's handler list retyped, the addon's dispatch table is the command
// catalogue retyped, and three copies of MUTATING_COMMANDS are the schema's enum retyped. Task 1's
// checker can only report that a transcription slipped. This emits them instead, so there is
// nothing to slip.
//
// The same is now true of what is not a command at all. The sub-agent's six ceilings were a default
// and a range written on each side of the seam, twenty-four numbers in two languages; the ranges
// were reconciled by that same checker reading both files as text, and the defaults by nobody. A
// default and a range are one fact about one ceiling, so they are one row here.
//
// Six sources, and none of them is generated:
//
//   protocol/schemas/v2/request.schema.json   which commands mutate the edited scene
//   protocol/schemas/v2/commands.json         every command, and the addon method that answers it
//   protocol/schemas/v2/params.json           what every tool operation takes, and what refuses it
//   protocol/subagent-bounds.json             what the sub-agent's ceilings ship as and may be set to
//   protocol/cerebras-models.json             what each Cerebras model can do, which Cerebras will not say
//   src-tauri/src/lib.rs                      which commands the backend registers
//
// Two surfaces stay hand-written on purpose. `src/services/desktop.ts` carries an argument and a
// response type per command, which are decisions, not transcription. `protocol/README.md` states
// the mutating list as prose, and prettier reflows prose. Task 1's checker holds both to the rest.
//
// Run `npm run generate` after any change to a source. `--check` regenerates into memory and fails
// on any difference, which is how `npm run check` refuses a hand-edited region.

import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const GENERATOR = 'scripts/generate-command-surface.mjs'

async function read(path) {
    return await readFile(new URL(path, `file://${root}`), 'utf8')
}

/** Reads the text between `open` and the first `close` after it, or explains which anchor is gone. */
function slice(text, path, open, close) {
    const start = text.indexOf(open)
    if (start === -1) throw new Error(`${path} no longer contains ${JSON.stringify(open)}`)
    const rest = text.slice(start + open.length)
    const end = rest.indexOf(close)
    if (end === -1) throw new Error(`${path} never closes ${JSON.stringify(open)}`)
    return rest.slice(0, end)
}

// --- The sources.

/** The commands that must carry `expectedRevision`, in the frozen schema's own order. */
async function mutatingCommands() {
    const path = 'protocol/schemas/v2/request.schema.json'
    const names = JSON.parse(await read(path)).allOf?.[0]?.if?.properties?.command?.enum
    if (!Array.isArray(names) || names.length === 0)
        throw new Error(`${path} no longer enumerates the mutating commands`)
    return names
}

/**
 * Every command and its addon method, with the method's own arity read from the addon. Arity is
 * derived rather than declared because a catalogue that had to repeat it could disagree with the
 * function it names.
 */
/**
 * The commands routed to the running game instead of answered by a handler method.
 *
 * They carry no handler because there is none to name: `_handle_runtime_request` decides, per
 * command, whether the editor answers or the game is asked. What they do carry is a name, and the
 * addon needed that name in two places — the routing list and the routing match — with nothing
 * holding the two together.
 */
async function runtimeCatalogue() {
    const path = 'protocol/schemas/v2/commands.json'
    const {runtimeCommands} = JSON.parse(await read(path))
    if (!Array.isArray(runtimeCommands) || runtimeCommands.length === 0)
        throw new Error(`${path} lists no runtime commands`)
    return runtimeCommands
}

/**
 * The parameter contract of every operation the router forwards as raw JSON.
 *
 * One source, three readers that could otherwise disagree: the Rust table that refuses a call, the
 * signature the model is shown, and the addon-side guard. Before this, the shape of a value was
 * first examined by GDScript across a socket, and a model that got it wrong was answered with a
 * sentence carrying no example — which cost a live session eight identical retries.
 */
async function parameterCatalogue() {
    const path = 'protocol/schemas/v2/params.json'
    const {operations, vocabularies = {}} = JSON.parse(await read(path))
    if (!Array.isArray(operations) || operations.length === 0)
        throw new Error(`${path} declares no operations`)
    for (const entry of operations) {
        if (!entry.tool || !entry.op)
            throw new Error(`${path} has an operation without a tool and an op`)
        if (!entry.command && entry.answeredBy !== 'rust')
            throw new Error(
                `${path}: ${entry.tool} ${entry.op} names neither an addon command nor answeredBy: "rust"`
            )
        // The prose the model reads. An operation without one is a tool the model is told the name
        // of and nothing else, which is the one thing a catalogue may not be.
        if (typeof entry.summary !== 'string' || entry.summary.trim() === '')
            throw new Error(`${path}: ${entry.tool} ${entry.op} has no summary`)
        if ('writes' in entry && !WRITES.includes(entry.writes))
            throw new Error(
                `${path}: ${entry.tool} ${entry.op} writes ${JSON.stringify(entry.writes)}, not one of ${WRITES.join(', ')}`
            )
        // A blank sentence would refuse the call and say nothing about why, which is the failure the
        // whole file exists to make impossible. Absence is the default and means "may be repeated".
        if ('alone' in entry) {
            const {scope, why} = entry.alone ?? {}
            if (!ALONE_SCOPES.includes(scope))
                throw new Error(
                    `${path}: ${entry.tool} ${entry.op} is marked alone with scope ${JSON.stringify(scope)}, not one of ${ALONE_SCOPES.join(', ')}`
                )
            if (typeof why !== 'string' || why.trim() === '')
                throw new Error(
                    `${path}: ${entry.tool} ${entry.op} is marked alone without a sentence saying why`
                )
        }
        for (const param of entry.params ?? []) {
            checkKind(path, entry, param)
            // A vocabulary nothing declares would print an empty list into the signature and say
            // nothing about it, which is the failure mode the whole file exists to make impossible.
            if (param.vocabulary && !vocabularies[param.vocabulary])
                throw new Error(
                    `${path}: ${entry.tool} ${entry.op} ${param.name} speaks ${param.vocabulary}, which no vocabulary declares`
                )
        }
    }
    for (const [name, words] of Object.entries(vocabularies)) {
        if (!Array.isArray(words.accepted) || words.accepted.length === 0)
            throw new Error(`${path}: the ${name} vocabulary accepts nothing`)
        if (!Array.isArray(words.refused) || words.refused.length === 0)
            throw new Error(
                `${path}: the ${name} vocabulary refuses nothing, so nothing can prove it means anything`
            )
    }
    return {operations, vocabularies}
}

/**
 * The scopes `alone` may declare.
 *
 * `repeat` refuses a second entry of the same operation and lets it sit beside others; `exclusive`
 * refuses any other entry at all. Held to a list here so a typo in the source is a build failure
 * rather than an operation that quietly stops being narrowed.
 */
const ALONE_SCOPES = ['repeat', 'exclusive']

/**
 * What an operation may declare that it writes.
 *
 * The tag one of the user's enforced Godot rules is keyed on — the two settings surfaces and a call
 * carrying GDScript source. Held to a list here so a typo is a build failure rather than an
 * operation that quietly stops being enforced, which is the whole reason the rule reads a tag
 * instead of matching on the tool and the operation.
 */
const WRITES = ['projectSetting', 'editorSetting', 'scriptText']

const KINDS = [
    'text',
    'int',
    'number',
    'flag',
    'list',
    'object',
    'hash',
    'tagged',
    'choice',
    'either',
    'listOf'
]

/** One parameter of the source, held to the kinds the Rust checker knows how to enforce. */
function checkKind(path, entry, param) {
    const where = `${path}: ${entry.tool} ${entry.op} ${param.name ?? '(unnamed)'}`
    if (!param.name || !param.kind) throw new Error(`${where} has no name or no kind`)
    if (!KINDS.includes(param.kind)) throw new Error(`${where} is of unknown kind ${param.kind}`)
    if (param.kind === 'choice' && !Array.isArray(param.of))
        throw new Error(`${where} lists no choices`)
    if (param.kind === 'either') {
        if (!Array.isArray(param.of) || param.of.length < 2)
            throw new Error(`${where} is an either of fewer than two kinds`)
        for (const one of param.of) checkKind(path, entry, {...one, name: param.name})
    }
    // What one entry of a list *is*, where `entry` can only say what one entry *holds*. A scalar,
    // deliberately: a list of objects is `entry`, and saying it twice is the drift this file ends.
    if (param.kind === 'listOf') {
        if (!param.of?.kind) throw new Error(`${where} is a listOf nothing`)
        if (param.of.kind === 'list' || param.of.kind === 'listOf' || param.of.kind === 'object')
            throw new Error(`${where} is a listOf ${param.of.kind}; use an entry shape for that`)
        checkKind(path, entry, {...param.of, name: param.name})
    }
    // What one entry holds, where the kind stops. Only a list or an object has an inside, and an
    // inside written down half-way is worse than none: the checker refuses a key the shape does
    // not name, so an incomplete entry would refuse calls that are right.
    if (param.entry) {
        if (param.kind !== 'list' && param.kind !== 'object')
            throw new Error(`${where} is a ${param.kind}, which has no entries to shape`)
        if (!Array.isArray(param.entry) || param.entry.length === 0)
            throw new Error(`${where} declares an empty entry shape`)
        for (const inner of param.entry)
            checkKind(path, entry, {...inner, name: `${param.name}.${inner.name}`})
    }
}

async function catalogue() {
    const path = 'protocol/schemas/v2/commands.json'
    const addon = await read('src-tauri/addon/plugin.gd')
    const {commands} = JSON.parse(await read(path))
    if (!Array.isArray(commands) || commands.length === 0)
        throw new Error(`${path} lists no commands`)
    return commands.map(({command, handler}) => {
        const signature = addon.match(new RegExp(`^func ${handler}\\(([^)]*)\\) ->`, 'mu'))?.[1]
        if (signature === undefined)
            throw new Error(
                `${path} binds ${command} to ${handler}, which src-tauri/addon/plugin.gd does not define`
            )
        return {command, handler, takesParams: signature.trim().length > 0}
    })
}

/** The commands the backend registers, which is the only place a desktop command is real. */
async function registeredDesktopCommands() {
    const path = 'src-tauri/src/lib.rs'
    const list = slice(
        await read(path),
        path,
        'builder.invoke_handler(tauri::generate_handler![',
        ']);'
    )
    const names = list
        .split(',')
        .map(name => name.trim())
        .filter(Boolean)
    if (names.length === 0) throw new Error(`${path} registers no commands`)
    return names
}

// --- The regions.

/**
 * A generated region is the text between two marker comments. The opening marker carries the
 * checksum of the body, so a hand-edit is visible in a diff without running anything, and
 * `--check` catches it either way.
 */
function markers(comment, name) {
    return {
        begin: checksum => `${comment} GENERATED-BEGIN ${name} sha256:${checksum}`,
        beginPrefix: `${comment} GENERATED-BEGIN ${name} `,
        end: `${comment} GENERATED-END ${name}`
    }
}

function checksum(body) {
    return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/** Replaces one marked region's body, leaving every byte outside the markers alone. */
function replaceRegion(text, path, comment, name, body) {
    const {beginPrefix, begin, end} = markers(comment, name)
    const start = text.indexOf(beginPrefix)
    if (start === -1) throw new Error(`${path} no longer marks the generated region ${name}`)
    const lineEnd = text.indexOf('\n', start)
    const stop = text.indexOf(end, lineEnd)
    if (stop === -1) throw new Error(`${path} never closes the generated region ${name}`)
    return text.slice(0, start) + begin(checksum(body)) + '\n' + body + text.slice(stop)
}

/**
 * The sub-agent's ceilings: what each ships as, and what it may be dragged to.
 *
 * The default is held to its own range here rather than by either side that receives it. Rust would
 * refuse the number on save and the slider would silently clamp it, so a default outside its range
 * is a settings page that cannot save the settings it was opened with — which neither side can
 * report as the mistake it is.
 */
async function subagentBoundsCatalogue() {
    const path = 'protocol/subagent-bounds.json'
    const {bounds} = JSON.parse(await read(path))
    if (!Array.isArray(bounds) || bounds.length === 0) throw new Error(`${path} declares no bounds`)
    for (const bound of bounds) {
        for (const key of ['name', 'field', 'summary'])
            if (typeof bound[key] !== 'string' || bound[key].trim() === '')
                throw new Error(`${path}: a bound has no ${key}`)
        for (const key of ['default', 'min', 'max', 'step'])
            if (!Number.isInteger(bound[key]))
                throw new Error(`${path}: ${bound.name} has no whole ${key}`)
        if (bound.min > bound.max) throw new Error(`${path}: ${bound.name} has a min above its max`)
        if (bound.default < bound.min || bound.default > bound.max)
            throw new Error(
                `${path}: ${bound.name} ships as ${bound.default}, which its own range refuses`
            )
        // The Rust field is the name in snake_case, and the generator prints it into a closure that
        // reads it. A field that is not that name compiles into a struct that has no such field.
        const expected = bound.name.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`)
        if (bound.field !== expected)
            throw new Error(
                `${path}: ${bound.name} names the Rust field ${bound.field}, not ${expected}`
            )
    }
    return bounds
}

/**
 * What each Cerebras model can do, because its endpoint will not say.
 *
 * Every other driver reads a catalogue. Cerebras answers `{id, object, created, owned_by}` and
 * nothing more, so the facts are measured by hand and shipped. Held to the same rules the Rust that
 * receives them relies on: a window that an output ceiling cannot exceed, efforts drawn only from
 * the words Gofer has, and a model that cannot stop thinking naming no word for stopping.
 */
async function cerebrasModelCatalogue() {
    const path = 'protocol/cerebras-models.json'
    const {models} = JSON.parse(await read(path))
    if (!Array.isArray(models) || models.length === 0) throw new Error(`${path} declares no models`)
    const seen = new Set()
    for (const model of models) {
        for (const key of ['id', 'name', 'note'])
            if (typeof model[key] !== 'string' || model[key].trim() === '')
                throw new Error(`${path}: a model has no ${key}`)
        if (seen.has(model.id)) throw new Error(`${path}: ${model.id} is named twice`)
        seen.add(model.id)
        for (const key of ['contextWindow', 'maxTokens'])
            if (!Number.isInteger(model[key]) || model[key] < 1)
                throw new Error(`${path}: ${model.id} has no whole ${key}`)
        if (model.maxTokens > model.contextWindow)
            throw new Error(
                `${path}: ${model.id} declares an output ceiling above its own context window`
            )
        if (typeof model.reasoningMandatory !== 'boolean')
            throw new Error(`${path}: ${model.id} does not say whether its reasoning is mandatory`)
        for (const key of ['input', 'thinkingLevels'])
            if (!Array.isArray(model[key]) || model[key].length === 0)
                throw new Error(`${path}: ${model.id} declares an empty ${key}`)
        // Pi types a model's input as exactly these two, so a third word is one nothing downstream
        // can act on. Same narrowing `openrouter_model_options` applies to its own catalogue.
        for (const modality of model.input)
            if (modality !== 'text' && modality !== 'image')
                throw new Error(
                    `${path}: ${model.id} accepts ${modality}, which Pi has no word for`
                )
        for (const level of model.thinkingLevels)
            if (!NAMED_EFFORTS.includes(level))
                throw new Error(
                    `${path}: ${model.id} names the effort ${level}, which Gofer has not`
                )
        // `off` is a level, never an effort, so a model whose reasoning is mandatory has no word for
        // stopping by definition — and one written here would be sent by a menu that never offers it.
        if (model.offEffort !== undefined) {
            if (typeof model.offEffort !== 'string' || model.offEffort.trim() === '')
                throw new Error(`${path}: ${model.id} declares an empty offEffort`)
            if (model.reasoningMandatory)
                throw new Error(
                    `${path}: ${model.id} cannot stop thinking and names ${model.offEffort} as the word for stopping`
                )
        }
    }
    return models
}

/**
 * Every effort Gofer has a word for, in the order it ranks them.
 *
 * The same list as `NAMED_EFFORTS` in `settings.rs` and `KNOWN_EFFORTS` in `thinking-level.mjs`,
 * which `scripts/check-command-surface.mjs` already holds to each other. Repeated here rather than
 * imported because this file reads sources as text and emits bytes; it owns no runtime code.
 */
const NAMED_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// --- The emitters. Each returns the exact bytes its formatter would leave behind.

function gdMutating(names) {
    return `const MUTATING_COMMANDS: Array[String] = [\n${names
        .map(name => `    "${name}",\n`)
        .join('')}]\n`
}

function gdDispatch(commands) {
    const cases = commands
        .map(
            ({command, handler, takesParams}) =>
                `        "${command}":\n            return ${handler}(${takesParams ? 'params' : ''})\n`
        )
        .join('')
    return `    match command:\n${cases}    return _unknown_command_error(command)\n`
}

function gdRuntimeCommands(names) {
    return `const RUNTIME_COMMANDS: Array[String] = [\n${names
        .map(name => `    "${name}",\n`)
        .join('')}]\n`
}

/**
 * The union the renderer spells a command with, in the order the catalogue lists them.
 *
 * Prettier breaks a union this long one member per line with a leading pipe, so that is what is
 * emitted — the formatter and the generator have to agree byte for byte or `npm run check` fails
 * one of them whatever the other does.
 */
function typescriptCommandNames(names) {
    return `export type GodotCommandName =\n${names.map(name => `    | '${name}'\n`).join('')}`
}

function rustMutating(names) {
    return `pub const MUTATING_COMMANDS: [&str; ${names.length}] = [\n${names
        .map(name => `    "${name}",\n`)
        .join('')}];\n`
}

/** A Rust string literal, escaped. Notes are prose and carry quotes of their own. */
function rustString(text) {
    return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

function rustKind(param) {
    if (param.kind === 'choice')
        return `Kind::Choice(&[${param.of.map(word => rustString(word)).join(', ')}])`
    if (param.kind === 'either')
        return `Kind::Either(&[${param.of.map(one => rustKind(one)).join(', ')}])`
    // A reference, because the variant holds one kind rather than a slice of them. `Kind` is `Copy`
    // and every kind here is a const expression, so `&Kind::Text` is a `&'static Kind`.
    if (param.kind === 'listOf') return `Kind::ListOf(&${rustKind(param.of)})`
    return param.kind.charAt(0).toUpperCase() + param.kind.slice(1)
}

/**
 * The table the router refuses a call against.
 *
 * Emitted long — one call per line, no width judgement — and handed to rustfmt, because guessing
 * where rustfmt would break a line is a game the generator cannot win and `npm run check` would
 * lose loudly.
 */
/** The Rust name a vocabulary is emitted under, so a parameter can point at it. */
function vocabularyConst(name) {
    return name.replace(/[A-Z]/gu, letter => `_${letter}`).toUpperCase()
}

/**
 * Every vocabulary, as a const of its own.
 *
 * `accepted` is what the model reads in the signature; `refused` is names the engine does not have,
 * which is what lets the drift check prove the accepted list means something. Both were written out
 * twice, in English, inside two catalogue summaries.
 */
function rustVocabularies(vocabularies) {
    return Object.entries(vocabularies)
        .flatMap(([name, words]) => {
            const konst = vocabularyConst(name)
            const list = names => `&[\n${names.map(word => `    ${rustString(word)},\n`).join('')}]`
            return [
                `/// ${words.note}\npub const ${konst}: &[&str] = ${list(words.accepted)};\n`,
                `/// Names the engine does not have, so the drift check can prove ${konst} means something.\n///\n/// Read only by tests: the engine drift check feeds these to a real editor and requires each to\n/// be refused. Nothing in a shipped build has any use for a list of names that do not work.\n#[allow(dead_code)]\npub const ${konst}_REFUSED: &[&str] = ${list(words.refused)};\n`
            ]
        })
        .join('\n')
}

/**
 * One parameter as the Rust table declares it, wrapper by wrapper.
 *
 * Recursive because an entry shape is made of parameters like any other — `files` holds `edits`
 * holds `{oldText, newText}` — and the checker walks it with the same code that walks the call.
 */
function rustParam(param) {
    const constructor =
        param.hidden ? 'hidden'
        : param.required ? 'need'
        : 'opt'
    let call = `${constructor}(${rustString(param.name)}, ${rustKind(param)})`
    if (param.vocabulary) call = `speaking(${call}, ${vocabularyConst(param.vocabulary)})`
    if (param.entry) call = `shaped(${call}, &[${param.entry.map(rustParam).join(', ')}])`
    return param.note ? `noted(${call}, ${rustString(param.note)})` : call
}

/**
 * One operation as the Rust row declares it, wrapper by wrapper.
 *
 * Everything the router knows about an operation comes off this row: the prose the model reads,
 * the parameters that refuse a call, what answers it, where it may sit in an `ops` list, whether
 * the user is asked first, and what it writes that a rule may refuse. Each of those was a table of
 * its own, keyed on the same `(tool, op)` pair, and a single dispatch looked the same operation up
 * five times over — while a gate or a narrowing naming an operation that had been renamed meant an
 * operation quietly running unapproved or unnarrowed, catchable only by a test that ran afterwards.
 * They are one row of the source, so they are one row here.
 */
function rustOperation(entry) {
    const declared = (entry.params ?? []).map(rustParam)
    // Accepted by the router and left out of the signature, so a desktop client that has
    // always passed `scene` keeps working without the model being told to.
    const accepted = (entry.accepts ?? []).map(name => `hidden("${name}", Text)`)
    const params = [...declared, ...accepted].join(', ')
    // What answers the operation, from the same row that declares its parameters. The router used
    // to rebuild the addon command with `format!("{prefix}.{op}")` and keep a hand-written
    // exception list per domain; this is the mapping those lists approximated.
    const answers = entry.command ? `Answers::Addon(${rustString(entry.command)})` : 'Answers::Rust'
    let call = `op(${rustString(entry.tool)}, ${rustString(entry.op)}, ${rustString(entry.summary)}, ${answers}, &[${params}])`
    if (entry.alone)
        call = `alone(${call}, ${rustScope(entry.alone.scope)}, ${rustString(entry.alone.why)})`
    if (entry.gated) call = `gated(${call}, ${rustString(entry.gated)})`
    if (entry.writes) call = `writes(${call}, ${rustWrites(entry.writes)})`
    return call
}

/** The Rust const one domain's operations are emitted under, which is what `CATALOG` names. */
function operationsConst(tool) {
    return `${tool.toUpperCase()}_OPERATIONS`
}

/** The `Writes` variant for a declared tag. */
function rustWrites(what) {
    return `Writes::${what[0].toUpperCase()}${what.slice(1)}`
}

/**
 * Every operation, as one list per domain and one list of those.
 *
 * Emitted long — one call per line, no width judgement — and handed to rustfmt, because guessing
 * where rustfmt would break a line is a game the generator cannot win and `npm run check` would
 * lose loudly.
 *
 * Per domain rather than one flat table, because `CATALOG` hands its domain's list to the worker
 * whole: the tool the model is given is a name, a description, and these rows. Nothing else names
 * them, which is what makes a list nobody hands to a domain a dead const the compiler reports.
 */
function rustOperations(operations) {
    const byTool = new Map()
    for (const entry of operations) {
        if (!byTool.has(entry.tool)) byTool.set(entry.tool, [])
        byTool.get(entry.tool).push(entry)
    }
    return [...byTool]
        .map(([tool, entries]) => {
            const rows = entries.map(entry => `    ${rustOperation(entry)},\n`).join('')
            return `pub const ${operationsConst(tool)}: &[Operation] = &[\n${rows}];\n`
        })
        .join('\n')
}

/** The `Sharing` variant for a declared scope. */
function rustScope(scope) {
    return `Sharing::${scope[0].toUpperCase()}${scope.slice(1)}`
}

/**
 * The addon's own guard table, keyed by the command the dispatch match uses.
 *
 * `expectedRevision` and `timeoutMs` never appear: the router lifts both onto the envelope, so a
 * handler that demanded them among its parameters would refuse every well-formed call. The same
 * spec therefore means two different things at the two layers, and only the generator knows both.
 */
function gdCommandParams(operations) {
    const rows = operations
        .filter(entry => entry.command)
        .map(entry => {
            const carried = (entry.params ?? []).filter(
                param => param.name !== 'expectedRevision' && param.name !== 'timeoutMs'
            )
            const required = carried
                .filter(param => param.required && !param.hidden)
                .map(param => param.name)
            // `accepts` is the addon's alone: a parameter its handler reads and the model is never
            // shown. `scene` is the whole population — every node command takes it, defaults it to
            // the open scene, and the desktop client is what passes it.
            const optional = [
                ...carried
                    .filter(param => !param.required || param.hidden)
                    .map(param => param.name),
                ...(entry.accepts ?? [])
            ]
            const list = names => `[${names.map(name => `"${name}"`).join(', ')}]`
            return `    "${entry.command}": {"required": ${list(required)}, "optional": ${list(optional)}},\n`
        })
        .join('')
    return `const COMMAND_PARAMS: Dictionary = {\n${rows}}\n`
}

function tomlAllowList(names) {
    return `commands.allow = [\n${[...names]
        .sort()
        .map(name => `    "${name}",\n`)
        .join('')}]\n`
}

/**
 * The sub-agent's ceilings as Rust enforces them: the table the validator walks, and the six
 * functions serde fills a missing field from.
 *
 * The functions are emitted rather than left beside the table because the default and the range are
 * one fact about one ceiling. Written apart, a default outside its own range is a settings file
 * that loads and then refuses to save.
 */
function rustSubagentBounds(bounds) {
    const table = bounds
        .map(
            bound =>
                `    (${rustString(bound.name)}, |s| s.${bound.field}, ${grouped(bound.min)}, ${grouped(bound.max)}),\n`
        )
        .join('')
    const defaults = bounds
        .map(bound => {
            const summary = wrapDoc(bound.summary)
            const note = bound.defaultNote ? `///\n${wrapDoc(bound.defaultNote)}` : ''
            return `${summary}${note}fn default_subagent_${bound.field}() -> u32 {\n    ${grouped(bound.default)}\n}\n`
        })
        .join('\n')
    return `const SUBAGENT_BOUNDS: [SubagentBound; ${bounds.length}] = [\n${table}];\n\n${defaults}`
}

/**
 * What Gofer knows about each Cerebras model, as a table `cerebras_model_options` reads.
 *
 * A `const` rather than a function per model, because the lister walks it: the offered catalogue is
 * the live id list intersected with this, and an intersection needs something to iterate.
 */
function rustCerebrasModels(models) {
    const rows = models
        .map(model => {
            const note = `${wrapPrefixed(model.note, '    // ', 100)}\n`
            const input = model.input.map(rustString).join(', ')
            const levels = model.thinkingLevels.map(rustString).join(', ')
            const off =
                model.offEffort === undefined ? 'None' : `Some(${rustString(model.offEffort)})`
            return (
                `${note}    CerebrasModel {\n`
                + `        id: ${rustString(model.id)},\n`
                + `        name: ${rustString(model.name)},\n`
                + `        context_window: ${grouped(model.contextWindow)},\n`
                + `        max_tokens: ${grouped(model.maxTokens)},\n`
                + `        input: &[${input}],\n`
                + `        thinking_levels: &[${levels}],\n`
                + `        reasoning_mandatory: ${model.reasoningMandatory},\n`
                + `        off_effort: ${off},\n`
                + `    },\n`
            )
        })
        .join('')
    return `const CEREBRAS_MODELS: [CerebrasModel; ${models.length}] = [\n${rows}];\n`
}

/**
 * An integer literal, digit-grouped from a thousand up, which is how both sources spell one.
 *
 * Rust and TypeScript agree on `_` as the separator and on what it means, so one function serves
 * both regions rather than two that could come to disagree about `24_000`.
 */
function grouped(value) {
    return value >= 1_000 ? value.toLocaleString('en-US').replace(/,/gu, '_') : String(value)
}

/**
 * One prose sentence as a `///` block, wrapped where the file it lands in is wrapped.
 *
 * rustfmt leaves doc comments exactly as it finds them, so an unwrapped one is a line the formatter
 * will not fix and `cargo fmt --check` will not complain about — it would simply be the only
 * three-hundred-character line in the file.
 */
function wrapDoc(note) {
    return `${wrapPrefixed(note, '/// ', 100)}\n`
}

/**
 * The same ceilings as the settings page offers them: the defaults that fill in a settings file
 * written before this section existed, and the range each slider may be dragged to.
 *
 * Emitted to prettier's own formatting — four spaces, no semicolons, no bracket spacing — because
 * `npm run check` runs `format:check` over the file this lands in.
 */
function typescriptSubagentBounds(bounds) {
    const defaults = bounds.map(bound => `    ${bound.name}: ${grouped(bound.default)}`).join(',\n')
    const ranges = bounds
        .map(bound => {
            const note = bound.rangeNote ? `${wrapPrefixed(bound.rangeNote, '    // ', 100)}\n` : ''
            return `${note}    ${bound.name}: {min: ${grouped(bound.min)}, max: ${grouped(bound.max)}, step: ${grouped(bound.step)}}`
        })
        .join(',\n')
    return (
        `export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {\n${defaults}\n}\n\n`
        + `export const SUBAGENT_RANGES = {\n${ranges}\n} as const\n`
    )
}

/** Wraps prose so that `prefix` plus each line stays inside `width`. */
function wrapPrefixed(note, prefix, width) {
    const lines = []
    let line = ''
    for (const word of note.split(' ')) {
        if (line && prefix.length + line.length + 1 + word.length > width) {
            lines.push(prefix + line)
            line = word
            continue
        }
        line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(prefix + line)
    return lines.join('\n')
}

// --- What each file gets.

export async function generateSurfaces() {
    const mutating = await mutatingCommands()
    const commands = await catalogue()
    const runtime = await runtimeCatalogue()
    const desktop = await registeredDesktopCommands()
    const {operations: parameters, vocabularies} = await parameterCatalogue()
    const subagentBounds = await subagentBoundsCatalogue()
    const cerebrasModels = await cerebrasModelCatalogue()

    const declared = new Set(commands.map(entry => entry.command))
    for (const name of mutating) {
        if (!declared.has(name))
            throw new Error(
                `protocol/schemas/v2/request.schema.json calls ${name} mutating, but commands.json binds no handler to it`
            )
    }
    for (const name of runtime) {
        if (declared.has(name))
            throw new Error(
                `protocol/schemas/v2/commands.json lists ${name} as a runtime command and binds a handler to it as well`
            )
    }
    // A parameter contract for a command nobody answers is a contract that will never be enforced,
    // and the misspelling behind one is invisible in every other file.
    const answered = new Set([...declared, ...runtime])
    for (const entry of parameters) {
        if (!entry.command) continue
        if (!answered.has(entry.command))
            throw new Error(
                `protocol/schemas/v2/params.json declares parameters for ${entry.command}, which commands.json does not answer`
            )
    }

    const edits = [
        {
            path: 'src-tauri/addon/plugin.gd',
            comment: '#',
            regions: [
                {name: 'mutating-commands', body: gdMutating(mutating)},
                {name: 'runtime-commands', body: gdRuntimeCommands(runtime)},
                {name: 'dispatch-table', body: gdDispatch(commands)}
            ]
        },
        {
            // The table lives with the only function that reads it, which is preloadable and so
            // reachable by `params_test.gd` without booting an editor.
            path: 'src-tauri/addon/params.gd',
            comment: '#',
            regions: [{name: 'command-params', body: gdCommandParams(parameters)}]
        },
        {
            path: 'src-tauri/src/protocol_v2.rs',
            comment: '//',
            regions: [{name: 'mutating-commands', body: rustMutating(mutating)}]
        },
        {
            path: 'src-tauri/src/tool_params.rs',
            comment: '//',
            rustfmt: true,
            regions: [
                {name: 'vocabularies', body: rustVocabularies(vocabularies)},
                {name: 'operations', body: rustOperations(parameters)}
            ]
        },
        {
            path: 'src-tauri/src/settings.rs',
            comment: '//',
            rustfmt: true,
            regions: [
                {name: 'subagent-bounds', body: rustSubagentBounds(subagentBounds)},
                {name: 'cerebras-models', body: rustCerebrasModels(cerebrasModels)}
            ]
        },
        {
            path: 'src/models/settings.ts',
            comment: '//',
            regions: [{name: 'subagent-bounds', body: typescriptSubagentBounds(subagentBounds)}]
        },
        {
            path: 'src/models/godot-commands.ts',
            comment: '//',
            regions: [
                {
                    name: 'command-names',
                    body: typescriptCommandNames([
                        ...commands.map(entry => entry.command),
                        ...runtime
                    ])
                }
            ]
        },
        {
            path: 'src-tauri/permissions/main-window-commands.toml',
            comment: '#',
            regions: [{name: 'allow-list', body: tomlAllowList(desktop)}]
        }
    ]

    const results = []
    for (const {path, comment, regions, rustfmt} of edits) {
        const before = await read(path)
        let after = before
        for (const {name, body} of regions) after = replaceRegion(after, path, comment, name, body)
        // The checksum is of the body the generator wrote, so formatting has to happen first or
        // `--check` would compare a formatted file against an unformatted checksum forever.
        if (rustfmt && after !== before) {
            const {name} = regions[0]
            const formatted = await formatRust(after, path)
            after = replaceRegion(
                formatted,
                path,
                comment,
                name,
                sliceRegion(formatted, path, comment, name)
            )
        }
        results.push({path, before, after})
    }
    return results
}

/** The body between one region's markers, after the whole file has been through rustfmt. */
function sliceRegion(text, path, comment, name) {
    const {beginPrefix, end} = markers(comment, name)
    const start = text.indexOf(beginPrefix)
    if (start === -1) throw new Error(`${path} no longer marks the generated region ${name}`)
    const lineEnd = text.indexOf('\n', start) + 1
    const stop = text.indexOf(end, lineEnd)
    if (stop === -1) throw new Error(`${path} never closes the generated region ${name}`)
    return text.slice(lineEnd, stop)
}

/**
 * Hands a whole Rust file to rustfmt and returns what it makes of it.
 *
 * The generator emits one `op(...)` call per line and lets rustfmt decide where the lines break.
 * Predicting that by hand is a game the generator cannot win, and losing it fails `npm run check`
 * on a file nobody edited.
 */
async function formatRust(text, path) {
    const {spawn} = await import('node:child_process')
    return await new Promise((resolve, reject) => {
        const child = spawn('rustfmt', ['--edition', '2024', '--emit', 'stdout', '--quiet'], {
            stdio: ['pipe', 'pipe', 'pipe']
        })
        let out = ''
        let error = ''
        child.stdout.on('data', chunk => (out += chunk))
        child.stderr.on('data', chunk => (error += chunk))
        child.on('error', cause =>
            reject(
                new Error(`${GENERATOR} needs rustfmt on PATH to emit ${path}: ${cause.message}`)
            )
        )
        child.on('close', code =>
            code === 0 ?
                resolve(out)
            :   reject(new Error(`rustfmt refused ${path}: ${error.trim() || `exit ${code}`}`))
        )
        child.stdin.end(text)
    })
}

/** Throws naming every file whose generated region no longer matches its source. */
export async function checkSurfacesAreGenerated() {
    const stale = (await generateSurfaces())
        .filter(result => result.before !== result.after)
        .map(result => result.path)
    if (stale.length > 0)
        throw new Error(
            `these generated regions do not match their source — run \`npm run generate\`:\n${stale.join('\n')}`
        )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--check')) await checkSurfacesAreGenerated()
    else {
        for (const {path, before, after} of await generateSurfaces()) {
            if (before === after) continue
            await writeFile(new URL(path, `file://${root}`), after)
            console.log(`${GENERATOR}: rewrote ${path}`)
        }
    }
}
