export const EVENT_PREFIX = 'GOFER_RAG_EVENT:'

export function createProgressReporter({emit, now = Date.now, emitIntervalMs = 250}) {
    const fileProgress = new Map()
    let expectedBytes = 0
    let modelCount = 0
    let lastEmitTime = Number.NEGATIVE_INFINITY

    const approveDownloads = models => {
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

    const reportProgress = progress => {
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
        const currentTime = now()
        if (currentTime - lastEmitTime < emitIntervalMs) return
        lastEmitTime = currentTime
        emit({
            status: 'downloading',
            model: `${String(modelCount)} models`,
            loaded,
            total: expectedBytes,
            progress: expectedBytes > 0 ? Math.min(99, (loaded / expectedBytes) * 100) : undefined
        })
    }

    const reportReady = () => {
        emit({
            status: 'ready',
            model: `${String(modelCount)} models`,
            loaded: expectedBytes,
            total: expectedBytes,
            progress: 100
        })
    }

    return {approveDownloads, reportProgress, reportReady}
}

/**
 * Drives one RAG warmup, reporting progress through `emit` and failures through `fail`.
 *
 * `warmup` is injected so tests exercise the reporting contract without downloading models.
 * Returns whether the warmup succeeded.
 */
export async function runWarmup({warmup, emit, fail}) {
    const reporter = createProgressReporter({emit})
    try {
        emit({status: 'starting', model: 'Gofer RAG'})
        await warmup({
            allowModelDownloads: reporter.approveDownloads,
            onDownloadProgress: reporter.reportProgress
        })
        reporter.reportReady()
        return true
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
        return false
    }
}
