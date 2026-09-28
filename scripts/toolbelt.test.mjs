import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import test from 'node:test'
import {temporaryWorkspace} from './ai-turn-harness.mjs'
import {NOTED_READ_TOOL} from './noted-read.mjs'
import {createToolbelt} from './toolbelt.mjs'

const FROZEN = ['DESIGN.md']

const SEAT_FILES = {
    parent: ['read', 'grep', 'write', 'edit', 'bash'],
    child: ['read', 'grep', 'bash']
}

const RUNS = 'runs'

const NOT_HELD = 'not held'

/// One call each, and what each seat answers it with: RUNS, NOT_HELD, or the refusal it meets.
const REFUSALS = [
    {call: 'read', params: {path: '../secret.txt'}, both: /outside the workspace/u},
    {call: 'bash', params: {command: 'cat ../secret.txt'}, both: /relative to the workspace/u},
    {call: 'bash', params: {command: 'sleep 5'}, both: /cannot sleep/u},
    {call: 'bash', params: {command: 'cat main.tscn'}, both: /cannot name a scene/u},
    {call: 'bash', params: {command: 'cat .gofer/skills/a/SKILL.md'}, both: /skills directory/u},
    {call: 'bash', params: {command: 'echo waived >> DESIGN.md'}, both: /freezes DESIGN\.md/u},
    {call: 'bash', params: {command: 'echo noted >> notes.md'}, both: RUNS},
    {call: 'read', params: {path: 'DESIGN.md'}, both: RUNS},
    {
        call: 'write',
        params: {path: 'DESIGN.md', content: 'waived'},
        parent: /freezes DESIGN\.md/u,
        child: NOT_HELD
    },
    {
        call: 'edit',
        params: {path: 'DESIGN.md', edits: [{oldText: 'contract', newText: 'waiver'}]},
        parent: /freezes DESIGN\.md/u,
        child: NOT_HELD
    },
    {
        call: 'write',
        params: {path: 'main.tscn', content: '[gd_scene]'},
        parent: /cannot be written directly/u,
        child: NOT_HELD
    },
    {
        call: 'slow',
        params: {},
        outlivesTheClock: true,
        parent: RUNS,
        child: /stopped after 60 seconds and produced no result\. Do not report it as finished/u
    }
]

function manualTimers() {
    const pending = new Set()
    return {
        schedule(fn) {
            pending.add(fn)
            return fn
        },
        cancel(handle) {
            pending.delete(handle)
        },
        fire() {
            for (const fn of [...pending]) fn()
        }
    }
}

function slowTool() {
    let release
    return {
        tool: {
            name: 'slow',
            description: 'Answers when released.',
            parameters: {type: 'object', properties: {}},
            execute: () =>
                new Promise(resolve => {
                    release = () => resolve({content: [{type: 'text', text: 'done'}], details: {}})
                })
        },
        release: () => release?.()
    }
}

async function seatWorkspace(context) {
    const workspace = await temporaryWorkspace(
        {'DESIGN.md': 'the contract\n', 'main.tscn': '[gd_scene]\n', 'a.gd': 'extends Node\n'},
        {'secret.txt': 'outside'}
    )
    context.after(workspace.remove)
    await mkdir(join(workspace.path, '.gofer', 'skills', 'a'), {recursive: true})
    await writeFile(join(workspace.path, '.gofer', 'skills', 'a', 'SKILL.md'), 'skill\n')
    return workspace
}

function beltFor(seat, workspacePath, context, extra = {}) {
    const timers = manualTimers()
    const slow = slowTool()
    const belt = createToolbelt({
        seat,
        workspacePath,
        files: SEAT_FILES[seat],
        reaching: [slow.tool],
        frozen: FROZEN,
        commandTimeoutMs: 60_000,
        timers,
        ...extra
    })
    context.after(() => belt.env.cleanup())
    return {...belt, timers, slow}
}

async function answer(belt, row) {
    const tool = belt.tools.find(one => one.name === row.call)
    if (!tool) return NOT_HELD
    const running = tool.execute(
        'call-1',
        row.params,
        new AbortController().signal,
        () => undefined
    )
    if (row.outlivesTheClock) {
        belt.timers.fire()
        belt.slow.release()
    }
    return running.then(
        () => RUNS,
        error => error.message
    )
}

test('which refusal applies to which seat', async context => {
    for (const seat of ['parent', 'child']) {
        const workspace = await seatWorkspace(context)
        const belt = beltFor(seat, workspace.path, context)
        for (const row of REFUSALS) {
            const expected = row.both ?? row[seat]
            const got = await answer(belt, row)
            const named = `${seat}: ${row.call} ${JSON.stringify(row.params)}`
            if (typeof expected === 'string') assert.equal(got, expected, named)
            else assert.match(got, expected, named)
        }
        assert.equal(await readFile(join(workspace.path, 'DESIGN.md'), 'utf8'), 'the contract\n')
    }
})

test('only the parent’s read is told to the router', async context => {
    const workspace = await seatWorkspace(context)
    for (const [seat, noted] of [
        ['parent', [{tool: NOTED_READ_TOOL, params: {path: 'a.gd'}}]],
        ['child', []]
    ]) {
        const calls = []
        const host = {call: async (tool, params) => calls.push({tool, params}) && {}}
        const belt = beltFor(seat, workspace.path, context, {host})
        await belt.tools.find(tool => tool.name === 'read').execute('call-1', {path: 'a.gd'})
        assert.deepEqual(calls, noted, seat)
    }
})

// A pin, not a preference: these bytes open every request, so a change here is a cache miss.
const FILE_TOOLS_READ_AS = '7fb9b4196bbc8e636b7561473bda22af35e94412c511c3d8404bebc988cf3474'

test('a seat changes nothing the model reads about a tool', async context => {
    const workspace = await seatWorkspace(context)
    const read = seat =>
        beltFor(seat, workspace.path, context).tools.map(({name, description, parameters}) => ({
            name,
            description,
            parameters
        }))
    const parent = read('parent')
    const child = read('child')

    assert.deepEqual(
        parent.map(tool => tool.name),
        [...SEAT_FILES.parent, 'slow']
    )
    assert.deepEqual(
        child,
        parent.filter(tool => SEAT_FILES.child.includes(tool.name) || tool.name === 'slow')
    )
    const files = parent.filter(tool => tool.name !== 'slow')
    const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    assert.equal(digest, FILE_TOOLS_READ_AS, 'the file tools read differently to the model')
})
