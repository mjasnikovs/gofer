/**
 * What does the generated tool schema actually refuse, before the router ever sees a call?
 *
 * Two repairs live in Rust for shapes a model was measured writing — `unbox_the_one` (a lone value
 * in a list) and `trim_a_name` (a padded value). The question this answers is whether the schema
 * the agent loop validates against still lets those shapes through to be repaired, or refuses them
 * first, which would make the repair reachable only from the desktop client and the acceptance
 * suites — never from the model it was measured on.
 *
 * It runs the real chain: `prepareArguments` (the normalizer), then ajv over the real generated
 * schema, exactly as `prepareToolCall` does in pi's agent loop.
 *
 *   GOFER_BENCH_CATALOG=/tmp/catalog.json node scripts/bench-schema-probe.mjs
 */
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
/**
 * Both halves of the chain, because they answer different questions.
 *
 * `raw` is what the schema alone would do; `repaired` is what the agent loop actually does, since
 * `prepareArguments` runs first. A shape the schema refuses raw and accepts repaired is a repair
 * doing its job. A shape refused both ways never reaches the router at all.
 */
function verdict(label, toolName, args) {
    const tool = byName.get(toolName)
    const validate = ajv.compile(tool.parameters)
    const raw = validate(args)
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args
    const ok = validate(prepared)
    if (!ok) refused += 1
    const note = !raw && ok ? '  (refused raw, repaired by the normalizer)' : ''
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
