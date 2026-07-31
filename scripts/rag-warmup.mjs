import {warmup} from '@mjasnikovs/gofer-rag'

const EVENT_PREFIX = 'GOFER_RAG_EVENT:'
const EMIT_INTERVAL_MS = 250
const fileProgress = new Map()
let expectedBytes = 0
let modelCount = 0
let lastEmitTime = 0

function emit(progress) {
    process.stdout.write(`${EVENT_PREFIX}${JSON.stringify(progress)}\n`)
}

function approveDownloads(models) {
    modelCount = models.length
    expectedBytes = models.reduce((total, model) => total + model.expectedBytes, 0)
    emit({
        status: 'downloading',
        model: `${String(modelCount)} models`,
        loaded: 0,
        total: expectedBytes,
        progress: 0
    })
    return true
}

function reportProgress(progress) {
    if (progress.file && progress.total !== undefined) {
        const key = `${progress.model}:${progress.file}`
        const previous = fileProgress.get(key)
        const loaded =
            progress.loaded
            ?? (progress.status === 'done' ? progress.total : (previous?.loaded ?? 0))
        fileProgress.set(key, {loaded, total: progress.total})
    }

    const loaded = [...fileProgress.values()].reduce(
        (total, file) => total + Math.min(file.loaded, file.total),
        0
    )
    const now = Date.now()
    if (now - lastEmitTime < EMIT_INTERVAL_MS) return
    lastEmitTime = now
    emit({
        status: 'downloading',
        model: `${String(modelCount)} models`,
        loaded,
        total: expectedBytes,
        progress: expectedBytes > 0 ? Math.min(99, (loaded / expectedBytes) * 100) : undefined
    })
}

try {
    emit({status: 'starting', model: 'Gofer RAG'})
    await warmup({
        allowModelDownloads: approveDownloads,
        onDownloadProgress: reportProgress
    })
    emit({
        status: 'ready',
        model: `${String(modelCount)} models`,
        loaded: expectedBytes,
        total: expectedBytes,
        progress: 100
    })
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
}
