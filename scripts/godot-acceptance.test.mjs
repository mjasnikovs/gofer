import assert from 'node:assert/strict'
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {createServer, createConnection} from 'node:net'
import {tmpdir} from 'node:os'
import {isAbsolute, join, resolve} from 'node:path'
import {spawn, spawnSync} from 'node:child_process'
import test from 'node:test'

const binary = process.env.GOFER_GODOT_BINARY
if (!binary || !isAbsolute(binary)) {
    throw new Error('GOFER_GODOT_BINARY must be the absolute pinned Godot binary path')
}
const version = spawnSync(binary, ['--version'], {encoding: 'utf8'})
if (version.status !== 0 || !version.stdout.startsWith('4.7.1.stable')) {
    throw new Error('Godot acceptance tests require 4.7.1-stable')
}

async function availablePort() {
    const server = createServer()
    await new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    const port = address.port
    await new Promise((resolveClose, reject) =>
        server.close(error => (error ? reject(error) : resolveClose()))
    )
    return port
}

async function fixtureProject() {
    const path = await mkdtemp(join(tmpdir(), 'gofer-godot-'))
    await cp(resolve('fixtures/godot-project'), path, {recursive: true})
    return path
}

function startBridge(project, port) {
    const child = spawn(
        binary,
        [
            '--headless',
            '--path',
            project,
            '--script',
            'res://tests/bridge.gd',
            '--',
            `--port=${String(port)}`
        ],
        {stdio: ['ignore', 'pipe', 'pipe']}
    )
    let output = ''
    child.stdout.on('data', chunk => {
        output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
        output += chunk.toString()
    })
    return {child, output: () => output}
}

async function connect(port) {
    return new Promise((resolveConnect, reject) => {
        const deadline = Date.now() + 10_000
        const attempt = () => {
            const socket = createConnection({host: '127.0.0.1', port})
            socket.once('connect', () => resolveConnect(new ProtocolClient(socket)))
            socket.once('error', error => {
                socket.destroy()
                if (Date.now() >= deadline) {
                    reject(error)
                    return
                }
                setTimeout(attempt, 25)
            })
        }
        attempt()
    })
}

class ProtocolClient {
    constructor(socket) {
        this.socket = socket
        this.sequence = 1
        this.buffer = ''
        this.pending = new Map()
        socket.on('data', chunk => this.receive(chunk.toString()))
        socket.on('error', error => {
            for (const entry of this.pending.values()) entry.reject(error)
            this.pending.clear()
        })
    }

    receive(chunk) {
        this.buffer += chunk
        while (this.buffer.includes('\n')) {
            const boundary = this.buffer.indexOf('\n')
            const line = this.buffer.slice(0, boundary)
            this.buffer = this.buffer.slice(boundary + 1)
            if (!line) continue
            const payload = JSON.parse(line)
            const entry = this.pending.get(payload.id)
            if (!entry) continue
            this.pending.delete(payload.id)
            entry.resolve(payload)
        }
    }

    request(command, params = {}, protocolVersion = 1) {
        const id = `acceptance-${String(this.sequence++)}`
        return new Promise((resolveRequest, reject) => {
            this.pending.set(id, {resolve: resolveRequest, reject})
            this.socket.write(`${JSON.stringify({protocolVersion, id, command, params})}\n`)
        })
    }

    close() {
        this.socket.destroy()
    }
}

test('real Godot bridge accepts commands, persists mutation, reports errors, and reconnects', async context => {
    const project = await fixtureProject()
    context.after(() => rm(project, {recursive: true, force: true}))
    await writeFile(join(project, 'broken.gd'), 'extends Node\nfunc broken(\n')
    const port = await availablePort()
    let bridge = startBridge(project, port)
    context.after(() => bridge.child.kill())
    let client = await connect(port)
    context.after(() => client.close())

    const handshake = await client.request('handshake', {client: 'gofer', acceptedVersions: [1]})
    assert.ok(handshake.result, JSON.stringify(handshake))
    assert.equal(handshake.result.acceptedVersion, 1)
    assert.equal(
        (await client.request('open_project', {scene: 'res://main.tscn'})).result.root,
        'ProtocolFixture'
    )
    assert.equal((await client.request('read_scene_tree')).result.tree.name, 'ProtocolFixture')
    assert.equal(
        (await client.request('add_node', {name: 'Player', type: 'Node2D'})).result.type,
        'Node2D'
    )
    assert.deepEqual(
        (
            await client.request('set_property', {
                node: 'Player',
                property: 'position',
                value: [12, 34]
            })
        ).result.value,
        [12, 34]
    )
    assert.equal((await client.request('save_scene')).result.saved, true)
    assert.equal((await client.request('reload_scene')).result.root, 'ProtocolFixture')
    const tree = (await client.request('read_scene_tree')).result.tree
    assert.equal(tree.children.find(node => node.name === 'Player').type, 'Node2D')
    assert.equal((await client.request('run_scene')).result.output[0].message, 'Scene instantiated')
    assert.equal(
        (await client.request('validate_script', {path: 'res://broken.gd'})).error.code,
        'script_error'
    )
    assert.equal((await client.request('does_not_exist')).error.code, 'unsupported_command')
    const mismatch = await client.request('handshake', {}, 2)
    assert.equal(mismatch.error.code, 'unsupported_protocol_version')
    assert.deepEqual(mismatch.error.details.supportedVersions, [1])

    await client.request('disconnect')
    client.close()
    client = await connect(port)
    assert.equal((await client.request('handshake')).result.acceptedVersion, 1)
    await client.request('shutdown')
    await new Promise(resolveExit => bridge.child.once('exit', resolveExit))
    assert.match(bridge.output(), /SCRIPT ERROR: Parse Error/u)

    const scene = await readFile(join(project, 'main.tscn'), 'utf8')
    assert.match(scene, /Player/u)
    bridge = startBridge(project, port)
    client = await connect(port)
    assert.equal((await client.request('handshake')).result.server, 'godot')
    await client.request('shutdown')
})
