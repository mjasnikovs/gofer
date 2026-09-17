import assert from 'node:assert/strict'
import {test} from 'node:test'
import {parseArgs, pickTool, readDoor, requestFor, send, settingsPath} from './gofer-cli.mjs'

test('flags are read as JSON when they parse and as text otherwise', () => {
    const {positional, flags} = parseArgs([
        'godot_node',
        'inspect',
        '--path',
        'Player',
        '--count',
        '3',
        '--deep',
        '--names',
        '["a"]'
    ])
    assert.deepEqual(positional, ['godot_node', 'inspect'])
    assert.deepEqual(flags, {path: 'Player', count: 3, deep: true, names: ['a']})
})

test('a godot domain call is an ops list of one, spelled either way', () => {
    const domain = requestFor(parseArgs(['godot_scene', 'open', '--path', 'main.tscn']))
    assert.deepEqual(domain, {
        method: 'call',
        params: {tool: 'godot_scene', params: {ops: [{op: 'open', path: 'main.tscn'}]}}
    })
    const dotted = requestFor(parseArgs(['godot', 'scene.open', '--path', 'main.tscn']))
    assert.deepEqual(dotted.params.params, {ops: [{op: 'scene.open', path: 'main.tscn'}]})
})

test('--ops sends the list as given, and a flag wins over the same key in --params', () => {
    const list = requestFor(
        parseArgs([
            'godot_node',
            '--ops',
            '[{"op":"inspect","path":"A"},{"op":"inspect","path":"B"}]'
        ])
    )
    assert.equal(list.params.params.ops.length, 2)
    const merged = requestFor(
        parseArgs(['godot_node', 'inspect', '--path', 'A', '--params', '{"depth": 2, "path": "B"}'])
    )
    assert.deepEqual(merged.params.params.ops[0], {op: 'inspect', path: 'A', depth: 2})
})

test('a board write is signed, a board read is not, and the name comes from the flag first', () => {
    const env = {GOFER_OWNER: 'edgars'}
    const write = requestFor(parseArgs(['board', 'comment', '--id', '4', '--body', 'done']), env)
    assert.deepEqual(write.params.params, {op: 'comment', id: 4, body: 'done', owner: 'edgars'})
    const named = requestFor(
        parseArgs(['board', 'move', '--id', '4', '--status', 'ready', '--owner', 'claude']),
        env
    )
    assert.equal(named.params.params.owner, 'claude')
    const read = requestFor(parseArgs(['board', 'list']), env)
    assert.deepEqual(read.params.params, {op: 'list'})
    const unnamed = requestFor(parseArgs(['board', 'create', '--title', 'x']), {})
    assert.equal(unnamed.params.params.owner, 'terminal')
})

test('a tool with no operation is a usage error that names the fix', () => {
    assert.throws(() => requestFor(parseArgs(['godot_node'])), /gofer-cli tools godot_node/)
    assert.deepEqual(requestFor(parseArgs([])), {usage: true})
    assert.deepEqual(requestFor(parseArgs(['tools', 'godot_node'])), {
        method: 'tools',
        params: {},
        only: 'godot_node'
    })
})

test('the settings file is where Tauri keeps it, unless Gofer was pointed elsewhere', () => {
    assert.equal(
        settingsPath({}, 'linux', '/home/x'),
        '/home/x/.config/com.gofer.desktop/settings.json'
    )
    assert.equal(
        settingsPath({XDG_CONFIG_HOME: '/cfg'}, 'linux', '/home/x'),
        '/cfg/com.gofer.desktop/settings.json'
    )
    assert.equal(
        settingsPath({GOFER_APP_DATA_DIR: '/data'}, 'linux', '/home/x'),
        '/data/settings.json'
    )
    assert.equal(
        settingsPath({}, 'darwin', '/Users/x'),
        '/Users/x/Library/Application Support/com.gofer.desktop/settings.json'
    )
})

test('the door is read from the file, under its old name too, and the environment wins', () => {
    const read = () => JSON.stringify({door: {port: 5005, token: 'abc'}})
    assert.deepEqual(readDoor({}, read), {url: 'http://127.0.0.1:5005/door', token: 'abc'})
    const old = () => JSON.stringify({mcp: {port: 5005, token: 'abc'}})
    assert.deepEqual(readDoor({}, old), {url: 'http://127.0.0.1:5005/door', token: 'abc'})
    assert.deepEqual(
        readDoor({GOFER_DOOR_URL: 'http://h/door', GOFER_DOOR_TOKEN: 't'}, () => {
            throw new Error('not read')
        }),
        {url: 'http://h/door', token: 't'}
    )
    assert.throws(() => readDoor({}, () => JSON.stringify({})), /mints one/)
})

test('a refusal comes back as an error carrying the router failure', async () => {
    const fetchImpl = async (_url, init) => {
        const body = JSON.parse(init.body)
        assert.equal(init.headers.Authorization, 'Bearer t')
        assert.equal(body.method, 'call')
        return {
            ok: true,
            status: 200,
            json: async () => ({
                jsonrpc: '2.0',
                id: 1,
                error: {code: -32000, message: 'card_locked: no', data: {code: 'card_locked'}}
            })
        }
    }
    await assert.rejects(send({url: 'http://h/door', token: 't'}, 'call', {}, fetchImpl), error => {
        assert.equal(error.refusal.code, 'card_locked')
        return true
    })
    const ok = async () => ({
        ok: true,
        status: 200,
        json: async () => ({jsonrpc: '2.0', id: 1, result: {cards: []}})
    })
    assert.deepEqual(await send({url: 'http://h/door', token: 't'}, 'call', {}, ok), {cards: []})
    const refused = async () => ({ok: false, status: 401})
    await assert.rejects(
        send({url: 'http://h/door', token: 't'}, 'ping', {}, refused),
        /refused the token/
    )
})

test('one tool is picked out of the listing by name', () => {
    const answer = {tools: [{name: 'board'}, {name: 'godot_node'}]}
    assert.deepEqual(pickTool(answer, 'board'), {name: 'board'})
    assert.equal(pickTool(answer, undefined), answer)
    assert.throws(() => pickTool(answer, 'x'), /board, godot_node/)
})

test('--out and --owner are text even when they look like numbers', () => {
    const {flags} = parseArgs(['board', 'create', '--title', 'x', '--owner', '123', '--out', '7'])
    assert.equal(flags.owner, '123')
    assert.equal(flags.out, '7')
    assert.equal(
        requestFor({positional: ['board', 'create'], flags}, {}).params.params.owner,
        '123'
    )
})

test('a refusal exits 1 with the reason on stderr, and no arguments prints the usage', async () => {
    const {execFile} = await import('node:child_process')
    const {promisify} = await import('node:util')
    const run = promisify(execFile)
    const env = {...process.env, GOFER_DOOR_URL: 'http://127.0.0.1:9/door', GOFER_DOOR_TOKEN: 't'}
    await assert.rejects(
        run(process.execPath, ['scripts/gofer.mjs', 'board', 'list'], {env}),
        error => {
            assert.equal(error.code, 1)
            assert.match(error.stderr, /not answering/)
            return true
        }
    )
    const {stdout} = await run(process.execPath, ['scripts/gofer.mjs'], {env})
    assert.match(stdout, /gofer-cli tools/)
})
