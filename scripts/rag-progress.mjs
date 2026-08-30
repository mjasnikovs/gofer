export const EVENT_PREFIX = 'GOFER_RAG_EVENT:'

export function createProgressReporter({emit, now = Date.now, emitIntervalMs = 250}) {
    const fileProgress = new Map()
    const observedModels = new Set()
    let expectedBytes = 0
    let approvedModels = 0
    let lastEmitTime = Number.NEGATIVE_INFINITY

    const modelLabel = () => {
        const count = approvedModels || observedModels.size
        return `${String(count)} ${count === 1 ? 'model' : 'models'}`
    }

    const totalBytes = () =>
        expectedBytes > 0 ? expectedBytes : (
            [...fileProgress.values()].reduce((total, file) => total + file.total, 0)
        )

    const approveDownloads = models => {
        approvedModels = models.length
        expectedBytes = models.reduce((total, model) => total + model.expectedBytes, 0)
        emit({
            status: 'downloading',
            model: modelLabel(),
            loaded: 0,
            total: expectedBytes,
            progress: 0
        })
        return true
    }

    const reportProgress = progress => {
        if (progress.model) observedModels.add(progress.model)
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
        const total = totalBytes()
        emit({
            status: 'downloading',
            model: modelLabel(),
            loaded,
            total,
            progress: total > 0 ? Math.min(99, (loaded / total) * 100) : undefined
        })
    }

    const reportReady = () => {
        const total = totalBytes()
        emit({
            status: 'ready',
            model: modelLabel(),
            loaded: total,
            total,
            progress: 100
        })
    }

    return {approveDownloads, reportProgress, reportReady}
}

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
