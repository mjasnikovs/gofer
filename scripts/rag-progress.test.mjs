import assert from 'node:assert/strict'
import test from 'node:test'
import {createProgressReporter, runWarmup} from './rag-progress.mjs'

function setup() {
    const events = []
    let currentTime = 1_000
    const reporter = createProgressReporter({
        emit: event => events.push(event),
        now: () => currentTime
    })
    return {
        events,
        reporter,
        advance: milliseconds => {
            currentTime += milliseconds
        }
    }
}

test('approves downloads and aggregates expected model bytes', () => {
    const {events, reporter} = setup()

    assert.equal(reporter.approveDownloads([{expectedBytes: 400}, {expectedBytes: 600}]), true)
    assert.deepEqual(events, [
        {
            status: 'downloading',
            model: '2 models',
            loaded: 0,
            total: 1_000,
            progress: 0
        }
    ])
})

test('aggregates files without double counting and clamps excess bytes', () => {
    const {events, reporter, advance} = setup()
    reporter.approveDownloads([{expectedBytes: 200}])

    reporter.reportProgress({model: 'a', file: 'one', loaded: 40, total: 100})
    advance(250)
    reporter.reportProgress({model: 'a', file: 'two', loaded: 25, total: 100})
    advance(250)
    reporter.reportProgress({model: 'a', file: 'one', loaded: 120, total: 100})

    assert.deepEqual(
        events.slice(1).map(event => ({loaded: event.loaded, progress: event.progress})),
        [
            {loaded: 40, progress: 20},
            {loaded: 65, progress: 32.5},
            {loaded: 125, progress: 62.5}
        ]
    )
})

test('uses a completed file total when loaded bytes are absent', () => {
    const {events, reporter} = setup()
    reporter.approveDownloads([{expectedBytes: 100}])

    reporter.reportProgress({model: 'a', file: 'model.onnx', status: 'done', total: 100})

    assert.equal(events.at(-1).loaded, 100)
    assert.equal(events.at(-1).progress, 99)
})

test('throttles intermediate updates and always reports final readiness', () => {
    const {events, reporter, advance} = setup()
    reporter.approveDownloads([{expectedBytes: 100}])
    reporter.reportProgress({model: 'a', file: 'one', loaded: 10, total: 100})
    advance(100)
    reporter.reportProgress({model: 'a', file: 'one', loaded: 20, total: 100})
    reporter.reportReady()

    assert.equal(events.length, 3)
    assert.deepEqual(events.at(-1), {
        status: 'ready',
        model: '1 model',
        loaded: 100,
        total: 100,
        progress: 100
    })
})

test('a warm cache reports the models it loads rather than none at all', () => {
    const {events, reporter, advance} = setup()

    reporter.reportProgress({model: 'embedding', file: 'model.onnx', loaded: 250, total: 1_000})
    advance(250)
    reporter.reportProgress({model: 'reranker', file: 'model.onnx', loaded: 500, total: 1_000})
    reporter.reportReady()

    assert.deepEqual(events.at(-2), {
        status: 'downloading',
        model: '2 models',
        loaded: 750,
        total: 2_000,
        progress: 37.5
    })
    assert.deepEqual(events.at(-1), {
        status: 'ready',
        model: '2 models',
        loaded: 2_000,
        total: 2_000,
        progress: 100
    })
})

test('a successful warmup reports starting, download progress, and readiness', async () => {
    const events = []
    const failures = []

    const succeeded = await runWarmup({
        warmup: async ({allowModelDownloads, onDownloadProgress}) => {
            allowModelDownloads([{expectedBytes: 100}, {expectedBytes: 100}])
            onDownloadProgress({model: 'a', file: 'one', loaded: 50, total: 100})
        },
        emit: event => events.push(event),
        fail: message => failures.push(message)
    })

    assert.equal(succeeded, true)
    assert.deepEqual(failures, [])
    assert.deepEqual(events[0], {status: 'starting', model: 'Gofer RAG'})
    assert.equal(events[1].status, 'downloading')
    assert.equal(events[1].total, 200)
    assert.deepEqual(events.at(-1), {
        status: 'ready',
        model: '2 models',
        loaded: 200,
        total: 200,
        progress: 100
    })
})

test('a failing warmup reports the message and never claims readiness', async () => {
    const events = []
    const failures = []

    const succeeded = await runWarmup({
        warmup: async () => {
            throw new Error('the model host is unreachable')
        },
        emit: event => events.push(event),
        fail: message => failures.push(message)
    })

    assert.equal(succeeded, false)
    assert.deepEqual(failures, ['the model host is unreachable'])
    assert.equal(
        events.some(event => event.status === 'ready'),
        false
    )
})
