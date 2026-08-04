import readline from 'node:readline'
import {retrieve} from '@mjasnikovs/gofer-rag'
import {runRetrieve} from './rag-retrieve.mjs'

const lines = readline.createInterface({input: process.stdin, crlfDelay: Infinity})
for await (const line of lines) {
    await runRetrieve({
        retrieve,
        input: async () => line,
        output: message => process.stdout.write(message),
        fail: message => process.stderr.write(`${message}\n`)
    })
}
