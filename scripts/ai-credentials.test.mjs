import assert from 'node:assert/strict'
import test from 'node:test'
import {createCredentialStore} from './ai-credentials.mjs'

test('persists refreshed ChatGPT credentials before exposing them', async () => {
    const persisted = []
    const initial = {type: 'oauth', access: 'old', refresh: 'refresh', expires: 1}
    const store = createCredentialStore(initial, async credential => persisted.push(credential))
    const refreshed = {type: 'oauth', access: 'new', refresh: 'refresh', expires: 2}

    await store.modify('openai-codex', () => refreshed)

    assert.deepEqual(await store.read('openai-codex'), refreshed)
    assert.deepEqual(persisted, [refreshed])
})

test('ignores other providers and can clear the ChatGPT credential', async () => {
    const persisted = []
    const initial = {type: 'oauth', access: 'old', refresh: 'refresh', expires: 1}
    const store = createCredentialStore(initial, async credential => persisted.push(credential))

    await store.modify('another-provider', () => ({type: 'api_key', key: 'secret'}))
    await store.delete('openai-codex')

    assert.equal(await store.read('openai-codex'), undefined)
    assert.deepEqual(await store.list(), [])
    assert.deepEqual(persisted, [undefined])
})
