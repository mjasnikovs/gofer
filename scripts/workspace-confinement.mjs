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
import {basename, dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path'

/**
 * The files the running editor owns, and the tool that edits each of them properly.
 *
 * A scene is not a document. The editor holds it in memory, and a `.tscn` written behind its back
 * makes it stop and ask the user which copy to keep — a modal dialog in a window the agent cannot
 * reach, which hangs the session until a person clicks it. When the text is also malformed, and
 * text a model wrote by hand usually is, the editor adds a second dialog about the parse error and
 * the scene is unopenable besides. Every one of these files has a Godot tool that edits it through
 * the editor, so the raw write is refused and the agent is told which tool to reach for instead.
 */
const EDITOR_OWNED = [
    {
        matches: path => ['.tscn', '.scn'].includes(extname(path)),
        instead:
            'Scenes belong to the running editor. Build this one with godot_scene create, '
            + 'godot_node create and godot_node set_property, then godot_scene save. A .tscn '
            + 'written as text makes the editor stop and ask which copy to keep.'
    },
    {
        matches: path => basename(path) === 'project.godot',
        instead:
            'project.godot belongs to the running editor. Use godot_project set_setting, '
            + 'set_input_action, set_autoload or set_plugin_enabled, which write it through the '
            + 'editor and keep its own copy in step.'
    }
]

/** Tools that put text on disk. Reading an editor-owned file is always fine. */
const WRITING_TOOLS = ['write', 'edit']

/**
 * An editor-owned file as a shell command spells it.
 *
 * A shell does not have to say what it is doing to a path, and no amount of parsing would tell a
 * `cat file` from a `cat > file`: a live agent, refused by the write tool, rebuilt a whole scene
 * with `cat > scenes/level_1.tscn << EOF` and patched it further with `sed -i`, leaving a file
 * Godot's own writer would never produce. So a command that names one of these is refused whatever
 * it meant to do with it — reading one is what the read tool is for.
 */
const EDITOR_OWNED_IN_SHELL = /\.(?:tscn|scn)(?![\w-])|(?:^|[\s"'/=])project\.godot(?![\w-])/u

function refuseEditorOwnedWrite(toolName, path) {
    if (!WRITING_TOOLS.includes(toolName)) return
    const owned = EDITOR_OWNED.find(entry => entry.matches(path))
    if (owned) throw new Error(`${path} cannot be written directly. ${owned.instead}`)
}

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
    if (EDITOR_OWNED_IN_SHELL.test(command))
        throw new Error(
            'Shell commands cannot name a scene or project.godot. Read one with the read tool, '
                + 'and change it with godot_scene, godot_node and godot_project, which write it '
                + 'through the editor that has it open.'
        )
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
            refuseEditorOwnedWrite(tool.name, resolved.path)
            return tool.execute(id, resolved, signal, onUpdate, context)
        }
    }
}
