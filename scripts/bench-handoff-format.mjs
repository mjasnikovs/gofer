import {chromium} from 'playwright'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'

const SKETCH = `<div style="width:1280px;height:720px;background:#10131c;position:relative;font-family:system-ui">
  <div style="position:absolute;inset:0;background:rgba(4,6,12,.72)"></div>
  <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:468px;padding:36px;background:#1b2030;border:2px solid #3d4a6b">
    <h1 style="margin:0 0 28px;font-size:34px;letter-spacing:7px;color:#e8edff;text-align:center">PAUSED</h1>
    <div style="height:54px;margin-bottom:18px;background:#2a3350;color:#e8edff;display:flex;align-items:center;justify-content:center;font-size:19px">RESUME</div>
    <div style="height:54px;margin-bottom:18px;background:#2a3350;color:#e8edff;display:flex;align-items:center;justify-content:center;font-size:19px">OPTIONS</div>
    <div style="height:54px;background:#2a3350;color:#e8edff;display:flex;align-items:center;justify-content:center;font-size:19px">QUIT</div>
    <p style="margin:28px 0 0;text-align:center;color:#8d97b5;font-size:14px">Esc to resume</p>
  </div>
</div>`

const PROSE =
    'We agreed a centred pause panel that sits over the game.\n'
    + '\n'
    + 'The panel is centred horizontally and vertically on a 1280x720 screen and takes up a bit '
    + 'over a third of its width, with comfortable padding inside a thin border.\n'
    + 'The title reads PAUSED at 34 pixels, letter-spaced and centred, with a clear gap under it.\n'
    + 'Under the title are three buttons stacked vertically in this order: Resume, Options, Quit. '
    + 'Each runs the full width of the panel.\n'
    + '\n'
    + 'The user rejected a left-docked sidebar and a wide horizontal bar before settling on this.'

const ASK =
    'A design sub-agent agreed this pause menu with the user. Build it in Godot 4.7 as a Control '
    + 'scene. Before you write anything, list the scene tree you are going to make and state every '
    + 'measurement you will set on it: each node, its anchor, its size, and the spacing around it. '
    + 'Be specific and use numbers.'

const HTML_NOTE =
    '\n\nThis is the layout they agreed, as it was drawn for them. It is a picture of the result, '
    + "not code to port: build it with the project's own nodes, and read it for what sits where, "
    + 'how big each region is and what the spacing is.\n\n'

const PICTURE_NOTE =
    '\n\nAttached is the layout they agreed, as it was drawn for them. It is a picture of the '
    + "result, not code to port: build it with the project's own nodes."

async function raster() {
    const browser = await chromium.launch()
    const page = await browser.newPage({viewport: {width: 1280, height: 720}})
    await page.setContent(SKETCH)
    const png = await page.screenshot({type: 'png'})
    await browser.close()
    return png.toString('base64')
}

const picture = await raster()

const imagePart = {
    type: 'image_url',
    image_url: {url: `data:image/png;base64,${picture}`}
}

const ARMS = {
    prose: () => [{type: 'text', text: `${PROSE}\n\n${ASK}`}],
    html: () => [{type: 'text', text: `${PROSE}${HTML_NOTE}${SKETCH}\n\n${ASK}`}],
    picture: () => [
        {type: 'text', text: `${PROSE}${PICTURE_NOTE}`},
        imagePart,
        {type: 'text', text: ASK}
    ],
    both: () => [
        {type: 'text', text: `${PROSE}${HTML_NOTE}${SKETCH}${PICTURE_NOTE}`},
        imagePart,
        {type: 'text', text: ASK}
    ]
}

const STRUCTURE = [
    {name: 'hint-line', test: t => /esc to resume/u.test(t)},
    {name: 'dimmed', test: t => /dim|overlay|scrim|translucent|semi-?transparent|rgba/u.test(t)},
    {name: 'hint-below', test: t => t.indexOf('quit') < t.lastIndexOf('esc to resume')}
]

const MEASUREMENTS = [
    {name: 'width-468', test: t => t.includes('468')},
    {name: 'button-54', test: t => t.includes('54')},
    {name: 'gap-18', test: t => t.includes('18')},
    {name: 'padding-36', test: t => t.includes('36')}
]

function score(text) {
    const flat = text.toLowerCase()
    const count = facts => facts.filter(fact => fact.test(flat)).length
    return {structure: count(STRUCTURE), measurements: count(MEASUREMENTS)}
}

async function ask(content, seed) {
    const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            model: 'local',
            messages: [{role: 'user', content}],
            temperature: 0.7,
            max_tokens: 1600,
            seed
        })
    })
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
    const body = await response.json()
    const message = body.choices?.[0]?.message ?? {}
    return {
        text: `${message.content ?? ''}\n${message.reasoning_content ?? ''}`,
        cost: body.usage?.prompt_tokens ?? 0
    }
}

const seeds = Number(process.argv[2] ?? 12)
const totals = Object.fromEntries(
    Object.keys(ARMS).map(name => [name, {structure: 0, measurements: 0, cost: 0, turns: 0}])
)

for (let seed = 1; seed <= seeds; seed += 1) {
    for (const [name, build] of Object.entries(ARMS)) {
        const {text, cost} = await ask(build(), seed)
        const held = score(text)
        totals[name].structure += held.structure
        totals[name].measurements += held.measurements
        totals[name].cost += cost
        totals[name].turns += 1
        process.stdout.write(
            `seed ${String(seed).padStart(2)} ${name.padEnd(8)} structure ${String(held.structure)}/3  measurements ${String(held.measurements)}/4  ${String(cost)} tok\n`
        )
    }
}

console.log('\n--- averages over the same seeds, interleaved in one process ---')
for (const [name, held] of Object.entries(totals)) {
    const per = value => (value / held.turns).toFixed(2)
    console.log(
        `${name.padEnd(8)} structure ${per(held.structure)}/3  measurements ${per(held.measurements)}/4  cost ${String(Math.round(held.cost / held.turns))} tok`
    )
}
