import {execFileSync} from 'node:child_process'
import {writeFileSync, mkdtempSync} from 'node:fs'
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'

const S = process.env.SCRATCH ?? import.meta.dirname
const DBS = ['gofer', 'qwen', 'swarm', 'spawn']
const calls = []
const seen = new Set()

for (const db of DBS) {
    const uri = `file:/home/edgars/hub/${db}/.gofer/project.sqlite?mode=ro`
    let ids = []
    try {
        ids = execFileSync('sqlite3', [uri, 'select id from tasks;'], {maxBuffer: 1 << 28})
            .toString()
            .trim()
            .split('\n')
            .filter(Boolean)
    } catch (e) {
        console.error(db, 'no tasks', e.message)
        continue
    }
    for (const id of ids) {
        const raw = execFileSync(
            'sqlite3',
            [uri, `select agent_messages_json from tasks where id='${id}';`],
            {maxBuffer: 1 << 30}
        ).toString()
        let messages
        try {
            messages = JSON.parse(raw)
        } catch {
            console.error(db, id, 'unparsable')
            continue
        }
        if (!Array.isArray(messages)) continue
        for (const message of messages) {
            if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
            for (const part of message.content) {
                if (part?.type !== 'toolCall') continue
                const key = `${db}:${part.id}:${JSON.stringify(part.arguments).length}`
                if (seen.has(key)) continue
                seen.add(key)
                calls.push({
                    db,
                    task: id,
                    id: part.id,
                    name: part.name,
                    model: message.model ?? null,
                    provider: message.provider ?? null,
                    api: message.api ?? null,
                    arguments: part.arguments
                })
            }
        }
    }
    console.error(db, 'done, running total', calls.length)
}
writeFileSync(`${S}/corpus.json`, JSON.stringify(calls))
console.log('calls', calls.length)
