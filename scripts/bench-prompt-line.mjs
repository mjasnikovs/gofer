import {readFile} from 'node:fs/promises'
import {
    NodeExecutionEnv,
    createBashTool,
    createEditTool,
    createReadTool,
    createWriteTool
} from '@earendil-works/pi-agent-core/node'
import {createGodotTools} from './godot-tools.mjs'
import {validateBashCommand} from './workspace-confinement.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
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
