import readline from 'node:readline'
import {probeRetriever, runRetrieve} from '../../scripts/rag-retrieve.mjs'

const chunks = [
    {
        text: 'Signals are Godot’s observer pattern: connect one with Node.connect or the editor’s Node dock, and the receiver runs when the signal is emitted.',
        chapter: 'Signals',
        order: 4,
        score: 0.93,
        vector: [0.11, 0.22, 0.33]
    },
    {
        text: 'A custom signal is declared with the signal keyword and emitted with emit_signal, or by calling the signal itself.',
        chapter: 'GDScript basics',
        order: 11,
        score: 0.81,
        vector: [0.44, 0.55, 0.66]
    },
    {
        text: 'Groups are the loose alternative to signals when many nodes must react to the same call.',
        chapter: 'Groups',
        order: 2,
        score: 0.42,
        vector: [0.77, 0.88, 0.99]
    }
]

const isProbe = line => {
    try {
        return JSON.parse(line)?.probe === true
    } catch {
        return false
    }
}

const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity})
for await (const line of lines) {
    if (isProbe(line)) {
        await probeRetriever()
        continue
    }
    await runRetrieve({
        retrieve: async () => chunks,
        input: async () => line,
        output: message => process.stdout.write(message),
        fail: message => process.stderr.write(`${message}\n`)
    })
}
