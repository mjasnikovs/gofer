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
            mutation = mutation.then(async () => {
                await persist(undefined)
                current = undefined
            })
            return mutation
        }
    }
}
