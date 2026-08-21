/**
 * An interleaved A/B of one line of the agent's system prompt, against a local model.
 *
 * The one rule that makes the numbers mean anything: **score every arm inside one process,
 * alternating, and read the sign of the gap** — never either number on its own. Three repeats of
 * the same check in one process land within a point of each other; the identical check an hour
 * later, byte for byte the same prompt, has landed seventeen points away. Verdicts collected across
 * separate sittings have flipped sign twice.
 *
 * What it poses is the real thing. The tools are the real catalogue this repo ships plus pi's own
 * read, write, edit and bash with pi's own descriptions, and what is scored is what the application
 * would do with the call — `validateBashCommand` is the shell rule itself, not a guess at it.
 *
 * The catalogue and the prompt come out of the Rust crate, which is where they are built:
 *
 *   GOFER_DUMP_CATALOG=/tmp/catalog.json GOFER_DUMP_PROMPT=/tmp/prompt.txt \
 *     cargo test --manifest-path src-tauri/Cargo.toml --features godot-acceptance --lib \
 *     -- dump_catalog_and_prompt --test-threads=1
 *
 *   GOFER_BENCH_CATALOG=/tmp/catalog.json GOFER_BENCH_PROMPT=/tmp/prompt.txt \
 *     node scripts/bench-prompt-line.mjs 20
 *
 * `GOFER_BENCH_ENDPOINT` names the completions endpoint; the default is a llama.cpp on
 * 127.0.0.1:8080, which is where `godot_live_agent` points too.
 *
 * The arms and the scenarios below are the last question asked of it, left in place as a worked
 * example rather than as a fixture: the session sentence used to name the worktree's absolute path,
 * and every shell command that used it was refused. Replace them with the next question.
 */

import {readFile} from 'node:fs/promises'
import {
    NodeExecutionEnv,
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool
} from '@earendil-works/pi-agent-core/node'
import {createGodotTools} from './ai-host.mjs'
import {validateBashCommand} from './workspace-confinement.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
/// A worktree that looks like the real thing: a checkout under a directory nobody typed.
const WORKTREE = '/tmp/gofer-bench/worktrees/019febce-0184-70f0-a295-c1bf6cd190b9'

const named = variable => {
    const path = process.env[variable]
    if (path) return path
    throw new Error(`${variable} names the file the Rust dump wrote. See the header of this file.`)
}
const catalog = JSON.parse(await readFile(named('GOFER_BENCH_CATALOG'), 'utf8'))
const prompt = await readFile(named('GOFER_BENCH_PROMPT'), 'utf8')
const asSchema = tool => ({
    type: 'function',
    function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? tool.inputSchema
    }
})
const godot = createGodotTools(catalog, {call: async () => ({})}).map(asSchema)
// pi's own tools, with pi's own descriptions — including the "(relative or absolute)" on read,
// write and edit, which is true of those three and false of bash.
const environment = new NodeExecutionEnv({cwd: WORKTREE})
const local = [createBashTool, createReadTool, createWriteTool, createEditTool]
    .filter(Boolean)
    .map(make => {
        try {
            return make({executionEnv: environment, workspacePath: WORKTREE})
        } catch {
            return make()
        }
    })
    .map(asSchema)
const tools = [...godot, ...local]

const ARMS = {
    shipped: `Editor session: ready. Godot 4.7.2, worktree ${WORKTREE}.`,
    relative:
        'Editor session: ready. Godot 4.7.2. Every tool runs in the project root and takes paths the way the project spells them, never an absolute one.',
    both: `Editor session: ready. Godot 4.7.2, worktree ${WORKTREE}. Every tool runs in that root and takes paths the way the project spells them, never an absolute one.`
}

// Two scenarios. The first is the moment a live turn reached the shell: the project has been
// listed and nothing in it matched, so a wider search is a reasonable thing to want. The second
// needs the shell for something the worktree plainly holds, so an absolute path in it is
// self-inflicted rather than a search that had to go wider.
const SCENARIOS = {
    missing: {
        ask: 'Build a platformer ground row from tiles. Find the tile image the project holds and cut it into a TileSet.',
        priming: [
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'call-1',
                        type: 'function',
                        function: {
                            name: 'godot_resource',
                            arguments: JSON.stringify({ops: [{op: 'list'}]})
                        }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: 'call-1',
                content: JSON.stringify({
                    ops: [
                        {
                            op: 'list',
                            result: {
                                files: [
                                    {bytes: 560, path: 'addons/gofer/gofer.manifest.json'},
                                    {bytes: 232, path: 'main.tscn'},
                                    {bytes: 1024, path: 'project.godot'}
                                ]
                            }
                        }
                    ]
                })
            }
        ]
    },
    present: {
        ask: 'How many lines of GDScript does this project hold in total? Count them with the shell.',
        priming: []
    }
}

function conversation(sessionLine, scenario) {
    return [
        {role: 'system', content: `${prompt}\n\n${sessionLine}`},
        {role: 'user', content: scenario.ask},
        ...scenario.priming
    ]
}

async function ask(sessionLine, scenario, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages: conversation(sessionLine, scenario),
            tools,
            tool_choice: 'auto',
            temperature: 0.7,
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = await response.json()
    return body.choices?.[0]?.message ?? {}
}

// What the app would do with what the model wrote: a bash command the confinement rule refuses, and
// separately whether the worktree's absolute path appears anywhere in the call at all.
function score(message) {
    const calls = message.tool_calls ?? []
    const refusals = []
    let refused = 0
    let namedAbsolute = 0
    for (const call of calls) {
        const args = call.function?.arguments ?? '{}'
        if (args.includes(WORKTREE)) namedAbsolute += 1
        if (call.function?.name !== 'bash') continue
        try {
            validateBashCommand(JSON.parse(args).command)
        } catch {
            refused += 1
            refusals.push(JSON.parse(args).command)
        }
    }
    if (refusals.length > 0) process.stdout.write(`    ${refusals.join(' | ')}\n`)
    return {refused, namedAbsolute, calls: calls.length}
}

const seeds = Number(process.argv[2] ?? 20)
for (const [scenarioName, scenario] of Object.entries(SCENARIOS)) {
    const totals = Object.fromEntries(
        Object.keys(ARMS).map(name => [name, {refused: 0, namedAbsolute: 0, turns: 0}])
    )
    for (let seed = 1; seed <= seeds; seed += 1) {
        for (const [name, line] of Object.entries(ARMS)) {
            const scored = score(await ask(line, scenario, seed))
            totals[name].refused += scored.refused > 0 ? 1 : 0
            totals[name].namedAbsolute += scored.namedAbsolute > 0 ? 1 : 0
            totals[name].turns += 1
        }
    }
    console.log(`\n--- ${scenarioName}: turns where it happened at least once ---`)
    for (const [name, held] of Object.entries(totals))
        console.log(
            `${name.padEnd(9)} refusedShell ${held.refused}/${held.turns}  namedAbsolutePath ${held.namedAbsolute}/${held.turns}`
        )
}
