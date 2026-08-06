/**
 * Keeps the agent's file and shell tools inside the active task worktree.
 *
 * Confinement is the whole safety story for these four tools, and deliberately so: bash is the one
 * explicit autonomous exception to the approval model in `src-tauri/src/approvals.rs`. Inside the
 * worktree it may do destructive work — `rm`, `git checkout`, a build that rewrites generated
 * files — with no prompt at all, even where the equivalent typed `godot_resource delete` would stop
 * and wait for the user. The worktree is the boundary that makes that acceptable: it is a Git
 * checkout of its own, so everything the shell can reach is recoverable, and nothing outside it can
 * be reached. A shell that asked for permission per command would be a shell the agent cannot use,
 * which is why the gate lives on typed operations rather than here.
 */

import {realpath} from 'node:fs/promises'
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path'

function isInside(root, path) {
    const difference = relative(root, path)
    return (
        difference === ''
        || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
    )
}

/**
 * The worktree path of a file the agent named the way Godot names it.
 *
 * `res://` is how the editor, the addon, and Gofer's own errors write a project path, so it is what
 * the agent writes back. Passing it through untouched resolved to a `res:/` directory that has
 * never existed, and the tool answered with a raw `ENOENT` about a path nobody typed.
 */
function worktreePath(path) {
    return typeof path === 'string' && path.startsWith('res://') ?
            path.slice('res://'.length)
        :   path
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
            if (tool.name === 'bash') {
                validateBashCommand(params.command)
                return tool.execute(id, params, signal, onUpdate, context)
            }
            const resolved = {...params, path: worktreePath(params.path)}
            await validateToolPath(workspacePath, resolved.path)
            return tool.execute(id, resolved, signal, onUpdate, context)
        }
    }
}
