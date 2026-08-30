import {createInterface} from 'node:readline'

const request = JSON.parse(
    await new Promise(resolve => {
        const reader = createInterface({input: process.stdin})
        reader.once('line', line => {
            reader.close()
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

if (prompt?.text?.toLowerCase().includes('cancel')) {
    emit({type: 'text-delta', delta: 'Deterministic response'})
    setInterval(() => undefined, 1_000)
} else {
    const text = `Deterministic response · received ${String(imageCount)} image`
    emit({type: 'text-delta', delta: text})
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
