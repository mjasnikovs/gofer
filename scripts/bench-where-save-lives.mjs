import {readFile} from 'node:fs/promises'
import {createGodotTools} from './godot-tools.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
const MODEL = process.env.GOFER_BENCH_MODEL ?? 'local'
const AUTHORIZATION =
    process.env.OPENROUTER_API_KEY ?
        {authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`}
    :   {}

const named = variable => {
    const path = process.env[variable]
    if (path) return path
    throw new Error(`${variable} names the file the Rust dump wrote. See the header of this file.`)
}
const catalog = JSON.parse(await readFile(named('GOFER_BENCH_CATALOG'), 'utf8'))
const prompt = await readFile(named('GOFER_BENCH_PROMPT'), 'utf8')

const ARMS = {
    shipped: '',
    saidSo: ' Nothing here writes the file. The scene is saved with godot_scene save.'
}

const asSchema = tool => ({
    type: 'function',
    function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? tool.inputSchema
    }
})

function toolsFor(clause) {
    const extended = catalog.map(domain =>
        domain.name === 'godot_node' ?
            {...domain, description: `${domain.description}${clause}`}
        :   domain
    )
    return createGodotTools(extended, {call: async () => ({})}).map(asSchema)
}

const ASK =
    'Add a pause menu to this game. Escape shows a CanvasLayer with a Resume button and a Quit '
    + 'button and pauses the game; Resume unpauses. Wire both buttons to a script.'

const PRIMING = [
    {
        role: 'assistant',
        content: null,
        tool_calls: [
            {
                id: 'call-1',
                type: 'function',
                function: {
                    name: 'godot_scene',
                    arguments: JSON.stringify({
                        ops: [
                            {
                                op: 'create',
                                path: 'res://scenes/pause_menu.tscn',
                                rootType: 'CanvasLayer',
                                rootName: 'PauseMenu'
                            }
                        ]
                    })
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
                    op: 'create',
                    result: {dirty: false, revision: 0, scene: 'res://scenes/pause_menu.tscn'}
                }
            ]
        })
    },
    {
        role: 'assistant',
        content: null,
        tool_calls: [
            {
                id: 'call-2',
                type: 'function',
                function: {
                    name: 'godot_node',
                    arguments: JSON.stringify({
                        ops: [
                            {
                                op: 'create_nodes',
                                nodes: [
                                    {parent: '/PauseMenu', name: 'Box', type: 'VBoxContainer'},
                                    {parent: '/PauseMenu/Box', name: 'Resume', type: 'Button'},
                                    {parent: '/PauseMenu/Box', name: 'Quit', type: 'Button'}
                                ]
                            },
                            {
                                op: 'set_properties',
                                properties: [
                                    {
                                        node: '/PauseMenu',
                                        property: 'script',
                                        value: {
                                            type: 'resource',
                                            value: {path: 'res://scripts/pause_menu.gd'}
                                        }
                                    }
                                ]
                            }
                        ]
                    })
                }
            }
        ]
    },
    {
        role: 'tool',
        tool_call_id: 'call-2',
        content: JSON.stringify({
            ops: [
                {
                    op: 'create_nodes',
                    result: {
                        created: 3,
                        nodes: ['/PauseMenu/Box', '/PauseMenu/Box/Resume', '/PauseMenu/Box/Quit'],
                        revision: 1
                    }
                },
                {op: 'set_properties', result: {revision: 2}}
            ]
        })
    }
]

async function ask(clause, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json', ...AUTHORIZATION},
        body: JSON.stringify({
            model: MODEL,
            messages: [
                {role: 'system', content: `${prompt}\n\nEditor session: ready. Godot 4.7.2.`},
                {role: 'user', content: ASK},
                ...PRIMING
            ],
            tools: toolsFor(clause),
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
    if (process.env.GOFER_BENCH_PEEK)
        for (const call of message.tool_calls ?? [])
            process.stdout.write(
                `    ${call.function?.name} ${call.function?.arguments?.slice(0, 200)}\n`
            )
    let savedOnNode = 0
    let savedOnScene = 0
    let entries = 0
    for (const call of message.tool_calls ?? []) {
        let args
        try {
            args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
            continue
        }
        const ops = Array.isArray(args.ops) ? args.ops : []
        entries += ops.length
        for (const entry of ops) {
            if (entry?.op !== 'save') continue
            if (call.function?.name === 'godot_node') savedOnNode += 1
            if (call.function?.name === 'godot_scene') savedOnScene += 1
        }
    }
    return {savedOnNode, savedOnScene, entries}
}

const seeds = Number(process.argv[2] ?? 20)
const totals = Object.fromEntries(
    Object.keys(ARMS).map(name => [name, {onNode: 0, onScene: 0, entries: 0, turns: 0}])
)
for (let seed = 1; seed <= seeds; seed += 1) {
    for (const [name, clause] of Object.entries(ARMS)) {
        const scored = score(await ask(clause, seed))
        totals[name].onNode += scored.savedOnNode > 0 ? 1 : 0
        totals[name].onScene += scored.savedOnScene > 0 ? 1 : 0
        totals[name].entries += scored.entries
        totals[name].turns += 1
    }
}
console.log('\n--- turns where it happened at least once ---')
for (const [name, held] of Object.entries(totals))
    console.log(
        `${name.padEnd(8)} saveOnNode ${held.onNode}/${held.turns}`
            + `  saveOnScene ${held.onScene}/${held.turns}`
            + `  opsWritten ${held.entries}`
    )
