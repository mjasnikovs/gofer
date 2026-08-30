import {readdir, readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {checkSurfacesAreGenerated} from './generate-command-surface.mjs'
import * as aiEvents from './ai-events.mjs'
import * as briefCatalogue from './brief/catalogue.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function slice(text, path, open, close) {
    const start = text.indexOf(open)
    if (start === -1) throw new Error(`${path} no longer contains ${JSON.stringify(open)}`)
    const rest = text.slice(start + open.length)
    const end = rest.indexOf(close)
    if (end === -1) throw new Error(`${path} never closes ${JSON.stringify(open)}`)
    return rest.slice(0, end)
}

function quoted(text) {
    return [...text.matchAll(/["']([^"']+)["']/gu)].map(match => match[1])
}

async function read(path) {
    return await readFile(new URL(path, `file://${root}`), 'utf8')
}

async function tauriHandlers() {
    const path = 'src-tauri/src/lib.rs'
    const list = slice(
        await read(path),
        path,
        'builder.invoke_handler(tauri::generate_handler![',
        ']);'
    )
    return {
        path,
        names: list
            .split(',')
            .map(name => name.trim())
            .filter(Boolean)
    }
}

async function desktopTypes() {
    const path = 'src/services/desktop.ts'
    const map = slice(await read(path), path, 'type DesktopCommandMap = Readonly<{', '\n}>')
    const declared = [
        ...map.matchAll(/^ {4}(?:'([^']+)'|([a-z_][a-z0-9_]*)): CommandSpec</gmu)
    ].map(match => match[1] ?? match[2])
    return {path, names: declared.filter(name => !name.includes(':'))}
}

async function rustCommandFailures() {
    const failures = []
    for (const file of await readdir(new URL('src-tauri/src', `file://${root}`))) {
        if (!file.endsWith('.rs')) continue
        const text = await read(`src-tauri/src/${file}`)
        const declarations = text.matchAll(
            /#\[tauri::command(?:\(async\))?\]\s*(?:pub )?(?:async )?fn (\w+)[\s\S]{0,600}?\{/gu
        )
        for (const declaration of declarations) {
            const returns = /->\s*Result<[\s\S]*?,\s*([A-Za-z_:]+)\s*>/u.exec(declaration[0])
            failures.push({
                path: `src-tauri/src/${file}`,
                command: declaration[1],
                error: returns?.[1] ?? 'nothing'
            })
        }
    }
    if (failures.length === 0) throw new Error('src-tauri/src declares no Tauri commands')
    return failures
}

async function permissionAllowList() {
    const path = 'src-tauri/permissions/main-window-commands.toml'
    return {path, names: quoted(slice(await read(path), path, 'commands.allow = [', ']'))}
}

async function addonDispatch() {
    const path = 'src-tauri/addon/plugin.gd'
    const body = slice(await read(path), path, 'func _dispatch_command(', '\nfunc ')
    const cases = [...body.matchAll(/^ {8}"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)":$/gmu)]
    return {path, names: cases.map(match => match[1])}
}

async function addonRuntimeDispatch() {
    const path = 'src-tauri/addon/plugin.gd'
    const body = slice(await read(path), path, 'func _handle_runtime_request(', '\nfunc ')
    const cases = [...body.matchAll(/^ {8}"(runtime\.[a-z][a-z0-9_]*)":$/gmu)]
    return {path: `${path} _handle_runtime_request`, names: cases.map(match => match[1])}
}

async function catalogueRuntimeCommands() {
    const path = 'protocol/schemas/v2/commands.json'
    const {runtimeCommands} = JSON.parse(await read(path))
    if (!Array.isArray(runtimeCommands)) throw new Error(`${path} no longer lists runtime commands`)
    return {path: `${path} runtimeCommands`, names: runtimeCommands}
}

async function addonMutating() {
    const path = 'src-tauri/addon/plugin.gd'
    return {
        path: `${path} MUTATING_COMMANDS`,
        names: quoted(
            slice(await read(path), path, 'const MUTATING_COMMANDS: Array[String] = [', ']')
        )
    }
}

async function schemaMutating() {
    const path = 'protocol/schemas/v2/request.schema.json'
    const schema = JSON.parse(await read(path))
    const names = schema.allOf?.[0]?.if?.properties?.command?.enum
    if (!Array.isArray(names)) throw new Error(`${path} no longer enumerates the mutating commands`)
    return {path, names}
}

async function schemaCommandPattern() {
    const path = 'protocol/schemas/v2/request.schema.json'
    const pattern = JSON.parse(await read(path)).properties?.command?.pattern
    if (typeof pattern !== 'string') throw new Error(`${path} no longer constrains command names`)
    return {path, pattern: new RegExp(pattern, 'u')}
}

async function rustMutating() {
    const path = 'src-tauri/src/protocol_v2.rs'
    const text = await read(path)
    const declared = text.match(/pub const MUTATING_COMMANDS: \[&str; (\d+)\] = \[/u)
    if (!declared) throw new Error(`${path} no longer declares MUTATING_COMMANDS`)
    const names = quoted(slice(text, path, declared[0], '];'))
    if (names.length !== Number(declared[1]))
        throw new Error(
            `${path} declares MUTATING_COMMANDS as ${declared[1]} entries but lists ${String(names.length)}`
        )
    return {path: `${path} MUTATING_COMMANDS`, names}
}

async function typescriptCommandShapes() {
    const path = 'src/models/godot-commands.ts'
    const body = slice(await read(path), path, 'interface KnownGodotCommands {', '\n}')
    return {
        path: `${path} KnownGodotCommands`,
        names: [...body.matchAll(/^ {4}'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)':/gmu)].map(m => m[1])
    }
}

async function catalogueCommands() {
    const path = 'protocol/schemas/v2/commands.json'
    const {commands} = JSON.parse(await read(path))
    if (!Array.isArray(commands)) throw new Error(`${path} no longer lists commands`)
    return {path, names: commands.map(entry => entry.command)}
}

async function readmeMutating() {
    const path = 'protocol/README.md'
    const sentence = slice(await read(path), path, 'The mutating\ncommands are ', '.\n')
    return {
        path: `${path} mutating command list`,
        names: [...sentence.matchAll(/`([^`]+)`/gu)].map(m => m[1])
    }
}

async function sqlBriefStatuses() {
    const path = 'src-tauri/src/storage/mod.rs'
    const table = slice(await read(path), path, 'CREATE TABLE brief_runs (', ') STRICT')
    return {
        path: `${path} brief_runs CHECK`,
        names: quoted(slice(table, path, 'CHECK (status IN (', '))'))
    }
}

async function rustBriefFields() {
    const path = 'src-tauri/src/storage/tasks.rs'
    const body = slice(await read(path), path, 'pub fn record_brief_phase(', '_ => return,')
    return {
        path: `${path} record_brief_phase`,
        names: [...body.matchAll(/^ {12}"(\w+)" => "\w+",$/gmu)].map(match => match[1])
    }
}

async function rustBriefStatuses() {
    const path = 'src-tauri/src/ai_turn.rs'
    const text = await read(path)
    const words = quoted(slice(text, path, "fn word(self) -> &'static str {", '\n    }'))
    const [finished] = quoted(
        slice(text, path, 'let status = if matches!(ending, Ending::Finished) {', '} else {')
    )
    if (!finished) throw new Error(`${path} no longer says what a finished brief is stored as`)
    return {
        path: `${path} run_brief`,
        names: ['running', ...new Set(words.map(word => (word === 'finished' ? finished : word)))]
    }
}

async function typescriptBriefList(name) {
    const path = 'src/models/brief.ts'
    return {
        path: `${path} ${name}`,
        names: quoted(slice(await read(path), path, `export const ${name} = [`, ']'))
    }
}

async function typescriptBriefPhaseFields() {
    const path = 'src/models/brief.ts'
    const body = slice(
        await read(path),
        path,
        'export const BRIEF_PHASE_FIELDS: Readonly<Record<BriefPhase, string>> = {',
        '\n}'
    )
    return {
        path: `${path} BRIEF_PHASE_FIELDS`,
        names: [...body.matchAll(/^ {4}(\w+): '(\w+)'/gmu)].map(m => `${m[1]}→${m[2]}`)
    }
}

async function nodeResearchSections() {
    const path = 'scripts/brief/phases.mjs'
    return {
        path: `${path} RESEARCH_WORKERS`,
        names: [
            ...slice(await read(path), path, 'export const RESEARCH_WORKERS = [', '\n]').matchAll(
                /section: '(\w+)'/gu
            )
        ].map(match => match[1])
    }
}

const briefWord = (name, names) => ({path: `scripts/brief/catalogue.mjs ${name}`, names})

async function rustList(file, name) {
    const path = `src-tauri/src/${file}`
    const open = `const ${name}: &[&str] =`
    return {path: `${path} ${name}`, names: quoted(slice(await read(path), path, open, '];'))}
}

async function typescriptList(file, name) {
    const path = `src/models/${file}`
    const open = `export const ${name}: readonly ThinkingLevel[] = [`
    return {path: `${path} ${name}`, names: quoted(slice(await read(path), path, open, ']'))}
}

async function nodeKnownEfforts() {
    const path = 'scripts/thinking-level.mjs'
    return {
        path: `${path} KNOWN_EFFORTS`,
        names: quoted(slice(await read(path), path, 'const KNOWN_EFFORTS = [', ']'))
    }
}

const withoutOff = surface => ({
    path: surface.path,
    names: surface.names.filter(level => level !== 'off' && level !== 'on')
})

const aiEvent = (name, names) => ({path: `scripts/ai-events.mjs ${name}`, names})

async function typescriptStreamEvents() {
    const path = 'src/models/chat.ts'
    const body = slice(
        await read(path),
        path,
        'export type AiStreamEvent =',
        '\nexport type AiStreamPayload'
    )
    return {
        path: `${path} AiStreamEvent`,
        names: [...body.matchAll(/type: '([a-z-]+)'/gu)].map(match => match[1])
    }
}

async function typescriptStreamEventGuard() {
    const path = 'src/models/chat-timeline.ts'
    const body = slice(await read(path), path, 'export function isAiStreamEvent(', '\n}')
    return {
        path: `${path} isAiStreamEvent`,
        names: [...body.matchAll(/^ {8}case '([a-z-]+)':$/gmu)].map(match => match[1])
    }
}

async function everyEmitSiteBuildsItsEvent() {
    const declared = new Set([
        ...aiEvents.TURN_EVENTS,
        ...aiEvents.BRIEF_EVENTS,
        ...aiEvents.JUDGE_EVENTS,
        ...aiEvents.COMPLETION_EVENTS
    ])
    for (const path of await workerScripts()) {
        const text = await read(path)
        for (const [, name] of text.matchAll(/\bemit\(\s*\{\s*type:\s*'([a-z-]+)'/gu)) {
            fail(
                declared.has(name) ?
                    `${path} writes ${name} out as an object literal; build it with its `
                        + 'constructor in scripts/ai-events.mjs'
                :   `${path} emits ${name}, which scripts/ai-events.mjs never declared`
            )
        }
    }
}

async function workerScripts() {
    const found = []
    const walk = async directory => {
        for (const entry of await readdir(new URL(directory, `file://${root}`), {
            withFileTypes: true
        })) {
            if (entry.isDirectory()) await walk(`${directory}/${entry.name}`)
            else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs'))
                found.push(`${directory}/${entry.name}`)
        }
    }
    await walk('scripts')
    if (found.length === 0) throw new Error('scripts holds no worker sources')
    return found
}

async function typescriptJudgeEvents() {
    const path = 'src/models/memory.ts'
    return {
        path: `${path} JUDGE_EVENTS`,
        names: quoted(
            slice(
                await read(path),
                path,
                "const JUDGE_EVENTS: readonly MemoryJudgeEvent['type'][] = [",
                ']'
            )
        )
    }
}

async function rustCompletionEvents() {
    const path = 'src-tauri/src/ai_turn.rs'
    const text = await read(path)
    const declared = text.match(/const AI_COMPLETION_EVENTS: \[&str; (\d+)\] = \[/u)
    if (!declared) throw new Error(`${path} no longer declares AI_COMPLETION_EVENTS`)
    const names = quoted(slice(text, path, declared[0], '];'))
    if (names.length !== Number(declared[1]))
        throw new Error(
            `${path} declares AI_COMPLETION_EVENTS as ${declared[1]} entries but lists ${String(names.length)}`
        )
    return {path: `${path} AI_COMPLETION_EVENTS`, names}
}

async function cancelLineAgreement() {
    const rustPath = 'src-tauri/src/ai_turn.rs'
    const line = /const AI_CANCEL_LINE: &str = r#"([^"#]*(?:"[^#][^"#]*)*)"#;/u.exec(
        await read(rustPath)
    )
    if (!line) throw new Error(`${rustPath} no longer declares AI_CANCEL_LINE`)
    const hostPath = 'scripts/ai-host.mjs'
    const word = /export const CANCEL_TYPE = '([a-z-]+)'/u.exec(await read(hostPath))
    if (!word) throw new Error(`${hostPath} no longer declares CANCEL_TYPE`)
    let sent
    try {
        sent = JSON.parse(line[1])
    } catch (error) {
        throw new Error(`${rustPath} AI_CANCEL_LINE is not JSON: ${String(error)}`)
    }
    if (sent?.type !== word[1])
        fail(
            `${rustPath} stops a worker with ${JSON.stringify(sent)} but ${hostPath} `
                + `recognises ${JSON.stringify(word[1])}`
        )
}

async function steerLineAgreement() {
    const rustPath = 'src-tauri/src/ai_turn.rs'
    const kind = /const AI_STEER_TYPE: &str = "([a-z-]+)";/u.exec(await read(rustPath))
    if (!kind) throw new Error(`${rustPath} no longer declares AI_STEER_TYPE`)
    const hostPath = 'scripts/ai-host.mjs'
    const word = /export const STEER_TYPE = '([a-z-]+)'/u.exec(await read(hostPath))
    if (!word) throw new Error(`${hostPath} no longer declares STEER_TYPE`)
    if (kind[1] !== word[1])
        fail(
            `${rustPath} steers a worker with ${JSON.stringify(kind[1])} but ${hostPath} `
                + `recognises ${JSON.stringify(word[1])}`
        )
}

async function noneOfItRanAgreement() {
    const rustPath = 'src-tauri/src/ai_tools.rs'
    const jsPath = 'scripts/tool-call-repair.mjs'
    const rust = /None of the \{listed\} operations[\s\S]*?corrected\.",/u.exec(
        await read(rustPath)
    )
    if (!rust) throw new Error(`${rustPath} no longer builds the none-of-it-ran sentence`)
    const js = /None of the \$\{String\(listed\)\} operations[\s\S]*?corrected\.`/u.exec(
        await read(jsPath)
    )
    if (!js) throw new Error(`${jsPath} no longer builds the none-of-it-ran sentence`)
    const said = (text, count) =>
        text
            .replace(count, 'N')
            .replace(/\\\n\s*/gu, '')
            .replace(/`\s*\+\s*`/gu, '')
            .replace(/["`],?$/u, '')
            .replace(/\s+/gu, ' ')
            .trim()
    const fromRust = said(rust[0], /\{listed\}/gu)
    const fromJs = said(js[0], /\$\{String\(listed\)\}/gu)
    if (fromRust !== fromJs)
        fail(
            `a refused list is answered "${fromRust}" by ${rustPath} `
                + `but "${fromJs}" by ${jsPath}`
        )
}

async function declaredDrivers() {
    const path = 'protocol/drivers.json'
    const {drivers} = JSON.parse(await read(path))
    return {path, names: drivers.map(driver => driver.id)}
}

async function rustDriverIds() {
    const path = 'src-tauri/src/settings/mod.rs'
    const body = slice(await read(path), path, 'fn driver_id(', '\n}')
    const names = [...body.matchAll(/=>\s*"([a-z0-9-]+)"/gu)].map(one => one[1])
    return {path: `${path} driver_id`, names}
}

async function typescriptDriverIds() {
    const path = 'src/models/settings.ts'
    const body = slice(await read(path), path, 'AI_CONNECTION_TYPES: readonly', '\n]')
    const names = [...body.matchAll(/'([a-z0-9-]+)'/gu)].map(one => one[1])
    return {path: `${path} AI_CONNECTION_TYPES`, names}
}

async function typescriptDriverLabels() {
    const path = 'src/models/settings.ts'
    const body = slice(await read(path), path, 'AI_CONNECTION_LABELS: Readonly', '\n}')
    const names = [...body.matchAll(/^\s*'?([a-z0-9-]+)'?:/gmu)].map(one => one[1])
    return {path: `${path} AI_CONNECTION_LABELS`, names}
}

async function nodeDriverIds() {
    const path = 'scripts/ai-provider.mjs'
    const body = slice(await read(path), path, 'export const DRIVERS = [', ']')
    return {path: `${path} DRIVERS`, names: [...body.matchAll(/'([a-z0-9-]+)'/gu)].map(o => o[1])}
}

const failures = []

function fail(message) {
    failures.push(message)
}

function checkOrder(what, surfaces) {
    const [first, ...rest] = surfaces
    for (const surface of rest) {
        if (surface.names.join(' ') === first.names.join(' ')) continue
        fail(
            `${what} is ordered ${first.names.join(', ')} in ${first.path} `
                + `but ${surface.names.join(', ')} in ${surface.path}`
        )
    }
}

function checkForDuplicates(surface) {
    const seen = new Set()
    for (const name of surface.names) {
        if (seen.has(name)) fail(`${surface.path} lists ${name} twice`)
        seen.add(name)
    }
    if (surface.names.length === 0) fail(`${surface.path} parsed to an empty command list`)
}

function checkAgreement(what, surfaces) {
    const union = new Set(surfaces.flatMap(surface => surface.names))
    for (const name of [...union].sort()) {
        const missing = surfaces.filter(surface => !surface.names.includes(name))
        if (missing.length === 0) continue
        const present = surfaces.filter(surface => surface.names.includes(name))
        fail(
            `${what} ${name} is declared in ${present.map(s => s.path).join(', ')} `
                + `but missing from ${missing.map(s => s.path).join(', ')}`
        )
    }
}

const desktop = [await tauriHandlers(), await desktopTypes(), await permissionAllowList()]
const dispatch = await addonDispatch()
const mutating = [
    await schemaMutating(),
    await addonMutating(),
    await rustMutating(),
    await readmeMutating()
]

for (const surface of [...desktop, dispatch, ...mutating]) checkForDuplicates(surface)

checkAgreement('desktop command', desktop)
checkAgreement('mutating Godot command', mutating)

for (const name of mutating[0].names) {
    if (!dispatch.names.includes(name))
        fail(`mutating Godot command ${name} has no handler in ${dispatch.path}`)
}

const {path: schemaPath, pattern} = await schemaCommandPattern()
for (const name of dispatch.names) {
    if (!pattern.test(name))
        fail(`${dispatch.path} answers ${name}, which ${schemaPath} would reject on the wire`)
}

const catalogued = await catalogueCommands()
checkForDuplicates(catalogued)
checkAgreement('Godot command', [catalogued, dispatch])

const runtime = [await catalogueRuntimeCommands(), await addonRuntimeDispatch()]
for (const surface of runtime) checkForDuplicates(surface)
checkAgreement('runtime Godot command', runtime)

for (const {path, command, error} of await rustCommandFailures()) {
    if (error === 'String')
        fail(`${path} has ${command} reject with a bare String rather than a coded failure`)
}

const shapes = await typescriptCommandShapes()
checkForDuplicates(shapes)
const everyCommand = new Set([...catalogued.names, ...runtime[0].names])
for (const name of shapes.names) {
    if (!everyCommand.has(name)) fail(`${shapes.path} declares ${name}, which no surface offers`)
}

const {
    BRIEF_PHASES: phases,
    BRIEF_STATUSES,
    RESEARCH_SECTIONS,
    WORKER_KINDS,
    BRIEF_EVENTS
} = briefCatalogue
checkAgreement('brief phase', [
    briefWord(
        'BRIEF_PHASES',
        phases.map(phase => phase.name)
    ),
    await typescriptBriefList('BRIEF_PHASES')
])
const pairs = phases.map(phase => `${phase.name}→${phase.field}`)
checkAgreement('brief phase output', [
    briefWord(
        'BRIEF_PHASES fields',
        phases.map(phase => phase.field)
    ),
    await rustBriefFields()
])
checkAgreement('brief phase field', [
    briefWord('BRIEF_PHASES pairs', pairs),
    await typescriptBriefPhaseFields()
])
checkAgreement('brief status', [
    briefWord('BRIEF_STATUSES', BRIEF_STATUSES),
    await sqlBriefStatuses(),
    await rustBriefStatuses(),
    await typescriptBriefList('BRIEF_STATUSES')
])
checkAgreement('brief research section', [
    briefWord('RESEARCH_SECTIONS', RESEARCH_SECTIONS),
    await nodeResearchSections(),
    await typescriptBriefList('RESEARCH_SECTIONS')
])
checkAgreement('brief worker kind', [
    briefWord('WORKER_KINDS', WORKER_KINDS),
    await typescriptBriefList('WORKER_KINDS')
])
checkAgreement('brief event', [
    briefWord('BRIEF_EVENTS', BRIEF_EVENTS),
    await typescriptBriefList('BRIEF_EVENT_TYPES')
])

checkAgreement('AI stream event', [
    aiEvent('TURN_EVENTS', aiEvents.TURN_EVENTS),
    await typescriptStreamEvents(),
    await typescriptStreamEventGuard()
])
checkAgreement('AI brief event', [
    aiEvent('BRIEF_EVENTS', aiEvents.BRIEF_EVENTS),
    briefWord('BRIEF_EVENTS', BRIEF_EVENTS)
])
checkAgreement('AI judge event', [
    aiEvent('JUDGE_EVENTS', aiEvents.JUDGE_EVENTS),
    await typescriptJudgeEvents()
])
checkAgreement('AI completion event', [
    aiEvent('COMPLETION_EVENTS', aiEvents.COMPLETION_EVENTS),
    await rustCompletionEvents()
])
await everyEmitSiteBuildsItsEvent()
await cancelLineAgreement()
await steerLineAgreement()

const efforts = [
    await rustList('settings/mod.rs', 'NAMED_EFFORTS'),
    await rustList('model_server.rs', 'KNOWN_EFFORTS'),
    await nodeKnownEfforts(),
    withoutOff(await rustList('settings/mod.rs', 'EFFORT_LEVELS')),
    withoutOff(await typescriptList('settings.ts', 'EFFORT_LEVELS')),
    withoutOff(await rustList('settings/mod.rs', 'EVERY_LEVEL'))
]
for (const surface of efforts) checkForDuplicates(surface)
checkAgreement('reasoning effort', efforts)
checkOrder('the reasoning vocabulary', efforts)

async function tuningDefaults() {
    const rust = await read('src-tauri/src/settings/mod.rs')
    const renderer = await read('src/models/settings.ts')
    const {DEFAULT_SEARCH_PROVIDER, TUNING_DEFAULTS} = await import('./tuning-defaults.mjs')

    const rustDefault = name => {
        const found = new RegExp(`fn ${name}\\(\\) -> [^{]+\\{\\s*"?([\\w_.]+)"?`, 'u').exec(rust)
        if (!found) fail(`settings.rs declares no ${name}`)
        return found[1].replaceAll('_', '')
    }

    const rustTuning = {
        maxRetries: Number(rustDefault('default_max_retries')),
        timeoutMs: Number(rustDefault('default_timeout_ms')),
        compactionPercent: Number(rustDefault('default_compaction_percent'))
    }

    const literal = /const tuning = \{([^}]*)\}/u.exec(renderer)
    if (!literal) fail('settings.ts declares no `tuning` literal in normalizeSettings')
    const rendererTuning = Object.fromEntries(
        literal[1]
            .split(',')
            .map(pair => pair.split(':').map(half => half.trim()))
            .filter(([name]) => name)
            .map(([name, value]) => [name, Number(value.replaceAll('_', ''))])
    )

    for (const [name, value] of Object.entries(rustTuning)) {
        for (const [where, held] of [
            ['scripts/tuning-defaults.mjs', TUNING_DEFAULTS[name]],
            ['src/models/settings.ts', rendererTuning[name]]
        ]) {
            if (held !== value) {
                fail(`${name} is ${String(value)} in settings.rs and ${String(held)} in ${where}`)
            }
        }
    }

    const rustProvider = rustDefault('default_search_provider')
    if (DEFAULT_SEARCH_PROVIDER !== rustProvider) {
        fail(
            `the default search provider is ${rustProvider} in settings.rs and `
                + `${DEFAULT_SEARCH_PROVIDER} in scripts/tuning-defaults.mjs`
        )
    }
}

await tuningDefaults()

checkOrder('the reasoning menu', [
    await rustList('settings/mod.rs', 'EFFORT_LEVELS'),
    await typescriptList('settings.ts', 'EFFORT_LEVELS')
])

async function everyMergedNameDeclaresItsShape() {
    const {operations} = JSON.parse(await read('protocol/schemas/v2/params.json'))
    const byName = new Map()
    for (const row of operations)
        for (const param of row.params ?? []) {
            const key = `${row.tool}.${param.name}`
            if (!byName.has(key)) byName.set(key, [])
            byName.get(key).push({op: row.op, param})
        }
    for (const [key, uses] of [...byName].sort()) {
        if (uses.length < 2) continue
        const shaped = uses.filter(use => use.param.entry?.length > 0)
        if (shaped.length === 0) continue
        const bare = uses.filter(
            use =>
                !use.param.entry?.length
                && (use.param.kind === 'list' || use.param.kind === 'object')
        )
        for (const one of bare)
            fail(
                `${key} declares an entry shape in ${shaped.map(u => u.op).join(', ')} but not in `
                    + `${one.op}, so the schema widens to a bare ${one.param.kind} that swallows the `
                    + 'strict branch and check_inside skips it. Give it an entry.'
            )
    }
}
await everyMergedNameDeclaresItsShape()

await noneOfItRanAgreement()

const drivers = [
    await declaredDrivers(),
    await rustDriverIds(),
    await typescriptDriverIds(),
    await typescriptDriverLabels(),
    await nodeDriverIds()
]
for (const surface of drivers) checkForDuplicates(surface)
checkAgreement('the AI driver', drivers)
checkOrder(
    'the AI drivers',
    drivers.filter(surface => !surface.path.includes('LABELS'))
)

if (failures.length > 0) throw new Error(`command surfaces disagree:\n${failures.join('\n')}`)

await checkSurfacesAreGenerated()
