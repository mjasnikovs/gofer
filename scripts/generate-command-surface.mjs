import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const GENERATOR = 'scripts/generate-command-surface.mjs'

async function read(path) {
    return await readFile(new URL(path, `file://${root}`), 'utf8')
}

function slice(text, path, open, close) {
    const start = text.indexOf(open)
    if (start === -1) throw new Error(`${path} no longer contains ${JSON.stringify(open)}`)
    const rest = text.slice(start + open.length)
    const end = rest.indexOf(close)
    if (end === -1) throw new Error(`${path} never closes ${JSON.stringify(open)}`)
    return rest.slice(0, end)
}

async function mutatingCommands() {
    const path = 'protocol/schemas/v2/request.schema.json'
    const names = JSON.parse(await read(path)).allOf?.[0]?.if?.properties?.command?.enum
    if (!Array.isArray(names) || names.length === 0)
        throw new Error(`${path} no longer enumerates the mutating commands`)
    return names
}

async function runtimeCatalogue() {
    const path = 'protocol/schemas/v2/commands.json'
    const {runtimeCommands} = JSON.parse(await read(path))
    if (!Array.isArray(runtimeCommands) || runtimeCommands.length === 0)
        throw new Error(`${path} lists no runtime commands`)
    return runtimeCommands
}

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
        if (typeof entry.summary !== 'string' || entry.summary.trim() === '')
            throw new Error(`${path}: ${entry.tool} ${entry.op} has no summary`)
        if ('writes' in entry && !WRITES.includes(entry.writes))
            throw new Error(
                `${path}: ${entry.tool} ${entry.op} writes ${JSON.stringify(entry.writes)}, not one of ${WRITES.join(', ')}`
            )
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

const ALONE_SCOPES = ['repeat', 'exclusive']

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
    if (param.kind === 'listOf') {
        if (!param.of?.kind) throw new Error(`${where} is a listOf nothing`)
        if (param.of.kind === 'list' || param.of.kind === 'listOf' || param.of.kind === 'object')
            throw new Error(`${where} is a listOf ${param.of.kind}; use an entry shape for that`)
        checkKind(path, entry, {...param.of, name: param.name})
    }
    if (param.entry) {
        if (param.kind !== 'list' && param.kind !== 'object')
            throw new Error(`${where} is a ${param.kind}, which has no entries to shape`)
        if (!Array.isArray(param.entry) || param.entry.length === 0)
            throw new Error(`${where} declares an empty entry shape`)
        for (const inner of param.entry)
            checkKind(path, entry, {...inner, name: `${param.name}.${inner.name}`})
    }
}

/** The addon script a `module` names, as a PascalCase preload constant. */
function moduleConstant(module) {
    return module.replace(/(^|_)([a-z])/gu, (_all, _sep, letter) => letter.toUpperCase())
}

async function catalogue() {
    const path = 'protocol/schemas/v2/commands.json'
    const {commands} = JSON.parse(await read(path))
    if (!Array.isArray(commands) || commands.length === 0)
        throw new Error(`${path} lists no commands`)
    const sources = new Map()
    const sourceOf = async module => {
        const file = `src-tauri/addon/${module ?? 'plugin'}.gd`
        if (!sources.has(file)) sources.set(file, await read(file))
        return {file, source: sources.get(file)}
    }
    return await Promise.all(
        commands.map(async ({command, handler, module}) => {
            const {file, source} = await sourceOf(module)
            const declared = module ? 'static func' : 'func'
            const signature = source.match(
                new RegExp(`^${declared} ${handler}\\(([^)]*)\\) ->`, 'mu')
            )?.[1]
            if (signature === undefined)
                throw new Error(
                    `${path} binds ${command} to ${handler}, which ${file} does not define`
                )
            return {
                command,
                handler,
                module,
                takesParams: signature.trim().length > 0
            }
        })
    )
}

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

function replaceRegion(text, path, comment, name, body) {
    const {beginPrefix, begin, end} = markers(comment, name)
    const start = text.indexOf(beginPrefix)
    if (start === -1) throw new Error(`${path} no longer marks the generated region ${name}`)
    const lineEnd = text.indexOf('\n', start)
    const stop = text.indexOf(end, lineEnd)
    if (stop === -1) throw new Error(`${path} never closes the generated region ${name}`)
    return text.slice(0, start) + begin(checksum(body)) + '\n' + body + text.slice(stop)
}

async function driverCatalogue() {
    const path = 'protocol/drivers.json'
    const {drivers, secrets} = JSON.parse(await read(path))
    if (!Array.isArray(drivers) || drivers.length === 0)
        throw new Error(`${path} declares no drivers`)
    if (!Array.isArray(secrets) || secrets.length === 0)
        throw new Error(`${path} declares no secrets`)
    const slots = new Set()
    for (const secret of secrets) {
        for (const key of ['id', 'variant', 'username', 'noun'])
            if (typeof secret[key] !== 'string' || secret[key].trim() === '')
                throw new Error(`${path}: a secret has no ${key}`)
        if (!['api-key', 'oauth'].includes(secret.kind))
            throw new Error(`${path}: ${secret.id} is neither an api-key nor an oauth credential`)
        if (!['refused', 'clears'].includes(secret.blank))
            throw new Error(`${path}: ${secret.id} does not say what an empty box means`)
        if (slots.has(secret.username))
            throw new Error(`${path}: two secrets share the keyring slot ${secret.username}`)
        slots.add(secret.username)
    }
    const known = new Set(secrets.map(secret => secret.id))
    const seen = new Map()
    for (const driver of drivers) {
        for (const key of ['id', 'variant', 'label', 'shortName', 'note'])
            if (typeof driver[key] !== 'string' || driver[key].trim() === '')
                throw new Error(`${path}: a driver has no ${key}`)
        if (!/^[a-z0-9-]+$/u.test(driver.id))
            throw new Error(`${path}: ${driver.id} is not a wire word`)
        for (const [key, value] of [
            ['id', driver.id],
            ['variant', driver.variant]
        ]) {
            const where = `${key}:${value}`
            if (seen.has(where)) throw new Error(`${path}: two drivers share the ${key} ${value}`)
            seen.set(where, driver)
        }
        if (driver.providerId !== null && typeof driver.providerId !== 'string')
            throw new Error(`${path}: ${driver.id} has neither a provider id nor an honest null`)
        if (!known.has(driver.secret))
            throw new Error(`${path}: ${driver.id} authenticates with no secret this file lists`)
    }
    const shipped = drivers.filter(driver => driver.providerId === null)
    if (shipped.length !== 1 || shipped[0].id !== 'openai-codex')
        throw new Error(
            `${path}: ChatGPT is the one driver whose provider pi-ai ships, and ${
                shipped.map(one => one.id).join(', ') || 'nothing'
            } declines a provider id`
        )
    return {drivers, secrets}
}

async function turnRetryCatalogue() {
    const path = 'protocol/turn-retry.json'
    const {bounds} = JSON.parse(await read(path))
    if (!Array.isArray(bounds) || bounds.length === 0) throw new Error(`${path} declares no bounds`)
    for (const bound of bounds) {
        if (typeof bound.name !== 'string' || !/^[a-zA-Z]+$/u.test(bound.name))
            throw new Error(`${path}: a bound has no name`)
        if (!Number.isInteger(bound.value) || bound.value < 0)
            throw new Error(`${path}: ${bound.name} is not a whole number of its own unit`)
        if (typeof bound.note !== 'string' || bound.note.trim() === '')
            throw new Error(`${path}: ${bound.name} does not say why it is what it is`)
    }
    return bounds
}

function nodeTurnRetry(bounds) {
    const rows = bounds
        .map(
            bound =>
                `${wrapPrefixed(bound.note, '    // ', 100)}\n    ${bound.name}: ${grouped(bound.value)}`
        )
        .join(',\n')
    return (
        '/** What a parent turn does when the provider fails. Overridden per call, never per file. */\n'
        + `export const TURN_RETRY = {\n${rows}\n}\n`
    )
}

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
        const expected = bound.name.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`)
        if (bound.field !== expected)
            throw new Error(
                `${path}: ${bound.name} names the Rust field ${bound.field}, not ${expected}`
            )
    }
    return bounds
}

/**
 * One shipped model table, held to the rules every row of one has to obey.
 *
 * Two files have this shape — Cerebras' and Qwen's — because two endpoints publish no
 * capabilities at all. The rules are the same rules, so they are written once here rather
 * than copied per file, which is how the three copies of the driver set went wrong.
 */
async function shippedModelCatalogue(path) {
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

const NAMED_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function gdMutating(names) {
    return `const MUTATING_COMMANDS: Array[String] = [\n${names
        .map(name => `    "${name}",\n`)
        .join('')}]\n`
}

function gdDispatch(commands) {
    const cases = commands
        .map(
            ({command, handler, module, takesParams}) =>
                `        "${command}":\n            return ${module ? `${moduleConstant(module)}.` : ''}${handler}(${takesParams ? 'params' : ''})\n`
        )
        .join('')
    return `    match command:\n${cases}    return Params.unknown_command_error(command)\n`
}

function gdRuntimeCommands(names) {
    return `const RUNTIME_COMMANDS: Array[String] = [\n${names
        .map(name => `    "${name}",\n`)
        .join('')}]\n`
}

function typescriptCommandNames(names) {
    return `export type GodotCommandName =\n${names.map(name => `    | '${name}'\n`).join('')}`
}

function rustMutating(names) {
    return `pub const MUTATING_COMMANDS: [&str; ${names.length}] = [\n${names
        .map(name => `    "${name}",\n`)
        .join('')}];\n`
}

function rustString(text) {
    return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`
}

function rustKind(param) {
    if (param.kind === 'choice')
        return `Kind::Choice(&[${param.of.map(word => rustString(word)).join(', ')}])`
    if (param.kind === 'either')
        return `Kind::Either(&[${param.of.map(one => rustKind(one)).join(', ')}])`
    if (param.kind === 'listOf') return `Kind::ListOf(&${rustKind(param.of)})`
    return param.kind.charAt(0).toUpperCase() + param.kind.slice(1)
}

function vocabularyConst(name) {
    return name.replace(/[A-Z]/gu, letter => `_${letter}`).toUpperCase()
}

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

function rustOperation(entry) {
    const declared = (entry.params ?? []).map(rustParam)
    const accepted = (entry.accepts ?? []).map(name => `hidden("${name}", Text)`)
    const params = [...declared, ...accepted].join(', ')
    const answers = entry.command ? `Answers::Addon(${rustString(entry.command)})` : 'Answers::Rust'
    let call = `op(${rustString(entry.tool)}, ${rustString(entry.op)}, ${rustString(entry.summary)}, ${answers}, &[${params}])`
    if (entry.alone)
        call = `alone(${call}, ${rustScope(entry.alone.scope)}, ${rustString(entry.alone.why)})`
    if (entry.gated) call = `gated(${call}, ${rustString(entry.gated)})`
    if (entry.writes) call = `writes(${call}, ${rustWrites(entry.writes)})`
    return call
}

function operationsConst(tool) {
    return `${tool.toUpperCase()}_OPERATIONS`
}

function rustWrites(what) {
    return `Writes::${what[0].toUpperCase()}${what.slice(1)}`
}

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

function rustScope(scope) {
    return `Sharing::${scope[0].toUpperCase()}${scope.slice(1)}`
}

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

function rustShippedModels(models, constName) {
    const rows = models
        .map(model => {
            const note = `${wrapPrefixed(model.note, '    // ', 100)}\n`
            const input = model.input.map(rustString).join(', ')
            const levels = model.thinkingLevels.map(rustString).join(', ')
            const off =
                model.offEffort === undefined ? 'None' : `Some(${rustString(model.offEffort)})`
            return (
                `${note}    ShippedModel {\n`
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
    return `const ${constName}: [ShippedModel; ${models.length}] = [\n${rows}];\n`
}

function grouped(value) {
    return value >= 1_000 ? value.toLocaleString('en-US').replace(/,/gu, '_') : String(value)
}

function wrapDoc(note) {
    return `${wrapPrefixed(note, '/// ', 100)}\n`
}

function rustDrivers(drivers) {
    const arms = drivers
        .map(driver => `        AiConnectionType::${driver.variant} => ${rustString(driver.id)},\n`)
        .join('')
    const listed = drivers.map(driver => rustString(driver.id)).join(', ')
    return (
        '/// The word a driver is written down as, on the wire and in the settings file.\n'
        + '///\n'
        + '/// Never the display label: a file holding `OpenRouter` matches no driver this build\n'
        + '/// knows.\n'
        + "fn driver_id(driver: AiConnectionType) -> &'static str {\n"
        + '    match driver {\n'
        + `${arms}`
        + '    }\n'
        + '}\n\n'
        + '/// Every driver a build knows, in the order the pickers offer them.\n'
        + '///\n'
        + '/// Read only by the test that round-trips each id through serde and back through\n'
        + '/// `driver_id`. Rust itself needs no list: the enum is the list, and the match above is\n'
        + '/// exhaustive over it.\n'
        + '#[cfg(test)]\n'
        + `const DRIVER_IDS: [&str; ${drivers.length}] = [${listed}];\n`
    )
}

/// Everything about a stored secret that used to be a match per question, and the one pairing
/// — which credential a driver authenticates with — that used to be written down five times.
function rustSecrets(drivers, secrets) {
    const arm = (of, to) => `        Self::${of} => ${to},\n`
    const ids = secrets.map(secret => arm(secret.variant, rustString(secret.id))).join('')
    const usernames = secrets
        .map(secret => arm(secret.variant, rustString(secret.username)))
        .join('')
    const nouns = secrets.map(secret => arm(secret.variant, rustString(secret.noun))).join('')
    const blanks = secrets
        .map(secret =>
            arm(secret.variant, `Blank::${secret.blank === 'clears' ? 'Clears' : 'Refused'}`)
        )
        .join('')
    const keys = secrets.map(secret => arm(secret.variant, secret.kind === 'api-key')).join('')
    const order = secrets.map(secret => `Self::${secret.variant}`).join(', ')
    const froms = secrets
        .map(secret => `            ${rustString(secret.id)} => Some(Self::${secret.variant}),\n`)
        .join('')
    const pairing = drivers
        .map(driver => {
            const secret = secrets.find(one => one.id === driver.secret)
            return `        AiConnectionType::${driver.variant} => Secret::${secret.variant},\n`
        })
        .join('')
    return (
        'impl Secret {\n'
        + '    /// The word a request and a response key this secret by.\n'
        + "    pub(crate) const fn id(self) -> &'static str {\n"
        + `        match self {\n${ids}        }\n`
        + '    }\n\n'
        + '    /// The username this secret is stored under, beneath the one service. A second\n'
        + '    /// username is how one keyring holds more than one secret.\n'
        + "    pub(super) const fn username(self) -> &'static str {\n"
        + `        match self {\n${usernames}        }\n`
        + '    }\n\n'
        + '    /// What this secret is called in the one sentence a user ever reads about it.\n'
        + "    pub(super) const fn noun(self) -> &'static str {\n"
        + `        match self {\n${nouns}        }\n`
        + '    }\n\n'
        + '    /// What an empty box means, which is not the same answer for all of them.\n'
        + '    pub(super) const fn blank(self) -> Blank {\n'
        + `        match self {\n${blanks}        }\n`
        + '    }\n\n'
        + '    /// Whether a request carries a bearer token from this, or a login writes it.\n'
        + '    pub(crate) const fn is_api_key(self) -> bool {\n'
        + `        match self {\n${keys}        }\n`
        + '    }\n\n'
        + '    /// The secret one wire word names, or nothing when the word names none.\n'
        + '    pub(crate) fn from_id(word: &str) -> Option<Self> {\n'
        + `        match word {\n${froms}            _ => None,\n        }\n`
        + '    }\n\n'
        + '    /// Every secret Gofer keeps, in the order a save writes them.\n'
        + `    pub(crate) const ORDER: [Self; ${secrets.length}] = [${order}];\n`
        + '}\n\n'
        + '/// The one credential a driver authenticates with.\n'
        + '///\n'
        + '/// A key sent to the wrong address is a key handed to a machine that was never meant to\n'
        + '/// see it. This pairing was a match here, a second match in `catalogue.rs`, a table in a\n'
        + '/// React file and two record literals in a hook; it is one row of `protocol/drivers.json`\n'
        + '/// now, and every one of those is a lookup.\n'
        + 'pub(crate) const fn driver_secret(driver: AiConnectionType) -> Secret {\n'
        + `    match driver {\n${pairing}    }\n`
        + '}\n'
    )
}

function typescriptDrivers(drivers, secrets) {
    const union = drivers.map(driver => `'${driver.id}'`).join(' | ')
    const listed = drivers.map(driver => `    '${driver.id}'`).join(',\n')
    const labels = drivers
        .map(driver => {
            const key = /^[a-z][a-z0-9]*$/u.test(driver.id) ? driver.id : `'${driver.id}'`
            return `${wrapPrefixed(driver.note, '    // ', 100)}\n    ${key}: '${driver.label}'`
        })
        .join(',\n')
    return (
        `${declared('export type AiConnectionType =', union)}\n\n`
        + '/** Every driver a build knows, in the order the pickers offer them. */\n'
        + `export const AI_CONNECTION_TYPES: readonly AiConnectionType[] = [\n${listed}\n]\n\n`
        + '/**\n'
        + ' * What each driver is called on screen. Separate from the stored id, and one-directional:\n'
        + ' * a label must never be written to the settings file. Same rule as `SEARCH_PROVIDER_LABELS`.\n'
        + ' */\n'
        + 'export const AI_CONNECTION_LABELS: Readonly<Record<AiConnectionType, string>> = {\n'
        + `${labels}\n`
        + '}\n\n'
        + typescriptSecrets(drivers, secrets)
    )
}

function typescriptSecrets(drivers, secrets) {
    const key = id => (/^[a-z][a-z0-9]*$/u.test(id) ? id : `'${id}'`)
    const union = secrets.map(secret => `'${secret.id}'`).join(' | ')
    const listed = secrets.map(secret => `    '${secret.id}'`).join(',\n')
    const typed = secrets.filter(secret => secret.kind === 'api-key')
    const typedUnion = typed.map(secret => `'${secret.id}'`).join(' | ')
    const typedListed = typed.map(secret => `    '${secret.id}'`).join(',\n')
    const pairing = drivers.map(driver => `    ${key(driver.id)}: '${driver.secret}'`).join(',\n')
    const typedNames = new Set(typed.map(secret => secret.id))
    const typedPairing = drivers
        .filter(driver => typedNames.has(driver.secret))
        .map(driver => `    ${key(driver.id)}: '${driver.secret}'`)
        .join(',\n')
    return (
        `${declared('export type SecretName =', union)}\n\n`
        + '/** Every secret Gofer keeps, in the order a save writes them. */\n'
        + `export const SECRET_NAMES: readonly SecretName[] = [\n${listed}\n]\n\n`
        + '/**\n'
        + ' * The secrets a person types into a box, which is every one but the OAuth credential.\n'
        + ' *\n'
        + ' * A ChatGPT credential is written by its login, so a settings save that named it would\n'
        + ' * be saying something the page cannot mean.\n'
        + ' */\n'
        + `${declared('export type TypedSecret =', typedUnion)}\n\n`
        + `export const TYPED_SECRET_NAMES: readonly TypedSecret[] = [\n${typedListed}\n]\n\n`
        + '/**\n'
        + ' * The one credential each driver authenticates with.\n'
        + ' *\n'
        + ' * A key sent to the wrong address is a key handed to a machine that was never meant to\n'
        + ' * see it, so this pairing is one row of `protocol/drivers.json` and every reader of it is\n'
        + ' * a lookup. It used to be a match in Rust, a second match in another Rust file, a table in\n'
        + ' * this renderer and two hand-written record literals in a hook.\n'
        + ' */\n'
        + 'export const AI_CONNECTION_SECRETS: Readonly<Record<AiConnectionType, SecretName>> = {\n'
        + `${pairing}\n`
        + '}\n\n'
        + '/**\n'
        + ' * The same pairing, narrowed to the drivers whose secret is typed into a box.\n'
        + ' *\n'
        + ' * A driver that signs in has no box, so it has no entry — and a page that draws one\n'
        + ' * reads `undefined` rather than being handed a slot that belongs to another driver.\n'
        + ' */\n'
        + 'export const TYPED_DRIVER_SECRETS: Partial<Readonly<Record<AiConnectionType, TypedSecret>>> = {\n'
        + `${typedPairing}\n`
        + '}\n'
    )
}

function nodeDrivers(drivers) {
    const key = id => (/^[a-z][a-z0-9]*$/u.test(id) ? id : `'${id}'`)
    const oneLine = `export const DRIVERS = [${drivers.map(one => `'${one.id}'`).join(', ')}]`
    const listed = drivers.map(driver => `    '${driver.id}'`).join(',\n')
    const ids = drivers
        .filter(driver => driver.providerId !== null)
        .map(driver => `    ${key(driver.id)}: '${driver.providerId}'`)
        .join(',\n')
    const names = drivers.map(driver => `    ${key(driver.id)}: '${driver.shortName}'`).join(',\n')
    const slots = drivers.map(driver => `    ${key(driver.id)}: '${driver.secret}'`).join(',\n')
    const hosted = drivers.filter(driver => driver.providerId !== null && driver.id !== 'local')
    return (
        '/** Every driver a build knows, in the order the pickers offer them. */\n'
        + (oneLine.length <= PRINT_WIDTH ?
            `${oneLine}\n\n`
        :   `export const DRIVERS = [\n${listed}\n]\n\n`)
        + '/** Which pi-ai provider answers each driver. ChatGPT has none: pi-ai ships its own. */\n'
        + `const PROVIDER_IDS = {\n${ids}\n}\n\n`
        + '/** What each driver is called in the one sentence a user reads about its connection. */\n'
        + `const DRIVER_NAMES = {\n${names}\n}\n\n`
        + '/**\n'
        + ' * Which stored secret each driver authenticates with.\n'
        + ' *\n'
        + ' * A key used to reach the worker as its own named field, so the name had to be spelt\n'
        + ' * the same on both sides of the process boundary and a driver whose field nobody\n'
        + ' * passed registered with no key at all. The request carries a map keyed by slot now,\n'
        + ' * and this is the lookup into it.\n'
        + ' */\n'
        + `export const DRIVER_SECRETS = {\n${slots}\n}\n\n`
        + '/**\n'
        + ' * The hosted drivers `createModelContext` has to build a provider for, in order.\n'
        + ' *\n'
        + ' * Not every driver. pi-ai ships the ChatGPT provider, and the local one is registered\n'
        + ' * on its own because its key falls back to a placeholder where a hosted key must not.\n'
        + ' * What is left is the loop, and it used to be a hand-written pair of names — so a\n'
        + ' * fifth hosted driver passed `providerIdOf`, was never registered, and failed inside\n'
        + ' * pi-ai under a provider id nothing had created.\n'
        + ' */\n'
        + `const HOSTED_DRIVERS = [${hosted.map(one => `'${one.id}'`).join(', ')}]\n`
    )
}

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

/**
 * The formatter's own `printWidth`, which decides where an emitted line has to be broken.
 *
 * Written down because a generator that guesses it emits code `format:check` rewrites, and the
 * rewrite lands inside a `GENERATED` region — so the next `check:command-surface` fails on a file
 * nobody edited. It was 120 here and 100 in `.prettierrc.cjs`, and a fifth driver is what made the
 * union long enough for the two to disagree.
 */
const PRINT_WIDTH = 100

/** One declaration, on its line or wrapped onto the next, the way Prettier would write it. */
function declared(head, body) {
    const oneLine = `${head} ${body}`
    return oneLine.length <= PRINT_WIDTH ? oneLine : `${head}\n    ${body}`
}

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

export async function generateSurfaces() {
    const mutating = await mutatingCommands()
    const commands = await catalogue()
    const runtime = await runtimeCatalogue()
    const desktop = await registeredDesktopCommands()
    const {operations: parameters, vocabularies} = await parameterCatalogue()
    const subagentBounds = await subagentBoundsCatalogue()
    const cerebrasModels = await shippedModelCatalogue('protocol/cerebras-models.json')
    const qwenModels = await shippedModelCatalogue('protocol/qwen-models.json')
    const {drivers, secrets} = await driverCatalogue()
    const turnRetry = await turnRetryCatalogue()

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
            path: 'src-tauri/src/settings/mod.rs',
            comment: '//',
            rustfmt: true,
            regions: [
                {name: 'subagent-bounds', body: rustSubagentBounds(subagentBounds)},
                {
                    name: 'cerebras-models',
                    body: rustShippedModels(cerebrasModels, 'CEREBRAS_MODELS')
                },
                {name: 'qwen-models', body: rustShippedModels(qwenModels, 'QWEN_MODELS')},
                {name: 'drivers', body: rustDrivers(drivers)}
            ]
        },
        {
            path: 'src-tauri/src/settings/secrets.rs',
            comment: '//',
            rustfmt: true,
            regions: [{name: 'secrets', body: rustSecrets(drivers, secrets)}]
        },
        {
            path: 'src/models/settings.ts',
            comment: '//',
            regions: [
                {name: 'subagent-bounds', body: typescriptSubagentBounds(subagentBounds)},
                {name: 'drivers', body: typescriptDrivers(drivers, secrets)}
            ]
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
            path: 'scripts/ai-provider.mjs',
            comment: '//',
            regions: [
                {name: 'drivers', body: nodeDrivers(drivers)},
                {name: 'turn-retry', body: nodeTurnRetry(turnRetry)}
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

function sliceRegion(text, path, comment, name) {
    const {beginPrefix, end} = markers(comment, name)
    const start = text.indexOf(beginPrefix)
    if (start === -1) throw new Error(`${path} no longer marks the generated region ${name}`)
    const lineEnd = text.indexOf('\n', start) + 1
    const stop = text.indexOf(end, lineEnd)
    if (stop === -1) throw new Error(`${path} never closes the generated region ${name}`)
    return text.slice(lineEnd, stop)
}

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
