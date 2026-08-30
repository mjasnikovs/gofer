import {readFileSync} from 'node:fs'
import Ajv from 'ajv'
import {createGodotTools} from './godot-tools.mjs'

const named = variable => {
    const path = process.env[variable]
    if (path) return path
    throw new Error(`${variable} names the file the Rust dump wrote. See the header of this file.`)
}
const catalog = JSON.parse(readFileSync(named('GOFER_BENCH_CATALOG'), 'utf8'))
const tools = createGodotTools(catalog, {call: async () => ({})})
const ajv = new Ajv({strict: false, allErrors: true})
const byName = new Map(tools.map(tool => [tool.name, tool]))

let refused = 0
function verdict(label, toolName, args) {
    const tool = byName.get(toolName)
    const validate = ajv.compile(tool.parameters)
    const raw = validate(args)
    let prepared = args
    let refusal
    try {
        if (tool.prepareArguments) prepared = tool.prepareArguments(args)
    } catch (error) {
        refusal = error instanceof Error ? error.message : String(error)
    }
    const ok = refusal === undefined && validate(prepared)
    if (!ok) refused += 1
    const note =
        refusal !== undefined ? `  (${refusal})`
        : !raw && ok ? '  (refused raw, repaired by the normalizer)'
        : ''
    console.log(`${ok ? 'ACCEPTS' : 'REFUSES'}  ${label}${note}`)
    return ok
}

console.log('--- a single-value parameter handed a list (what unbox_the_one repairs) ---')
verdict('add_to_group node="/Main/A"       control, the correct shape', 'godot_node', {
    ops: [{op: 'add_to_group', node: '/Main/A', group: 'enemies'}]
})
verdict('add_to_group node=["/Main/A"]     the boxed shape', 'godot_node', {
    ops: [{op: 'add_to_group', node: ['/Main/A'], group: 'enemies'}]
})
verdict('set_cells    node=["/Main/Map"]   the boxed shape', 'godot_node', {
    ops: [{op: 'set_cells', node: ['/Main/Map'], cells: []}]
})

console.log(
    '\n--- nested entry shapes on godot_script edit (what the closed schema is said to stop) ---'
)
verdict('files[{path, edits[{oldText,newText}]}]   control, the correct shape', 'godot_script', {
    ops: [{op: 'edit', files: [{path: 'a.gd', edits: [{oldText: 'x', newText: 'y'}]}]}]
})
verdict('a padded nested key " oldText"', 'godot_script', {
    ops: [{op: 'edit', files: [{path: 'a.gd', edits: [{' oldText': 'x', newText: 'y'}]}]}]
})
verdict('a nested entry missing its required newText', 'godot_script', {
    ops: [{op: 'edit', files: [{path: 'a.gd', edits: [{oldText: 'x'}]}]}]
})
verdict('files nested inside its own entry, the five-files failure', 'godot_script', {
    ops: [
        {
            op: 'edit',
            files: [
                {
                    path: 'a.gd',
                    edits: [{oldText: 'x', newText: 'y'}],
                    files: [{path: 'b.gd', edits: []}]
                }
            ]
        }
    ]
})

console.log(`\n${refused} of 7 shapes refused before the router.`)
