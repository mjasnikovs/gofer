/**
 * Pi credential storage whose durable half belongs to Gofer's Rust keyring boundary.
 *
 * A worker lives for one turn, so memory alone cannot own a rotating OAuth refresh token. Every
 * mutation is sent to Rust and acknowledged before Pi continues. The promise chain is the store's
 * per-process serialization; Rust admits only one AI turn at a time and refuses login alongside it.
 */
export function createCredentialStore(initialCredential, persist) {
    let current = initialCredential
    let mutation = Promise.resolve()

    return {
        async read(providerId) {
            return providerId === 'openai-codex' ? current : undefined
        },
        async list() {
            return current ? [{providerId: 'openai-codex', type: current.type}] : []
        },
        modify(providerId, change) {
            if (providerId !== 'openai-codex') return Promise.resolve(undefined)
            mutation = mutation.then(async () => {
                const next = await change(current)
                if (next === undefined) return current
                await persist(next)
                current = next
                return current
            })
            return mutation
        },
        delete(providerId) {
            if (providerId !== 'openai-codex') return Promise.resolve()
            // On the same chain as a modify, so a delete cannot overtake a refresh that is still
            // being written and leave the keyring holding the token Pi has already discarded.
            mutation = mutation.then(async () => {
                await persist(undefined)
                current = undefined
            })
            return mutation
        }
    }
}
