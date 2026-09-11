import {isAbsolute, relative, resolve} from 'node:path'

/** The host call that tells the router what a read outside it showed the model. */
export const NOTED_READ_TOOL = 'noted_read'

/**
 * Tells the router about a read it never saw, so a save over the file is armed.
 *
 * The router fills `expectedHash` from a ledger of what it has shown the model, and a `read` runs
 * here, showing the file without the router hearing of it: 94 of 195 live runs read a script that
 * way, and every `file_conflict` a save ever met was over a file shown exactly so. A part of a
 * file is not the file — an offset, a limit, or a cut-off read leaves the model holding less than
 * a whole save would replace — so only a read that showed all of it arms one.
 *
 * The read answers only once the host has recorded it, so the model's next call finds the record
 * there; what the host says back changes nothing about what the read showed. The probe file and
 * the skills under `.gofer` are never saved through the router, so a read of those is not told.
 */
export function notesTheRead(tool, host, workspacePath) {
    if (!host) return tool
    return {
        ...tool,
        execute: async (id, params, signal, onUpdate, context) => {
            const answer = await tool.execute(id, params, signal, onUpdate, context)
            const path =
                wholeFileShown(params, answer) ? projectPath(workspacePath, params.path) : undefined
            if (path) await host.call(NOTED_READ_TOOL, {path}, signal).catch(() => undefined)
            return answer
        }
    }
}

function wholeFileShown(params, answer) {
    if (params?.offset !== undefined || params?.limit !== undefined) return false
    if (!Array.isArray(answer?.content) || answer.details?.truncation) return false
    if (answer.details?.entries !== undefined) return false
    return answer.content.some(part => part?.type === 'text')
}

function projectPath(workspacePath, path) {
    if (typeof path !== 'string') return undefined
    const named = path.replace(/^res:\/\//u, '')
    const inside = relative(workspacePath, resolve(workspacePath, named))
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return undefined
    const spelled = inside.split('\\').join('/')
    return spelled.startsWith('.gofer') ? undefined : spelled
}
