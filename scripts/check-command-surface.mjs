// A command name is written out by hand on five surfaces, and nothing until now made them agree.
// The live sweeps found four node operations the protocol offered that the addon never
// implemented: every surface was internally consistent and the app was still lying about what it
// could do. This checker parses each surface by its own anchors, with exact string matching only,
// and reports every name that appears on one surface and not another.

import {readdir, readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {checkSurfacesAreGenerated} from './generate-command-surface.mjs'
import * as briefCatalogue from './brief/catalogue.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Reads the text between `open` and the first `close` after it, or explains which anchor is gone. */
function slice(text, path, open, close) {
    const start = text.indexOf(open)
    if (start === -1) throw new Error(`${path} no longer contains ${JSON.stringify(open)}`)
    const rest = text.slice(start + open.length)
    const end = rest.indexOf(close)
    if (end === -1) throw new Error(`${path} never closes ${JSON.stringify(open)}`)
    return rest.slice(0, end)
}

/** Every double-quoted or single-quoted string in `text`, in source order. */
function quoted(text) {
    return [...text.matchAll(/["']([^"']+)["']/gu)].map(match => match[1])
}

async function read(path) {
    return await readFile(new URL(path, `file://${root}`), 'utf8')
}

// --- Surface 1: the Tauri commands the backend registers.

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

// --- Surface 2: the command names the renderer is allowed to type.

async function desktopTypes() {
    const path = 'src/services/desktop.ts'
    const map = slice(await read(path), path, 'type DesktopCommandMap = Readonly<{', '\n}>')
    const declared = [
        ...map.matchAll(/^ {4}(?:'([^']+)'|([a-z_][a-z0-9_]*)): CommandSpec</gmu)
    ].map(match => match[1] ?? match[2])
    // `plugin:dialog|open` and its kind belong to a Tauri plugin: the plugin registers them and
    // ships its own permission set, so they are not Gofer's to declare on the other surfaces.
    return {path, names: declared.filter(name => !name.includes(':'))}
}

/**
 * How each registered command rejects.
 *
 * Every failure that crosses the seam carries `code`, `message`, `retryable` and `details` — the
 * session, file, language-server, debug-adapter, approval, formatter and RPC errors each serialize
 * to that shape, and `CommandError` is the one for commands with no domain of their own. A command
 * rejecting with a bare `String` carries none of it: the renderer cannot tell an ordinary state
 * from a fault, so `toCommandError` invents `command_failed` and every failure is drawn as one the
 * user is expected to do something about.
 */
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
            // Sanity check on the parse itself: a command this regex cannot read would pass the
            // rule below by accident, which is the one way a checker is worse than nothing.
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

// --- Surface 3: the window's allow-list.

async function permissionAllowList() {
    const path = 'src-tauri/permissions/main-window-commands.toml'
    return {path, names: quoted(slice(await read(path), path, 'commands.allow = [', ']'))}
}

// --- Surface 4: the addon's dispatch table, and the mutations it gates.

async function addonDispatch() {
    const path = 'src-tauri/addon/plugin.gd'
    const body = slice(await read(path), path, 'func _dispatch_command(', '\nfunc ')
    const cases = [...body.matchAll(/^ {8}"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)":$/gmu)]
    return {path, names: cases.map(match => match[1])}
}

/**
 * The runtime commands the addon actually routes, read from the match that routes them.
 *
 * The addon says it itself: the routing list and this match are two lists of the same commands, and
 * a name in one and not the other leaves its caller waiting out the whole timeout for a response
 * that is never coming. The list is generated now; this is what holds the match to it.
 */
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

// --- Surface 5: the frozen schema, and the three copies of its mutating list.

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

/**
 * The commands the renderer has written a params or result type for.
 *
 * `GodotCommandMap` is a mapped type over the generated union, so its own keys cannot be wrong.
 * These can: a key here that no command has is looked up by nothing, means nothing, and silently
 * leaves the command it was meant for holding the generic shape. That is the one way this map can
 * lie, so it is the one thing checked.
 */
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

// --- Surface 6: the Brief's vocabulary, spelt in three languages.

/*
 * Four words have to mean the same thing in Node, Rust and TypeScript — which phases there are, the
 * field each one fills, the statuses a run ends in, and how one research worker ended — and nothing
 * bound them. The drift was real: a `cached` worker kind outlived the code that produced it, and the
 * phase table written to be checkable had no consumer at all.
 *
 * `scripts/brief/catalogue.mjs` is the owner and is imported rather than parsed. The other three are
 * hand-written next to what they describe, so they are read by their own anchors — the same split
 * ADR-0002 makes for the Godot commands.
 */

/** The SQL that decides which statuses a stored brief may hold. */
async function sqlBriefStatuses() {
    const path = 'src-tauri/src/storage.rs'
    const table = slice(await read(path), path, 'CREATE TABLE brief_runs (', ') STRICT')
    return {
        path: `${path} brief_runs CHECK`,
        names: quoted(slice(table, path, 'CHECK (status IN (', '))'))
    }
}

/** The columns `record_brief_phase` will write, which is the closed set a phase may name. */
async function rustBriefFields() {
    const path = 'src-tauri/src/storage.rs'
    const body = slice(await read(path), path, 'pub fn record_brief_phase(', '_ => return,')
    return {
        path: `${path} record_brief_phase`,
        names: [...body.matchAll(/^ {12}"(\w+)" => "\w+",$/gmu)].map(match => match[1])
    }
}

/** The statuses the backend closes a run with. */
async function rustBriefStatuses() {
    const path = 'src-tauri/src/ai_turn.rs'
    const body = slice(await read(path), path, 'let (status, reason) = match &outcome {', '};')
    // Read from the arm's answer alone. Prose in between holds apostrophes, and a quote-counting
    // parser reading those swallowed a whole arm — the one way a checker is worse than nothing.
    const arms = [...body.matchAll(/=> \("(\w+)",/gu)].map(match => match[1])
    // `running` is never written here: a row starts running and this only ends it.
    return {path: `${path} run_brief`, names: ['running', ...new Set(arms)]}
}

/** One list the renderer declares, read by its own anchor. */
async function typescriptBriefList(name) {
    const path = 'src/models/brief.ts'
    return {
        path: `${path} ${name}`,
        names: quoted(slice(await read(path), path, `export const ${name} = [`, ']'))
    }
}

/** Which column the renderer believes each phase fills, as `phase→field` pairs. */
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

/** The research sections the host loop assembles, in the order it assembles them. */
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

/** One list from the owner, named the way a failure should name it. */
const briefWord = (name, names) => ({path: `scripts/brief/catalogue.mjs ${name}`, names})

// --- The comparisons.

const failures = []

function fail(message) {
    failures.push(message)
}

function checkForDuplicates(surface) {
    const seen = new Set()
    for (const name of surface.names) {
        if (seen.has(name)) fail(`${surface.path} lists ${name} twice`)
        seen.add(name)
    }
    if (surface.names.length === 0) fail(`${surface.path} parsed to an empty command list`)
}

/** Fails for every name that is on one of these surfaces and missing from another. */
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

// A mutating command that no handler answers is the exact defect the sweeps found.
for (const name of mutating[0].names) {
    if (!dispatch.names.includes(name))
        fail(`mutating Godot command ${name} has no handler in ${dispatch.path}`)
}

const {path: schemaPath, pattern} = await schemaCommandPattern()
for (const name of dispatch.names) {
    if (!pattern.test(name))
        fail(`${dispatch.path} answers ${name}, which ${schemaPath} would reject on the wire`)
}

// Every command the addon answers must be in the catalogue the dispatch table is generated from,
// and nothing else may be: a handler reachable only because someone typed a case for it by hand is
// exactly the drift this pair of scripts exists to end.
const catalogued = await catalogueCommands()
checkForDuplicates(catalogued)
checkAgreement('Godot command', [catalogued, dispatch])

// The runtime commands answer nowhere near the dispatch table, so they are reconciled on their own
// terms: what the catalogue lists, and what the routing match will actually answer.
const runtime = [await catalogueRuntimeCommands(), await addonRuntimeDispatch()]
for (const surface of runtime) checkForDuplicates(surface)
checkAgreement('runtime Godot command', runtime)

// The shapes are a subset by design, so this is one-way: every name the renderer types a shape for
// has to be a command, but a command may go without one until somebody needs it.
// A command that rejects in prose is one the renderer can say nothing useful about.
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

// The Brief's four words, each reconciled against the one place that owns it.
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
// The pairing, not only the two lists: a phase filling the wrong column is drift the lists cannot
// see. `record_brief_phase` reads them apart, so it is checked against the pairs on both sides.
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

if (failures.length > 0) throw new Error(`command surfaces disagree:\n${failures.join('\n')}`)

// The regions the generator owns must still be what it would emit. This is last because a drifted
// region is worth less to report than a command that does not exist.
await checkSurfacesAreGenerated()
