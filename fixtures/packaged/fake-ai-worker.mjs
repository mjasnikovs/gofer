import {createInterface} from 'node:readline'

// The worker channel is duplex: Rust sends the startup context as the first line and keeps stdin
// open for tool results, so this fixture reads one line rather than waiting for end of input.
const request = JSON.parse(
    await new Promise(resolve => {
        const reader = createInterface({input: process.stdin})
        reader.once('line', line => {
            reader.close()
            // Rust holds stdin open for the whole turn. A worker that stays attached to it never
            // exits, and Rust reads this worker's stdout until end of file — so the turn would
            // never finish even after the done event.
            process.stdin.destroy()
            resolve(line)
        })
    })
)
const prompt = request.messages.at(-1)
const imageCount = prompt?.images?.length ?? 0

function emit(event) {
    process.stdout.write(`GOFER_AI_EVENT:${JSON.stringify(event)}\n`)
}

emit({type: 'text-delta', delta: 'Deterministic response'})

if (prompt?.text?.toLowerCase().includes('cancel')) {
    setInterval(() => undefined, 1_000)
} else {
    emit({
        type: 'tool-start',
        id: 'packaged-tool',
        name: 'write',
        target: 'fixture/main.tscn',
        startedAt: 1
    })
    emit({type: 'tool-update', id: 'packaged-tool', output: 'Saving deterministic fixture'})
    emit({
        type: 'tool-end',
        id: 'packaged-tool',
        output: 'Saved deterministic fixture',
        isError: false,
        endedAt: 2
    })
    const text = `Deterministic response · received ${String(imageCount)} image`
    emit({
        type: 'done',
        text,
        thinking: '',
        stopReason: 'stop',
        usage: {
            input: 4,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 7,
            cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}
        },
        model: 'gofer-packaged-test',
        agentMessages: [{role: 'assistant', content: [{type: 'text', text}]}]
    })
}
