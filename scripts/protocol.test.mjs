import assert from 'node:assert/strict'
import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'

// Version 1 retired with the one-shot bridge it served; version 2 is the only wire contract left.
const root = new URL('../protocol/', import.meta.url)
const schemaNames = {
    v2: ['handshake', 'request', 'response', 'event', 'error', 'value']
}
const versions = Object.keys(schemaNames)

async function json(path) {
    return JSON.parse(await readFile(path, 'utf8'))
}

async function validators(version) {
    const ajv = new Ajv2020({allErrors: true, strict: true})
    const directory = new URL(`schemas/${version}/`, root)
    return Object.fromEntries(
        await Promise.all(
            schemaNames[version].map(async name => {
                const schema = await json(new URL(`${name}.schema.json`, directory))
                return [name, ajv.compile(schema)]
            })
        )
    )
}

async function fixturePaths(version, kind) {
    const directory = new URL(`fixtures/${version}/${kind}/`, root)
    return (await readdir(directory)).map(name => join(directory.pathname, name))
}

function schemaName(path) {
    return path.split('/').at(-1).split('-')[0]
}

test('all valid golden fixtures match their canonical schemas', async () => {
    for (const version of versions) {
        const schemas = await validators(version)
        const paths = await fixturePaths(version, 'valid')
        assert.ok(paths.length > 0, version)
        for (const path of paths) {
            const schema = schemas[schemaName(path)]
            assert.ok(schema, path)
            assert.equal(
                schema(await json(path)),
                true,
                `${path}: ${JSON.stringify(schema.errors)}`
            )
        }
    }
})

test('all invalid golden fixtures are rejected by their canonical schemas', async () => {
    for (const version of versions) {
        const schemas = await validators(version)
        for (const path of await fixturePaths(version, 'invalid')) {
            assert.equal(schemas[schemaName(path)](await json(path)), false, path)
        }
    }
})

test('every protocol v2 envelope kind and value shape has a valid fixture', async () => {
    const covered = new Set((await fixturePaths('v2', 'valid')).map(path => schemaName(path)))
    assert.deepEqual([...covered].sort(), [...schemaNames.v2].sort())
})

test('unsupported protocol v2 versions never match the frozen schemas', async () => {
    const schemas = await validators('v2')
    const paths = await fixturePaths('v2', 'unsupported')
    assert.ok(paths.length > 0)
    for (const path of paths) {
        const payload = await json(path)
        assert.equal(schemas[schemaName(path)](payload), false, path)
        assert.notEqual(payload.protocolVersion, 2, path)
    }
})
