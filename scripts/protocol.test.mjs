import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import {ProtocolError, requireSupportedProtocolVersion} from './protocol.mjs'

const root = new URL('../protocol/', import.meta.url)
const schemaDirectory = new URL('schemas/', root)
const fixtureDirectory = new URL('fixtures/', root)
const schemaNames = ['request', 'response', 'event', 'error']

async function json(path) {
    return JSON.parse(await readFile(path, 'utf8'))
}

async function validators() {
    const ajv = new Ajv2020({allErrors: true, strict: true})
    return Object.fromEntries(
        await Promise.all(
            schemaNames.map(async name => {
                const schema = await json(new URL(`${name}.schema.json`, schemaDirectory))
                return [name, ajv.compile(schema)]
            })
        )
    )
}

async function fixturePaths(kind) {
    const directory = new URL(`${kind}/`, fixtureDirectory)
    return (await readdir(directory)).map(name => join(directory.pathname, name))
}

test('all valid golden fixtures match their canonical schemas', async () => {
    const schemas = await validators()
    for (const path of await fixturePaths('valid')) {
        const name = path.split('/').at(-1).split('-')[0]
        assert.equal(
            schemas[name](await json(path)),
            true,
            `${path}: ${JSON.stringify(schemas[name].errors)}`
        )
    }
})

test('all invalid golden fixtures are rejected by their canonical schemas', async () => {
    const schemas = await validators()
    for (const path of await fixturePaths('invalid')) {
        const name = path.split('/').at(-1).split('-')[0]
        assert.equal(schemas[name](await json(path)), false, path)
    }
})

test('unsupported versions are rejected before dispatch with a structured error', async () => {
    const [path] = await fixturePaths('unsupported')
    const payload = await json(path)
    assert.throws(
        () => requireSupportedProtocolVersion(payload),
        error => {
            assert.ok(error instanceof ProtocolError)
            assert.deepEqual(error.toPayload(payload.id), {
                protocolVersion: 1,
                id: 'request-8',
                error: {
                    code: 'unsupported_protocol_version',
                    message: 'Protocol version 2 is not supported',
                    details: {supportedVersions: [1]}
                }
            })
            return true
        }
    )
})
