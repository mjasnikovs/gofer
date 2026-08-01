import {warmup} from '@mjasnikovs/gofer-rag'
import {createProgressReporter, EVENT_PREFIX} from './rag-progress.mjs'

function emit(progress) {
    process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(progress)}\n`)
}

const reporter = createProgressReporter({emit})

try {
    emit({status: 'starting', model: 'Gofer RAG'})
    await warmup({
        allowModelDownloads: reporter.approveDownloads,
        onDownloadProgress: reporter.reportProgress
    })
    reporter.reportReady()
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
}
