// The trim arms of TOOL_CONTRACT_DESIGN.md "Trims", each built by the real builder over the real
// catalogue with one thing cut, so an arm is exactly the surface that would ship if the cut won.
//
// TU won and shipped: the catalogue itself now carries the first sentences, no parameter notes and
// no domain descriptions, so every cut below is idempotent on it and TU must equal the committed
// tool byte for byte. The other arms no longer restore what they cut — rebuilding one of those
// means running this against the catalogue as of the measuring commit.
import {readFile, writeFile} from 'node:fs/promises'
import {declaredDomains} from '../declared-domains.mjs'
import {createGodotTools} from '../godot-tools.mjs'
const REPO = new URL('../..', import.meta.url).pathname

const S = process.env.SCRATCH ?? import.meta.dirname
const committed = JSON.parse(await readFile(`${REPO}/protocol/schemas/v2/godot-tool.json`, 'utf8'))
const shipped = JSON.parse(await readFile(`${S}/shapes-tools-C.json`, 'utf8'))
const extras = shipped.filter(t => !t.name.startsWith('godot_'))
const prompt = await readFile(`${S}/surf-prompt-S2.txt`, 'utf8')

const clone = value => JSON.parse(JSON.stringify(value))
const firstSentence = summary => summary.match(/^[\s\S]*?\.(?=\s+[A-Z`{(]|\s*$)/u)?.[0] ?? summary

// The one rule the prose run found the model does not already obey.
const KEEP_WHOLE = new Set(['godot_runtime.input'])

const eachParam = (params, visit) => {
    for (const param of params ?? []) {
        visit(param)
        eachParam(param.entry, visit)
    }
}

const TRIMS = {
    T0: domains => domains,
    // summaries: first sentence only, the button rule kept whole
    T1: domains => {
        for (const domain of domains)
            for (const operation of domain.operations)
                if (!KEEP_WHOLE.has(`${domain.name}.${operation.op}`))
                    operation.summary = firstSentence(operation.summary)
        return domains
    },
    // per-parameter notes out
    T2: domains => {
        for (const domain of domains)
            for (const operation of domain.operations)
                eachParam(operation.params, param => delete param.note)
        return domains
    },
    // the signature line out
    T3: domains => {
        for (const domain of domains)
            for (const operation of domain.operations) operation.signature = ''
        return domains
    },
    // domain descriptions out
    T7: domains => {
        for (const domain of domains) domain.description = ''
        return domains
    },
    // every cut that held on its own, measured as one set
    TU: domains => TRIMS.T7(TRIMS.T3(TRIMS.T2(TRIMS.T1(domains))))
}

const ARMS = process.env.ARMS?.split(',') ?? Object.keys(TRIMS)
const base = await declaredDomains()
for (const arm of ARMS) {
    const cuts = arm.split('+').map(name => {
        if (!TRIMS[name]) throw new Error(`no trim named ${name}`)
        return TRIMS[name]
    })
    let domains = clone(base)
    for (const cut of cuts) domains = cut(domains)
    const [godot] = createGodotTools(domains, {call: async () => ({})})
    const tool = {
        name: godot.name,
        description: godot.description,
        parameters: godot.parameters
    }
    if (arm === 'TU' && JSON.stringify(tool) !== JSON.stringify(committed))
        throw new Error('TU is not the committed tool')
    const listed = [tool, ...extras]
    for (const prefix of ['prose', 'surf']) {
        await writeFile(`${S}/${prefix}-tools-${arm}.json`, JSON.stringify(listed, null, 2))
        await writeFile(`${S}/${prefix}-prompt-${arm}.txt`, prompt)
    }
    console.log(
        arm,
        'descChars',
        tool.description.length,
        'paramChars',
        JSON.stringify(tool.parameters).length
    )
}
