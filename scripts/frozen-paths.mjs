const FROZEN_LINE = /^\s*[-*]?\s*do not (?:modify|edit|change)\b/iu

const QUOTED_PATH = /`([^`]+)`/gu

function constraintsOf(spec) {
    const match = /^CONSTRAINTS[ \t]*\n([\s\S]*?)(?=\n[A-Z][A-Z ]{2,}[ \t]*\n|(?![\s\S]))/mu.exec(
        spec ?? ''
    )
    return match ? match[1] : ''
}

export function frozenPathsIn(messages) {
    for (let index = (messages ?? []).length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!message || message.sender !== 'user') continue
        const frozen = []
        for (const line of constraintsOf(message.text ?? '').split('\n')) {
            if (!FROZEN_LINE.test(line)) continue
            for (const [, path] of line.matchAll(QUOTED_PATH)) {
                const trimmed = path.trim().replace(/^\.\//u, '')
                if (trimmed.length > 0 && !frozen.includes(trimmed)) frozen.push(trimmed)
            }
        }
        if (frozen.length > 0) return frozen
    }
    return []
}

export function refuseFrozenWrite(toolName, path, frozen) {
    if (toolName !== 'write' && toolName !== 'edit') return
    const named = frozen.find(entry => path === entry || path.endsWith(`/${entry}`))
    if (named === undefined) return
    throw new Error(
        `This task's specification freezes ${named} under CONSTRAINTS, so it cannot be written `
            + 'here. Change the code the specification describes instead. If the specification is '
            + 'wrong, say so and stop — rewriting what the work is measured against is the one '
            + 'repair that is never yours to make.'
    )
}

const SHELL_WRITES = [
    /(?:^|[^0-9<>])>>?\s*["']?$/u,
    /\bsed\b[^|;&]*\s-[a-z]*i[a-z]*\b/u,
    /\btee\b/u,
    /\b(?:cp|mv|install)\b/u,
    /\btruncate\b/u,
    /\bdd\b[^|;&]*\bof=/u,
    /\b(?:perl|ruby)\b[^|;&]*\s-[a-z]*i\b/u
]

export function refuseFrozenShellWrite(command, frozen) {
    const text = String(command ?? '')
    for (const entry of frozen) {
        const at = text.indexOf(entry)
        if (at < 0) continue
        const before = text.slice(0, at)
        if (!SHELL_WRITES.some(shape => shape.test(before))) continue
        throw new Error(
            `This task's specification freezes ${entry} under CONSTRAINTS, so a shell command `
                + 'cannot write it either. Change the code the specification describes instead. If '
                + 'the specification is wrong, say so and stop — rewriting what the work is '
                + 'measured against is the one repair that is never yours to make.'
        )
    }
}
