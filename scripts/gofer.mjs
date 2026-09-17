#!/usr/bin/env node
import {writeFileSync} from 'node:fs'
import {USAGE, parseArgs, pickTool, readDoor, requestFor, send} from './gofer-cli.mjs'

async function main(argv) {
    const parsed = parseArgs(argv)
    const request = requestFor(parsed)
    if (request.usage) {
        process.stdout.write(USAGE)
        return 0
    }
    const door = readDoor()
    let answer = await send(door, request.method, request.params)
    if (request.method === 'tools') answer = pickTool(answer, request.only)
    const text = parsed.flags.raw ? JSON.stringify(answer) : JSON.stringify(answer, null, 2)
    if (typeof parsed.flags.out === 'string') {
        writeFileSync(parsed.flags.out, `${text}\n`)
        process.stdout.write(`${parsed.flags.out}\n`)
    } else {
        process.stdout.write(`${text}\n`)
    }
    return 0
}

// The exit code is set rather than forced: a large answer into a pipe is still being written
// when `process.exit` would run, and it would be cut mid-line.
main(process.argv.slice(2)).then(
    code => {
        process.exitCode = code
    },
    error => {
        process.stderr.write(`${error.message}\n`)
        if (error.refusal) process.stderr.write(`${JSON.stringify(error.refusal, null, 2)}\n`)
        process.exitCode = 1
    }
)
