import {readFile} from 'node:fs/promises'
const S = process.env.SCRATCH ?? import.meta.dirname
const prompt = await readFile(`${S}/prompt.txt`, 'utf8')
for (const arm of ['S1', 'S2', 'S3', 'S4']) {
    const tools = JSON.parse(await readFile(`${S}/surf-tools-${arm}.json`, 'utf8'))
    const t0 = Date.now()
    const r = await fetch('http://localhost:8080/v1/chat/completions', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages: [
                {role: 'system', content: prompt},
                {
                    role: 'user',
                    content: 'Add a Sprite2D named Coin under /Main in the open scene. Do not save.'
                }
            ],
            tools: tools.map(t => ({type: 'function', function: t})),
            tool_choice: 'auto',
            reasoning_effort: 'medium',
            seed: 1
        })
    })
    if (!r.ok) {
        console.log(arm, 'HTTP', r.status, (await r.text()).slice(0, 400))
        continue
    }
    const b = await r.json()
    const m = b.choices?.[0]?.message ?? {}
    console.log(
        arm,
        Date.now() - t0,
        'ms',
        'prompt',
        b.usage?.prompt_tokens,
        'compl',
        b.usage?.completion_tokens
    )
    console.log(
        '   calls',
        JSON.stringify(m.tool_calls?.map(c => [c.function.name, c.function.arguments]))
    )
}
