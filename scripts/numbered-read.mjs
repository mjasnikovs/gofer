// The model counts lines badly. Asked for a breakpoint on a named line, it missed in 45 of 60
// trials reading raw text and in 0 of 60 reading numbered text; the bare number scored the same as
// `cat -n` padding and costs two tokens a line less (scripts/bench/lines-run.mjs).
// A blank line is its number alone: `45\t` reads as a line holding one tab, and the model quoted
// that tab back in an anchor the file could not match.
const TRUNCATION_NOTE = /\n\n\[Showing lines \d+-\d+ of \d+[^\n]*\]$/u
const LIMIT_NOTE = /\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/u
const NOT_A_LISTING =
    /^(?:\[Line \d+ is [^\n]*\]|Read image file \[image\/bmp\]\n\[Image omitted[^\n]*\])$/u

export const NUMBERED_NOTE = 'Each line is prefixed with its 1-indexed line number and a tab.'

/**
 * Numbers the lines of one read answer. The tool's own notes are recognised only where the tool
 * says it wrote one, so a file whose last line looks like a note is still numbered whole.
 */
export function numberLines(text, {from = 1, truncated = false, limited = false} = {}) {
    if (typeof text !== 'string' || text === '' || NOT_A_LISTING.test(text)) return text
    const note =
        (truncated && text.match(TRUNCATION_NOTE)?.[0])
        || (limited && text.match(LIMIT_NOTE)?.[0])
        || ''
    const body = text.slice(0, text.length - note.length).replace(/\n$/u, '')
    return (
        body
            .split('\n')
            .map((line, i) =>
                line.trim() === '' ? String(from + i) : `${String(from + i)}\t${line}`
            )
            .join('\n') + note
    )
}

export function withLineNumbers(tool) {
    return {
        ...tool,
        description: `${tool.description} ${NUMBERED_NOTE}`,
        execute: async (id, params, signal, onUpdate, context) => {
            const answer = await tool.execute(id, params, signal, onUpdate, context)
            if (
                !Array.isArray(answer?.content)
                || answer.content.some(part => part?.type === 'image')
            )
                return answer
            const offset = Number(params?.offset)
            const shape = {
                from: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1,
                truncated: Boolean(answer.details?.truncation),
                limited: params?.limit !== undefined
            }
            return {
                ...answer,
                content: answer.content.map(part =>
                    part?.type === 'text' ? {...part, text: numberLines(part.text, shape)} : part
                )
            }
        }
    }
}
