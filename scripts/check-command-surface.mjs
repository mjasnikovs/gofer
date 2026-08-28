// A command name is written out by hand on five surfaces, and nothing until now made them agree.
// The live sweeps found four node operations the protocol offered that the addon never
// implemented: every surface was internally consistent and the app was still lying about what it
// could do. This checker parses each surface by its own anchors, with exact string matching only,
// and reports every name that appears on one surface and not another.

import {readdir, readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {checkSurfacesAreGenerated} from './generate-command-surface.mjs'
import * as aiEvents from './ai-events.mjs'
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
    const path = 'src-tauri/src/storage/mod.rs'
    const table = slice(await read(path), path, 'CREATE TABLE brief_runs (', ') STRICT')
    return {
        path: `${path} brief_runs CHECK`,
        names: quoted(slice(table, path, 'CHECK (status IN (', '))'))
    }
}

/** The columns `record_brief_phase` will write, which is the closed set a phase may name. */
async function rustBriefFields() {
    // The Ledger is a directory: the schema is the database's, the writer is the task view's.
    const path = 'src-tauri/src/storage/tasks.rs'
    const body = slice(await read(path), path, 'pub fn record_brief_phase(', '_ => return,')
    return {
        path: `${path} record_brief_phase`,
        names: [...body.matchAll(/^ {12}"(\w+)" => "\w+",$/gmu)].map(match => match[1])
    }
}

/**
 * The statuses the backend closes a run with.
 *
 * Read from two anchors rather than one, because that is what the backend now is. The four endings
 * a brief, a judgement and a sweep each decided for themselves are one `Ending` type, so the words
 * are spelled once — and the brief's own substitution, which stores a finished plan as `done`, is
 * all that is left where the match used to be.
 */
async function rustBriefStatuses() {
    const path = 'src-tauri/src/ai_turn.rs'
    const text = await read(path)
    const words = quoted(slice(text, path, "fn word(self) -> &'static str {", '\n    }'))
    const [finished] = quoted(
        slice(text, path, 'let status = if matches!(ending, Ending::Finished) {', '} else {')
    )
    if (!finished) throw new Error(`${path} no longer says what a finished brief is stored as`)
    // `running` is never written here: a row starts running and this only ends it.
    return {
        path: `${path} run_brief`,
        names: ['running', ...new Set(words.map(word => (word === 'finished' ? finished : word)))]
    }
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

// --- Surface 7: the reasoning vocabulary, written out five times.

/*
 * `settings.rs` says it in a doc comment — "The same list, in the same order, is `KNOWN_EFFORTS` in
 * `model_server.rs` and in `thinking-level.mjs`" — and nothing checked it. Five copies: the two
 * that name the efforts, the two menus that are those efforts with `off` in front, and the
 * validation set, which is the menu plus `on`. What a copy getting this wrong costs is not
 * cosmetic: an effort a template does not know is an HTTP 500 on every request of the turn, and a
 * level clamped to nothing goes out as thinking disabled.
 *
 * Order matters here as much as membership, because these are menus, so they are checked for both.
 */

/** One `const NAME: &[&str] = ...;` slice, read by its own anchor. */
async function rustList(file, name) {
    const path = `src-tauri/src/${file}`
    const open = `const ${name}: &[&str] =`
    return {path: `${path} ${name}`, names: quoted(slice(await read(path), path, open, '];'))}
}

/** One `export const NAME: readonly ThinkingLevel[] = [ ... ]` list from the renderer. */
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

/** A menu with its leading `off` taken off, which is what the two effort lists hold. */
const withoutOff = surface => ({
    path: surface.path,
    names: surface.names.filter(level => level !== 'off' && level !== 'on')
})

// --- Surface 8 was the sub-agent's ceilings, and is gone.
//
// The bounds and the ranges were two transcriptions of one fact, and this file could only report
// that one of them had slipped. They are emitted from `protocol/subagent-bounds.json` now, along
// with the six defaults nothing here ever compared — so there is nothing left to reconcile. See the
// header: a surface that can be emitted is not a surface this file should be reading.

// --- Surface 9: the vocabulary the AI worker’s stream is written in.

/*
 * About forty `emit({type: ...})` sites across five files, and until now no list of them anywhere.
 * Rust routed them by string prefix and the renderer re-declared the whole set twice — as a union
 * and as a hand-written guard — while `src/services/turn.ts` drops whatever the guard rejects in
 * silence, by design. A name on one surface and not another is therefore an event that is emitted
 * and never drawn, with nothing anywhere saying so.
 *
 * `scripts/ai-events.mjs` is the owner and is imported rather than parsed, the same split the brief
 * catalogue makes. The renderer's two surfaces are hand-written next to what reads them, so they
 * are read by their own anchors.
 *
 * The names are checked, and so are the sites that write them. An object literal on the wire is a
 * shape nothing declared: it can carry a field the constructor does not, miss one the constructor
 * fills in, and stay on every list either way, because a list only ever knew the name.
 */

/** One list from the event vocabulary, named the way a failure should name it. */
const aiEvent = (name, names) => ({path: `scripts/ai-events.mjs ${name}`, names})

/** The arms of the union the renderer folds a stream event through. */
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

/**
 * The cases the guard admits.
 *
 * Checked apart from the union because the two fail differently and only one of them fails loudly.
 * A union arm with no case is an event the guard rejects and the turn drops without a word; a case
 * with no arm is dead code the compiler cannot see, because the guard reads `value['type']` off an
 * `unknown`.
 */
async function typescriptStreamEventGuard() {
    const path = 'src/models/chat-timeline.ts'
    const body = slice(await read(path), path, 'export function isAiStreamEvent(', '\n}')
    return {
        path: `${path} isAiStreamEvent`,
        names: [...body.matchAll(/^ {8}case '([a-z-]+)':$/gmu)].map(match => match[1])
    }
}

/**
 * Every event on the worker's stream is built by its constructor rather than written out.
 *
 * The names above are the vocabulary; this is the grammar. An `emit` handed an object literal with
 * the event's name typed into it is a shape assembled at the call site, and the defect that hides
 * is the one written down in
 * `scripts/ai-provider.mjs`: a completion that had lost a field was rejected by the renderer's
 * guard and dropped in silence, so the stopped turn it belonged to was never recorded as ended. A
 * constructor cannot lose a field, because the field list is the constructor.
 *
 * Only an `emit(` handed an object literal whose first key is `type` — every one of the sites this
 * replaced looked exactly like that. `scripts/rag-progress.mjs` emits a different vocabulary
 * entirely, keyed on `status`, and is left alone by the shape of the match rather than by an
 * exceptions list. Tests are skipped: a test that writes a wire shape out by hand is asserting
 * about that shape, which is the point of it.
 */
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

/** Every script the AI worker is built out of, tests aside. Walked, so a new file is covered. */
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

/** The events one memory judgement reports itself on, as the panel reading them declares it. */
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

/** The completions the worker loop ends a job on. */
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

/**
 * The one line Rust writes that is not an answer, and the word the worker recognises it by.
 *
 * Two spellings of one thing, and the failure is silent in the direction that matters: a worker
 * that does not recognise the line runs on until it is killed, which is exactly what stopping a
 * turn used to be, so nothing about the symptom would point here.
 */
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

/**
 * The sentence a refused list is answered with, which two engines write in two languages.
 *
 * `said_that_none_of_it_ran` in `src-tauri/src/ai_tools.rs` and `sayingNoneOfItRan` in
 * `scripts/tool-call-repair.mjs` append the same words to a refusal, deliberately: a model meets
 * one of them when the router refuses a batch and the other when `prepareArguments` throws before
 * the router is reached, and it cannot tell which layer answered it. The JS one says so in its own
 * comment — "the same sentence the router appends, in the same words" — and nothing held it to
 * that, so the two could drift into two answers to one question.
 *
 * Compared on the words alone: the placeholders differ by language and the line breaks are the
 * formatter's, so both are reduced to the count marked `N` and single spaces.
 */
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
    // Rust joins a wrapped string literal with a trailing backslash; JS joins two literals with a
    // `+`. Both leave the words themselves untouched, so both reduce to the same thing.
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

/**
 * --- Surface 10: the drivers a build knows, spelt in three languages.
 *
 * All three are now emitted from `protocol/drivers.json`, so `checkSurfacesAreGenerated` is what
 * really holds them together and a disagreement here means a hand-edited region. Kept anyway,
 * because it names *which* file drifted and in what order, and a sha256 mismatch does not.
 *
 * One closed set of four, written down as a Rust enum with `driver_id` for the wire word, as a
 * TypeScript union with `AI_CONNECTION_TYPES` and `AI_CONNECTION_LABELS` beside it, and as
 * `DRIVERS` in the worker. Nothing held the three to each other, and the cost of that is not a
 * compile error: a driver added to two of them reaches the worker as a word `PROVIDER_IDS` has no
 * key for, and until `providerIdOf` was written it resolved to `local` — a hosted model's turn put
 * to the machine it is running on.
 *
 * The wire word is what is compared, never the label: a settings file holding `OpenRouter` matches
 * no driver any of the three knows.
 */
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
    // Closed on a newline: the first `]` after the anchor is the one in `AiConnectionType[]`.
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

// --- The comparisons.

const failures = []

function fail(message) {
    failures.push(message)
}

/** Fails when two surfaces hold the same names in a different order. A menu's order is its own. */
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

// The stream vocabulary, reconciled against the two surfaces the renderer re-declares it on and
// against the one Rust routes by.
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

// The reasoning vocabulary. Membership first, so a missing word is reported as a missing word
// rather than as an ordering difference, and then the order, because these are menus.
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

/**
 * What a turn is tuned to when nothing named it, across the three places that state it.
 *
 * Rust owns these as `#[serde(default = "…")]`, the worker carries them because a request that lost
 * a field arrives as `undefined` rather than as an error, and the renderer fills them into a stored
 * file written before the section existed. Three copies, each needed where it is.
 *
 * A commit that raised one and not the others is the failure — it has happened before, to
 * `maxTurns`, which was raised in two of its three places. Reading the other two as source text is
 * ugly and is still the only thing that fails when they disagree.
 */
async function tuningDefaults() {
    const rust = await read('src-tauri/src/settings/mod.rs')
    const renderer = await read('src/models/settings.ts')
    const {DEFAULT_SEARCH_PROVIDER, TUNING_DEFAULTS} = await import('./tuning-defaults.mjs')

    /** One `fn default_name() -> T { value }` body, as the number or string it returns. */
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

// The two menus a settings file may name a level from, which are the efforts with `off` in front.
// Checked whole rather than through `withoutOff`, so a copy that lost its `off` is caught too.
checkOrder('the reasoning menu', [
    await rustList('settings/mod.rs', 'EFFORT_LEVELS'),
    await typescriptList('settings.ts', 'EFFORT_LEVELS')
])

/**
 * A parameter name that means different shapes in different operations of one domain widens to
 * accept either, deliberately — `jsonSchemaOfEntry` says why, and the refusal it moves to
 * `tool_params::check` is the one that can explain itself.
 *
 * What must not happen is widening against *nothing*. A list of objects that declares no `entry` is
 * checked by neither layer: ajv gets a bare `{type: "array"}` branch that swallows the sibling's
 * strict one, and `check_inside` returns early on an empty entry. Serde is then the first thing to
 * look, and `missing field oldText` is exactly the refusal `check_inside` was written to replace.
 *
 * Measured: `godot_script apply_rename` was that case. Its entries are `PlannedFile`, and
 * `{"nope": 1}` was accepted by the schema and by `check` alike.
 */
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
// The order is the order the pickers offer them in, which `protocol/drivers.json` declares and the
// emitted lists carry. A label map's key order is not a menu, so it is left out of this one.
checkOrder(
    'the AI drivers',
    drivers.filter(surface => !surface.path.includes('LABELS'))
)

if (failures.length > 0) throw new Error(`command surfaces disagree:\n${failures.join('\n')}`)

// The regions the generator owns must still be what it would emit. This is last because a drifted
// region is worth less to report than a command that does not exist.
await checkSurfacesAreGenerated()
