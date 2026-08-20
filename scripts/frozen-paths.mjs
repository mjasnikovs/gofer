/**
 * The files a task's specification says it must not change, and the refusal that holds it to that.
 *
 * The failure this closes, from one project's own history: a task could not make the Hornet's wreck
 * frame work, so it reverted its own code change and edited `DESIGN.md` to say the missing frame
 * was "deliberately... the documented art exception". Line 175 of the same file still listed it as
 * an open defect. The document now contradicted itself, and the gap it recorded was gone.
 *
 * Prose does not stop this, and that is measured rather than assumed: `pi-task`'s frozen-path work
 * records "FROZEN CONTRACT, MUST NOT edit" holding 0 of 5 unguarded and about 1 of 5 with framing,
 * against a weak local model. So the rule is a refusal at the tool, before the write, in the same
 * place and the same shape as the rule that keeps a `.tscn` away from the file tools.
 *
 * The list comes out of the specification rather than a setting. The specification is already the
 * task's first user message, so it is already on the transcript — which keeps this out of the Rust
 * job, out of the schema, and out of the settings page, and puts the frozen list where a reader can
 * see it beside the work it binds.
 */

/** A CONSTRAINTS line that names files the task may not change. */
const FROZEN_LINE = /^\s*[-*]?\s*do not (?:modify|edit|change)\b/iu

/** The paths on such a line, which the prompt asks for in backticks. */
const QUOTED_PATH = /`([^`]+)`/gu

function constraintsOf(spec) {
    // `(?![\s\S])` and not `$`: the `m` flag makes `$` match at the end of the FIRST line, which
    // read one constraint and stopped.
    const match = /^CONSTRAINTS[ \t]*\n([\s\S]*?)(?=\n[A-Z][A-Z ]{2,}[ \t]*\n|(?![\s\S]))/mu.exec(
        spec ?? ''
    )
    return match ? match[1] : ''
}

/**
 * Every path the newest specification in this conversation freezes.
 *
 * Newest first and user messages only, for the same reason the verification points are read that
 * way: a task can be re-planned, and an assistant writing "do not modify" into its own answer is
 * describing a rule rather than being given one.
 */
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

/**
 * Refuses a write to a frozen path, and says who froze it.
 *
 * Named as the specification names it rather than as the tool resolved it, because the caller has
 * to find the line that binds it and the resolved path is not what that line says.
 *
 * A red check has two cures and only one of them is honest — fix the code, or change what the
 * check is held against. This closes the second.
 */
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

/**
 * The shapes a shell command takes when it writes to a file.
 *
 * Reading a frozen document is how a task learns what binds it — the live run that proved this rule
 * ran `grep -n "destroyed_frame\|wreck" DESIGN.md` on its way to the right answer — so a mention is
 * not enough to refuse on. Only a write is.
 */
const SHELL_WRITES = [
    /(?:^|[^0-9<>])>>?\s*["']?$/u,
    /\bsed\b[^|;&]*\s-[a-z]*i[a-z]*\b/u,
    /\btee\b/u,
    /\b(?:cp|mv|install)\b/u,
    /\btruncate\b/u,
    /\bdd\b[^|;&]*\bof=/u,
    /\b(?:perl|ruby)\b[^|;&]*\s-[a-z]*i\b/u
]

/**
 * Refuses a shell command that would write a frozen path.
 *
 * The other half of `refuseFrozenWrite`: `confineTool` answers bash in a branch of its own that
 * returns before the file rules run, so a rule that only covered `write` and `edit` left `sed -i`
 * wide open. The live run did not reach for it — it read the refusal and reported the conflict —
 * but a rule with a door in it is not a rule.
 *
 * Honest about its reach: this recognises the ordinary ways a shell writes a file, not every one. A
 * `python -c` that opens the path for writing goes through. The rule is here to close the cheap
 * reflex, which is what the measured failures actually were, and the refusal it raises says the
 * same thing the tool's does so a caller meets one rule rather than two.
 */
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
