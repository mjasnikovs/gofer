import {realpath} from 'node:fs/promises'
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'

function isInside(root, path) {
    const difference = relative(root, path)
    return (
        difference === ''
        || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
    )
}

async function validateToolPath(workspacePath, path) {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0'))
        throw new Error('Tool paths must be non-empty strings')
    const root = await realpath(workspacePath)
    const target = resolve(root, path)
    if (!isInside(root, target)) throw new Error('Tool path is outside the workspace')
    const existing = await realpath(target).catch(async () => realpath(dirname(target)))
    if (!isInside(root, existing)) throw new Error('Tool path resolves outside the workspace')
}

function validateBashCommand(command) {
    if (typeof command !== 'string' || command.length === 0 || command.includes('\0'))
        throw new Error('Shell commands must be non-empty strings')
    if (/(^|[\s"'=])(?:\.\.(?:[\\/]|$)|~(?:[\\/]|$)|\/)/u.test(command))
        throw new Error('Shell command paths must stay inside the workspace')
    if (/(?:^|[;&|]\s*)cd(?:\s|$)/u.test(command))
        throw new Error('Shell commands cannot change the workspace directory')
}

export function confineTool(tool, workspacePath) {
    return {
        ...tool,
        execute: async (id, params, signal, onUpdate, context) => {
            if (tool.name === 'bash') validateBashCommand(params.command)
            else await validateToolPath(workspacePath, params.path)
            return tool.execute(id, params, signal, onUpdate, context)
        }
    }
}
