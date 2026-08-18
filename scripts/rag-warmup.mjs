import {warmup} from '@mjasnikovs/gofer-rag'
import {EVENT_PREFIX, runWarmup} from './rag-progress.mjs'

const succeeded = await runWarmup({
    warmup,
    emit: progress => process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(progress)}\n`),
    fail: message => process.stderr.write(`${message}\n`)
})

if (!succeeded) process.exitCode = 1
