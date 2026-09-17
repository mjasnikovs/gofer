// The terminal client of the agent door: one tool call per invocation, answered as JSON.
//
// It reads the door's port and token from Gofer's settings file, so a caller in any workspace
// reaches the Gofer that is open there with no configuration of its own. Everything here is pure
// but `send`, so a test can shape a request without a door to hit.

import {readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

const IDENTIFIER = 'com.gofer.desktop'
const DEFAULT_PORT = 47831
const DOOR_PATH = '/door'
/// Tools whose call is an `ops` list: the Godot domains, and `godot` with dotted names.
const GODOT_PREFIX = 'godot'

export const USAGE = `gofer — drive the open Gofer from a terminal

  gofer tools [name]                       every tool and its operations, or one tool's
  gofer <tool> <op> [--key value ...]      one operation
  gofer <tool> --ops '[{"op": …}, …]'      several operations in one call
  gofer godot <domain.op> [--key value]    the same, spelled the way the model spells it

Options
  --params '{…}'     parameters as one JSON object, merged under the flags
  --out <file>       write the answer there instead of stdout
  --owner <name>     the name a board write is signed with (default: GOFER_OWNER, then "terminal")
  --raw              print the answer unformatted

Values are read as JSON when they parse, and as text otherwise: --count 3, --flag true,
--names '["a","b"]', --scene main.tscn.

Environment
  GOFER_DOOR_URL, GOFER_DOOR_TOKEN   override the settings file
  GOFER_APP_DATA_DIR                 where the settings file is, when Gofer was started with it
`

/** Where Tauri keeps the settings for this identifier on each platform. */
export function settingsPath(env = process.env, platform = process.platform, home = homedir()) {
    if (env.GOFER_APP_DATA_DIR) return join(env.GOFER_APP_DATA_DIR, 'settings.json')
    if (platform === 'darwin')
        return join(home, 'Library', 'Application Support', IDENTIFIER, 'settings.json')
    if (platform === 'win32')
        return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), IDENTIFIER, 'settings.json')
    return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), IDENTIFIER, 'settings.json')
}

/** The door's address and token, from the environment first and the settings file second. */
export function readDoor(env = process.env, read = path => readFileSync(path, 'utf8')) {
    if (env.GOFER_DOOR_URL && env.GOFER_DOOR_TOKEN)
        return {url: env.GOFER_DOOR_URL, token: env.GOFER_DOOR_TOKEN}
    const path = settingsPath(env)
    let settings
    try {
        settings = JSON.parse(read(path))
    } catch (error) {
        throw new Error(`Gofer's settings could not be read at ${path}: ${error.message}`)
    }
    const door = settings.door ?? settings.mcp ?? {}
    const token = env.GOFER_DOOR_TOKEN ?? door.token
    if (!token) throw new Error(`No door token in ${path}; open Gofer once and it mints one`)
    const url = env.GOFER_DOOR_URL ?? `http://127.0.0.1:${door.port ?? DEFAULT_PORT}${DOOR_PATH}`
    return {url, token}
}

function jsonOrText(text) {
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

/** Splits argv into the positionals and the flags, reading each flag's value as JSON or text. */
export function parseArgs(argv) {
    const positional = []
    const flags = {}
    for (let index = 0; index < argv.length; index += 1) {
        const word = argv[index]
        if (!word.startsWith('--')) {
            positional.push(word)
            continue
        }
        const name = word.slice(2)
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
            flags[name] = true
            continue
        }
        flags[name] = jsonOrText(next)
        index += 1
    }
    return {positional, flags}
}

const OWN_FLAGS = new Set(['params', 'out', 'owner', 'raw', 'ops', 'help'])

/** The JSON-RPC body one invocation sends, or a usage error naming what is missing. */
export function requestFor({positional, flags}, env = process.env) {
    const [tool, op] = positional
    if (!tool || flags.help) return {usage: true}
    if (tool === 'tools') return {method: 'tools', params: {}, only: op}
    const given = Object.fromEntries(Object.entries(flags).filter(([name]) => !OWN_FLAGS.has(name)))
    const params = {
        ...given,
        ...(typeof flags.params === 'object' && flags.params ? flags.params : {})
    }
    const isGodot = tool === GODOT_PREFIX || tool.startsWith(`${GODOT_PREFIX}_`)
    let body
    if (flags.ops !== undefined) {
        if (!Array.isArray(flags.ops)) throw new Error('--ops takes a JSON list of operations')
        body = {ops: flags.ops}
    } else if (isGodot) {
        if (!op)
            throw new Error(
                `${tool} needs an operation: gofer ${tool} <op>, or gofer tools ${tool} to see them`
            )
        body = {ops: [{op, ...params}]}
    } else {
        if (!op) throw new Error(`${tool} needs an operation: gofer ${tool} <op>`)
        body = {op, ...params}
    }
    if (tool === 'board' && !body.owner && op !== 'list' && op !== 'read')
        body.owner = typeof flags.owner === 'string' ? flags.owner : (env.GOFER_OWNER ?? 'terminal')
    return {method: 'call', params: {tool, params: body}}
}

/** Narrows a `tools` answer to one tool when a name was given. */
export function pickTool(answer, only) {
    if (!only) return answer
    const tool = answer.tools.find(candidate => candidate.name === only)
    if (!tool) {
        const names = answer.tools.map(candidate => candidate.name).join(', ')
        throw new Error(`There is no tool ${only}; the door has ${names}`)
    }
    return tool
}

/** Posts one JSON-RPC message and answers with its result, or throws the refusal as an error. */
export async function send(door, method, params, fetchImpl = fetch) {
    let response
    try {
        response = await fetchImpl(door.url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${door.token}`},
            body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})
        })
    } catch (error) {
        throw new Error(
            `Gofer is not answering at ${door.url}; is it open? (${error.cause?.code ?? error.message})`
        )
    }
    if (response.status === 401) throw new Error(`The door at ${door.url} refused the token`)
    if (!response.ok) throw new Error(`The door answered ${response.status}`)
    const message = await response.json()
    if (message.error) {
        const failure = new Error(message.error.message)
        failure.refusal = message.error.data ?? null
        throw failure
    }
    return message.result
}
