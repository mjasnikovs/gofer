// Tables and paired sign counts for lines-run.mjs rows. Read the signs, not the means.
import {readFile} from 'node:fs/promises'

const S = process.env.SCRATCH ?? import.meta.dirname
const ROWS = process.env.ROWS ?? 'lines-rows'
const rows = JSON.parse(await readFile(`${S}/${ROWS}.json`, 'utf8')).filter(r => !r.error)
const arms = [...new Set(rows.map(r => r.arm))]
const tasks = [...new Set(rows.map(r => r.task))]

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const pct = (n, d) => `${n}/${d}`

console.log('\nper arm')
console.log('arm  hit      named    read  open  bash  |off|  promptTok  ms')
for (const arm of arms) {
    const of = rows.filter(r => r.arm === arm)
    const named = of.filter(r => r.named !== null)
    console.log(
        `${arm.padEnd(4)} ${pct(of.filter(r => r.hit).length, of.length).padEnd(8)} ${pct(named.length, of.length).padEnd(8)}`
            + ` ${String(of.filter(r => r.read).length).padEnd(5)} ${String(of.filter(r => r.opened).length).padEnd(5)}`
            + ` ${String(of.filter(r => r.bash).length).padEnd(5)} ${mean(
                named.map(r => Math.abs(r.off))
            )
                .toFixed(2)
                .padEnd(6)}`
            + ` ${Math.round(mean(of.map(r => r.promptTokens)))
                .toString()
                .padEnd(10)} ${Math.round(mean(of.map(r => r.ms)))}`
    )
}

console.log('\nhits per task')
console.log('task      ' + arms.map(a => a.padEnd(8)).join(''))
for (const task of tasks) {
    const cells = arms.map(arm => {
        const of = rows.filter(r => r.task === task && r.arm === arm)
        return pct(of.filter(r => r.hit).length, of.length).padEnd(8)
    })
    console.log(task.padEnd(10) + cells.join(''))
}

console.log('\nlines named per task (want → named:count)')
for (const task of tasks)
    for (const arm of arms) {
        const of = rows.filter(r => r.task === task && r.arm === arm)
        const counts = {}
        for (const r of of) counts[r.named ?? 'none'] = (counts[r.named ?? 'none'] ?? 0) + 1
        console.log(
            `${task.padEnd(10)} ${arm} want ${of[0]?.want}  `
                + Object.entries(counts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => `${k}:${v}`)
                    .join(' ')
        )
    }

console.log('\npaired on (seed, task): win = hit where the other missed')
for (let i = 0; i < arms.length; i += 1)
    for (let j = i + 1; j < arms.length; j += 1) {
        const a = arms[i]
        const b = arms[j]
        let win = 0
        let loss = 0
        let tie = 0
        for (const ra of rows.filter(r => r.arm === a)) {
            const rb = rows.find(r => r.arm === b && r.seed === ra.seed && r.task === ra.task)
            if (!rb) continue
            if (rb.hit > ra.hit) win += 1
            else if (rb.hit < ra.hit) loss += 1
            else tie += 1
        }
        console.log(`${b} vs ${a}: wins ${win}  losses ${loss}  ties ${tie}`)
    }
