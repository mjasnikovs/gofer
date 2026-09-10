// The two ways a model can learn a path it was not given, each built by the real builder over the
// real catalogue so an arm is exactly the surface that would ship if it won.
//
//   A = the shipped tool, and the inventory appended to the user message (today's turn)
//   B = the shipped tool plus one `files.list` operation, and no inventory in the message
//
// The inventory is not part of the tool list, so only B differs here; A's file is the committed
// tool verbatim, which is what makes the pair a one-variable comparison.
import {readFile, writeFile} from 'node:fs/promises'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools} from '../godot-tools.mjs'

const REPO = new URL('../..', import.meta.url).pathname
const S = process.env.SCRATCH ?? import.meta.dirname
const committed = JSON.parse(await readFile(`${REPO}/protocol/schemas/v2/godot-tool.json`, 'utf8'))
const shipped = JSON.parse(await readFile(`${S}/shapes-tools-C.json`, 'utf8'))
const extras = shipped.filter(tool => !tool.name.startsWith('godot_'))
const prompt = await readFile(`${S}/surf-prompt-S2.txt`, 'utf8')

const clone = value => JSON.parse(JSON.stringify(value))

const LIST_PARAMS = [
    {name: 'under', kind: 'text', required: false},
    {name: 'glob', kind: 'text', required: false}
]

/** The operation arm B is measured with, in the shape `declaredDomains` hands the builder one. */
const FILES_DOMAIN = {
    name: 'godot_files',
    operations: [
        {
            op: 'list',
            summary:
                "Lists the project's files, every path the way the project spells them; under"
                + ' narrows to a directory, glob to a pattern.',
            params: LIST_PARAMS,
            alone: null
        }
    ]
}

// `godot_resource` is where the other project-wide listers live, so the new one reads next to its
// neighbours rather than after the debugger.
function withFiles(domains) {
    const at = domains.findIndex(domain => domain.name === 'godot_resource')
    const copy = [...domains]
    copy.splice(at < 0 ? copy.length : at + 1, 0, clone(FILES_DOMAIN))
    return copy
}

const buildOne = domains => {
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    return {
        name: godot.name,
        description: godot.description,
        parameters: godot.parameters
    }
}

const base = await declaredDomains()
const ARMS = {A: () => clone(base), B: () => withFiles(clone(base))}

for (const [arm, of] of Object.entries(ARMS)) {
    const tool = of()
    const built = buildOne(tool)
    if (arm === 'A' && JSON.stringify(built) !== JSON.stringify(committed))
        throw new Error('arm A is not the committed tool')
    await writeFile(`${S}/inv-tools-${arm}.json`, JSON.stringify([built, ...extras], null, 2))
    await writeFile(`${S}/inv-prompt-${arm}.txt`, prompt)
    const branches = built.parameters.properties.ops.items.oneOf.length
    console.log(arm, 'ops', branches, 'descChars', built.description.length)
}

console.log(
    'files.list line:',
    buildOne(withFiles(clone(base)))
        .description.split('\n')
        .find(line => line.startsWith('- files.list'))
)
