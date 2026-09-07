/**
 * TOOLING is the only research section that is a CLAIM ABOUT THE FUTURE: every other
 * section reports what a worker read, but a command is a promise that something will
 * run. A model that lists a plausible command costs the implementer a step that always
 * fails, and one that lists a flaky command costs it every retry the flake earns.
 *
 * So the section is executed before it is believed, and only what survived reaches
 * compose. The rewrite is a REPLACEMENT rather than an annotation, for the same reason
 * refutations are subtractive: compose reads TOOLING as the menu it may pick from.
 */

const HEADER = /^[A-Z][A-Z -]*$/u

/** `  <command>  <what it proves>` — the two-column shape every research worker emits. */
const COLUMNS = /\s{2,}/u

function sectionBody(text, name) {
    const lines = (text ?? '').split('\n')
    const at = lines.findIndex(line => line.trim() === name)
    if (at === -1) return null
    const rest = lines.slice(at + 1)
    const end = rest.findIndex(line => HEADER.test(line.trim()) && line.trim().length > 0)
    return {
        at,
        lines,
        body: end === -1 ? rest : rest.slice(0, end),
        end: end === -1 ? lines.length : at + 1 + end
    }
}

const isNote = line => line.startsWith('(') || line.startsWith('#')

/** Every command the TOOLING section names, without the column that explains it. */
export function extractToolingCommands(research) {
    const found = sectionBody(research, 'TOOLING')
    if (!found) return []
    const commands = []
    for (const raw of found.body) {
        const line = raw.trim()
        if (line.length === 0 || isNote(line)) continue
        const command = line.split(COLUMNS)[0].trim()
        if (command.length > 0 && !commands.includes(command)) commands.push(command)
    }
    return commands
}

/**
 * Put the verified list back where the claimed one was.
 *
 * An empty list is written as a sentence rather than left blank: compose is told to use
 * only what the research holds, and a blank section reads as "nothing was looked for".
 */
export function replaceToolingWithVerified(research, verified) {
    const found = sectionBody(research, 'TOOLING')
    if (!found) return research
    const body =
        verified.length > 0 ?
            verified.map(line => `  ${line.trim()}`)
        :   ['  (none — every command this task named failed when it was run)']
    return [...found.lines.slice(0, found.at + 1), ...body, ...found.lines.slice(found.end)].join(
        '\n'
    )
}

/** The child's verdict, as two lists. Anything it did not classify is not verified. */
export function parseVerifyToolingOutput(text) {
    const pick = name =>
        (sectionBody(text, name)?.body ?? [])
            .map(line => line.trim())
            .filter(line => line.length > 0 && !isNote(line))
    return {verified: pick('VERIFIED'), rejected: pick('REJECTED')}
}
