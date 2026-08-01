import assert from 'node:assert/strict'
import test from 'node:test'
import {createProgressReporter} from './rag-progress.mjs'

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
        model: '1 models',
        loaded: 100,
        total: 100,
        progress: 100
    })
})
