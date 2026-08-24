/**
 * What a design should be handed over as: words, markup, a picture, or some pair of them.
 *
 * `ask_user` delegates a layout to a child, the child agrees it with the user, and the parent is
 * handed the result to build from. Today that is the agreement in words with the child's own HTML
 * appended. Nothing measured whether the markup earns what it costs, or whether a rendered picture
 * would do the same job for fewer tokens — this does.
 *
 * The one rule that makes the numbers mean anything is `bench-prompt-line.mjs`'s and it is obeyed
 * here: **score every arm inside one process, alternating, and read the sign of the gap.** Neither
 * number means anything on its own. The same check an hour later has landed seventeen points away.
 *
 * Two predicates, deliberately, because the arms are good at different things and one score would
 * hide it. STRUCTURE is what a picture can carry — what is centred, what is stacked, what is above
 * what. MEASUREMENTS is what only the markup states — the exact widths, heights and gaps. A picture
 * that wins structure and loses measurements is a real result, not a tie.
 *
 * Cost is reported beside both, in prompt tokens, because a format that scores the same for fewer
 * tokens is the better format.
 *
 *   node scripts/bench-handoff-format.mjs 12
 *
 * `GOFER_BENCH_ENDPOINT` names the completions endpoint; the default is the llama.cpp on
 * 127.0.0.1:8080 that the rest of this repo's benchmarks point at. The picture arms need a model
 * that reads one — probe it before trusting a zero.
 */

import {chromium} from 'playwright'

const ENDPOINT = process.env.GOFER_BENCH_ENDPOINT ?? 'http://127.0.0.1:8080/v1/chat/completions'

/**
 * The layout being handed over, as the child would have drawn it.
 *
 * Chosen so both predicates have something to bite on: the structure is legible at a glance, and
 * the measurements are numbers nobody would guess. Deliberately NOT round — 468 and 54 are wrong in
 * a way that shows, where 480 and 56 could be arrived at by luck.
 */
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

/**
 * The same layout written down, as a child actually writes it.
 *
 * Deliberately NOT a complete specification, and that is the whole design of this benchmark. A first
 * pass used one, and every arm scored full marks: if the words already carry every number then the
 * markup and the picture are measuring nothing, and the answer is trivially "send the words". What
 * `agreedSketch` records is the opposite failure — a description that READS as complete and still
 * leaves the builder guessing, which is what this is. It has the shape and the type size; it has no
 * panel width, no button height, no spacing, and it never mentions the hint line or the dimming.
 */
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

/**
 * What the parent is asked to do with the handoff.
 *
 * Answering in words rather than in tool calls, because what is being measured is what reached the
 * parent — not whether this model can drive the Godot catalogue, which `bench-prompt-line.mjs`
 * already covers and which would add its own noise.
 */
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

/** Renders the sketch at the size the model was told to draw it. */
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

/**
 * The four handoffs, all carrying the same agreement in words.
 *
 * Words are in every arm because the child writes them anyway — the question is never "words or
 * something else", it is what the something else is worth on top of them.
 */
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

/**
 * What a picture can carry: what is where, and in what order.
 *
 * Scored on the answer's own words rather than on a tool call, and generously — a builder that says
 * "centered" and one that says "anchored to the centre" have both got it.
 */
const STRUCTURE = [
    {name: 'hint-line', test: t => /esc to resume/u.test(t)},
    {name: 'dimmed', test: t => /dim|overlay|scrim|translucent|semi-?transparent|rgba/u.test(t)},
    {name: 'hint-below', test: t => t.indexOf('quit') < t.lastIndexOf('esc to resume')}
]

/**
 * The four measurements the words leave out, as numbers nobody would guess.
 *
 * A picture cannot state a pixel and is not expected to: what it can do is stop a builder inventing
 * one that is plainly wrong. The markup can state them exactly. That asymmetry is real and this
 * benchmark exists to price it, not to hide it.
 */
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
        // Reasoning counts: a model that works the layout out in its thinking and writes a short
        // answer has still read the handoff, and scoring only the visible half would call that a
        // miss for a reason that has nothing to do with the format.
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
