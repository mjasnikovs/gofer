// Three placements for the behavioural prose. Vocabulary is held at whatever VOCAB names.
import {readFile, writeFile} from 'node:fs/promises'
import {buildS2} from './s2.mjs'

const S = process.env.SCRATCH ?? import.meta.dirname
const VOCAB = process.env.VOCAB ?? 'V1'
const base = JSON.parse(await readFile(`${S}/vocab-catalog-${VOCAB}.json`, 'utf8'))

// Mechanical: up to the first full stop that a new sentence follows. `res://` and `{"type"` never
// end one, so the boundary is a stop with a capital, a backtick or a brace after it.
const firstSentence = summary => summary.match(/^[\s\S]*?\.(?=\s+[A-Z`{(]|\s*$)/u)?.[0] ?? summary

const ARMS = {
    P1: buildS2(base),
    P2: buildS2(base, {summaryOf: o => firstSentence(o.summary)}),
    P3: buildS2(base, {summaryOf: () => ''})
}

for (const [arm, tools] of Object.entries(ARMS)) {
    await writeFile(`${S}/prose-tools-${arm}.json`, JSON.stringify(tools, null, 2))
    console.log(
        arm,
        'bytes',
        JSON.stringify(tools).length,
        'descChars',
        tools.find(t => t.name === 'godot').description.length
    )
}
