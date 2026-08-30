export function piThinkingLevel(level, model = {}) {
    if (level === 'on') return 'medium'
    const chosen = level || 'off'
    if (chosen !== 'off' || !model.reasoningMandatory) return chosen
    return leastEffort(model.thinkingLevels)
}

function leastEffort(levels) {
    const named = new Set(levels ?? [])
    return KNOWN_EFFORTS.find(effort => named.has(effort)) ?? 'medium'
}

const KNOWN_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function piThinkingLevelMap(levels, offEffort) {
    const named = new Set(levels ?? [])
    if (named.size === 0) return undefined
    return Object.fromEntries([
        ...KNOWN_EFFORTS.map(effort => [effort, named.has(effort) ? effort : null]),
        ...(offEffort ? [['off', offEffort]] : [])
    ])
}
