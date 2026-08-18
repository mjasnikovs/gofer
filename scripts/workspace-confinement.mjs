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
    },
    {
        // A .gd file survives a raw write, which is exactly why the raw write is the wrong door: it
        // is silent. The language server is never told, so Godot goes on running the old script and
        // the next diagnostics pull answers about text that is no longer there; the editor's
        // filesystem is never rescanned; and the strict-typing rule, which reads the text of a
        // godot_script write, never sees this one at all. Every live sweep watched the agent edit a
        // script this way and then spend two more calls re-uploading the whole file to make the
        // editor notice.
        matches: path => extname(path) === '.gd',
        instead:
            'GDScript belongs to the language server. Change this one with godot_script edit, '
            + 'which anchors on the text you are replacing and answers with the diagnostics for '
            + 'what it wrote, or create it with godot_script save. A .gd written as text leaves '
            + 'Godot running the old code.'
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

/**
 * The nearest ancestor of a path that exists, with symlinks followed.
 *
 * Confinement has to resolve *something* real, because a symlink is only visible once it is walked
 * — and what is real about a file that does not exist yet is the directory it will be made in.
 * Only the immediate parent used to be tried, which refused every write into a directory the write
 * would have created: a blank project has no `assets/`, and the first file the agent put there came
 * back as Node's own `ENOENT … realpath` naming an absolute path the agent is not allowed to type.
 * The workspace root always exists, so the walk terminates.
 */
async function nearestExistingAncestor(root, path) {
    for (let candidate = path; candidate !== root; candidate = dirname(candidate)) {
        const resolved = await realpath(candidate).catch(() => undefined)
        if (resolved !== undefined) return resolved
    }
    // The walk stops at the root rather than at the filesystem's, and the root is already a
    // resolved directory that exists — the caller resolved it. Only a path inside it reaches here,
    // because one that is not was refused before this ran.
    return root
}

async function validateToolPath(workspacePath, path) {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0'))
        throw new Error('Tool paths must be non-empty strings')
    const root = await realpath(workspacePath)
    const target = resolve(root, path)
    if (!isInside(root, target)) throw new Error('Tool path is outside the workspace')
    const existing = await nearestExistingAncestor(root, target)
    if (!isInside(root, existing)) throw new Error('Tool path resolves outside the workspace')
}

/**
 * The failure a tool reports, with the worktree spelled the way the project spells it.
 *
 * The tools underneath answer with Node's errno text, and that text carries the absolute path of a
 * checkout whose directory name is a task id nobody typed. The agent then cannot find its own
 * mistake in the answer — one live run asked for `project.godod` and was told about
 * `/tmp/gofer-live-run/data/worktrees/019febce-0184-70f0-a295-c1bf6cd190b9/project.godod` — and the
 * one spelling the answer taught it is the one every other tool refuses.
 */
function inProjectTerms(workspacePath, error) {
    const message = error instanceof Error ? error.message : String(error)
    const spelled = message.split(`${workspacePath}/`).join('').split(workspacePath).join('.')
    if (spelled === message) throw error
    throw new Error(spelled)
}

function validateBashCommand(command) {
    if (typeof command !== 'string' || command.length === 0 || command.includes('\0'))
        throw new Error('Shell commands must be non-empty strings')
    // Every absolute path is refused, including one that points inside the worktree: a shell
    // command is a string, and no amount of parsing tells `/tmp/…/worktree/a.gd` from a path that
    // only starts that way. The refusal has to say that, because the one that said "must stay
    // inside the workspace" was answering an agent that had just typed its own worktree's absolute
    // path — true about the rule, and false about what it had done.
    //
    // What is refused is a path that *starts an argument*. A slash anywhere else in one is just a
    // slash: sed's separator, a `res://` inside a pattern, a division sign in a quoted string. The
    // rule used to fire on any quote followed by a slash, which made
    // `sed -i 's/a("/b("/g' scripts/main.gd` an absolute path — and there was no way to write it
    // that passed. The agent tried three times, dropping its `cd` and then quoting the filename,
    // and was told the same untrue thing each time.
    //
    // An argument begins at the start of the command, after whitespace, or after one of the shell's
    // own separators; a quote may open it. Those separators are also now refused ahead of a path,
    // so `cat >/etc/passwd` and `x |cat /etc/shadow` are caught where the older rule let them by.
    //
    // `(` is deliberately not one of them, though it opens a subshell: it is far more often the
    // character before a quote inside somebody's `sed` expression, which is the false refusal this
    // rule exists to have stopped making. A subshell that reaches out still has whitespace before
    // the path it reaches for — `$(cat /etc/passwd)` is caught by the space.
    //
    // The standard streams are taken out of the command before the rule reads it. They are the one
    // group of absolute paths that names no file: `/dev/null` swallows what it is given and the
    // rest are the process's own descriptors, so none of them is a way out of the worktree. They
    // had to be excused rather than tolerated, because `2>/dev/null` is the commonest thing anyone
    // writes in a shell and the refusal told the agent to spell it the way the project does — and
    // the null device has no project-relative spelling, so there was no command it could have sent
    // instead. Observed live: two turns lost on `pip install … 2>/dev/null`, then the agent stopped
    // discarding output at all. The names end at a word boundary, so `/dev/nullify` and `/dev/sda`
    // are still paths, and still refused.
    const probed = command.replace(
        /\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)(?![\w-])/gu,
        'standard-stream'
    )
    if (/(?:^|[\s=<>|;&])["']?(?:\.\.(?:[\\/]|$)|~(?:[\\/]|$)|\/)/u.test(probed))
        throw new Error(
            'Shell commands take paths relative to the workspace, and this one names an absolute '
                + 'path or one that climbs out. The shell already runs in the workspace root, so '
                + 'name the file the way the project does — scripts/mario.gd, not its full path.'
        )
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
            return tool
                .execute(id, resolved, signal, onUpdate, context)
                .catch(error => inProjectTerms(workspacePath, error))
        }
    }
}
