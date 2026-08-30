function godotTarget(args) {
    const ops = Array.isArray(args.ops) ? args.ops.map(entry => entry?.op).filter(Boolean) : []
    if (ops.length === 0) return args.op
    if (ops.length === 1) return ops[0]
    const distinct = [...new Set(ops)]
    if (distinct.length === 1) return `${distinct[0]} ×${String(ops.length)}`
    return distinct.length > 3 ?
            `${distinct.slice(0, 3).join(', ')} +${String(distinct.length - 3)} more`
        :   distinct.join(', ')
}

function flatten(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
}

export function toolTarget(name, args) {
    const given = args ?? {}
    if (name === 'bash') return given.command
    if (name.startsWith('godot_')) return godotTarget(given)
    if (name === 'web_search') return given.query
    if (name === 'web_fetch') return given.url
    if (name === 'ask_user') {
        const labels =
            Array.isArray(given.sketches) ?
                given.sketches.map(sketch => sketch?.label).filter(Boolean)
            :   []
        if (labels.length > 0) return labels.join(' / ')
        return flatten(given.question ?? given.brief)
    }
    if (name === 'subagent') return flatten(given.prompt)
    return given.path
}

export function toolStepLine(name, args) {
    const target = toolTarget(name, args)
    const flat =
        target === undefined || target === null ? '' : String(target).replace(/\s+/gu, ' ').trim()
    return flat ? `${name}: ${flat}` : name
}
