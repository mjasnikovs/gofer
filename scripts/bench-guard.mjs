import {readFile} from 'node:fs/promises'
import Ajv from 'ajv'
import {createGodotTools} from './godot-tools.mjs'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'
const HERE =
    '/tmp/claude-1000/-home-edgars-hub-gofer/ba1c313e-b77c-485d-9ccc-391ac8929347/scratchpad'
const catalog = JSON.parse(await readFile(`${HERE}/catalog.json`, 'utf8'))
const prompt = await readFile(`${HERE}/prompt.txt`, 'utf8')
const ajv = new Ajv({strict: false, allErrors: true})
const seeds = Number(process.argv[2] ?? 12)

const tools = createGodotTools(catalog, {call: async () => ({})})
const schemas = tools.map(tool => ({
    type: 'function',
    function: {name: tool.name, description: tool.description, parameters: tool.parameters}
}))

const SESSION = 'Editor session: ready. Godot 4.7.2, scene res://scenes/main.tscn open, revision 7.'
const ASK =
    'Place three instances of res://scenes/brick.tscn under /Main, named Brick1, Brick2 and Brick3.'

const TORN = JSON.stringify({
    ops: [
        {
            op: 'instantiate',
            parent: '/Main',
            path: 'res://scenes/brick.tscn',
            "name': null}]_1_1_PLACEHOLDER_1_1'}, {": null
        }
    ]
})
const ANSWER =
    "unknown_param: godot_node instantiate has no `name': null}]_1_1_PLACEHOLDER_1_1'}, {`"
    + ' parameter. It takes {parent: text, path: text, name?: text, index?: int}.'
    + ' Did you mean `name`?'
const GUARD =
    'godot_node has now refused this exact call 4 times, with the same answer every time, and'
    + ' nothing about the project changed between them. A further one will be refused identically.'
    + ' Whatever is wrong is in the call itself: build it again from nothing rather than sending'
    + ' the one you have, or reach the same result another way.'

function messages(guardCarriesTheAnswer) {
    const out = [
        {role: 'system', content: `${prompt}\n\n${SESSION}`},
        {role: 'user', content: ASK}
    ]
    const answers = [
        ANSWER,
        ANSWER,
        ANSWER,
        guardCarriesTheAnswer ? `${GUARD}\n\n${ANSWER}` : GUARD
    ]
    answers.forEach((said, attempt) => {
        out.push({
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: `c${attempt}`,
                    type: 'function',
                    function: {name: 'godot_node', arguments: TORN}
                }
            ]
        })
        out.push({role: 'tool', tool_call_id: `c${attempt}`, content: said})
    })
    return out
}

async function ask(body, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages: body,
            tools: schemas,
            tool_choice: 'auto',
            temperature: 1.0,
            top_p: 0.95,
            seed,
            chat_template_kwargs: {
                enable_thinking: true,
                preserve_thinking: true,
                reasoning_effort: 'medium'
            }
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    return (await response.json()).choices?.[0]?.message ?? {}
}

function escaped(message) {
    let sawACall = false
    for (const call of message.tool_calls ?? []) {
        const tool = tools.find(one => one.name === call.function?.name)
        if (!tool) continue
        sawACall = true
        let args
        try {
            args = JSON.parse(call.function?.arguments ?? '{}')
        } catch {
            return {escaped: false, why: 'unparseable'}
        }
        let prepared = args
        try {
            if (tool.prepareArguments) prepared = tool.prepareArguments(args)
        } catch {
            return {escaped: false, why: 'refused by prepareArguments'}
        }
        const entries = Array.isArray(prepared.ops) ? prepared.ops : [prepared]
        for (const entry of entries)
            for (const key of Object.keys(entry ?? {}))
                if (/["'{}[\]]/u.test(key))
                    return {escaped: false, why: `torn key ${key.slice(0, 30)}`}
        if (!ajv.compile(tool.parameters)(prepared)) return {escaped: false, why: 'schema refused'}
    }
    return sawACall ? {escaped: true, why: ''} : {escaped: false, why: 'no call at all'}
}

const tally = {guardOnly: {ok: 0, n: 0, why: []}, guardPlusAnswer: {ok: 0, n: 0, why: []}}
for (let seed = 1; seed <= seeds; seed += 1) {
    for (const [name, carries] of [
        ['guardOnly', false],
        ['guardPlusAnswer', true]
    ]) {
        try {
            const verdict = escaped(await ask(messages(carries), seed))
            tally[name].n += 1
            if (verdict.escaped) tally[name].ok += 1
            else tally[name].why.push(verdict.why)
        } catch (error) {
            console.error(`seed ${seed} ${name}: ${error.message}`)
        }
    }
    process.stderr.write(
        `seed ${seed}: guardOnly ${tally.guardOnly.ok}/${tally.guardOnly.n}`
            + ` guardPlusAnswer ${tally.guardPlusAnswer.ok}/${tally.guardPlusAnswer.n}\n`
    )
}
for (const [name, held] of Object.entries(tally)) {
    console.log(`${name}: ${held.ok}/${held.n} escaped the loop`)
    const counts = new Map()
    for (const why of held.why) counts.set(why, (counts.get(why) ?? 0) + 1)
    for (const [why, count] of [...counts].sort((a, b) => b[1] - a[1]))
        console.log(`   ${count}x ${why}`)
}
