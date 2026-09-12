import {readFile, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, dirname, extname, isAbsolute, normalize, relative, resolve, sep} from 'node:path'

import {nearMiss, refusedAnchorIndex} from './anchor-near-miss.mjs'
import {refuseFrozenShellWrite, refuseFrozenWrite} from './frozen-paths.mjs'

const EDITOR_OWNED = [
    {
        matches: path => ['.tscn', '.scn'].includes(extname(path)),
        instead:
            'Scenes belong to the running editor. Build this one with scene.create, '
            + 'node.create_nodes and node.set_properties, then scene.save. A .tscn '
            + 'written as text makes the editor stop and ask which copy to keep.'
    },
    {
        matches: path => basename(path) === 'project.godot',
        instead:
            'project.godot belongs to the running editor. Use project.set_setting, '
            + 'project.set_input_action, project.set_autoload or project.set_plugin_enabled, '
            + 'which write it through the editor and keep its own copy in step.'
    },
    {
        matches: path => extname(path) === '.gd',
        instead:
            'GDScript belongs to the language server. Change this one with script.edit, '
            + 'which anchors on the text you are replacing and answers with the diagnostics for '
            + 'what it wrote, or create it with script.save. A .gd written as text leaves '
            + 'Godot running the old code.'
    },
    {
        matches: path => SKILLS_DIRECTORY.test(path),
        instead:
            "Skills are the instructions this project gives you, and they are the user's to "
            + 'change, in the Skills tab. Read one with the read tool; nothing writes one.'
    }
]

const SKILLS_DIRECTORY = /^\.gofer[\\/]+skills(?:[\\/]|$)/u

function namesTheSkillsDirectory(command) {
    return command
        .split(/[\s;&|<>"'()]+/u)
        .filter(token => token.includes('.gofer'))
        .flatMap(token => spellingsOf(token))
        .some(token => SKILLS_DIRECTORY.test(token))
}

function spellingsOf(token) {
    const spellings = [normalize(token)]
    for (let at = token.indexOf('.gofer'); at > 0; at = token.indexOf('.gofer', at + 1)) {
        spellings.push(normalize(token.slice(at)))
    }
    return spellings
}

const WRITING_TOOLS = ['write', 'edit']

/// Tools whose path is optional, because their subject is the project rather than a file.
/// Every other tool is refused without one: a read with no path is a malformed call.
const SEARCHING_TOOLS = ['grep']

const EDITOR_OWNED_IN_SHELL = /\.(?:tscn|scn)(?![\w-])|(?:^|[\s"'/=])project\.godot(?![\w-])/u

/// `cd` to somewhere still inside the workspace is a no-op the shell would have done anyway, and
/// refusing it costs a whole call. Only one that climbs out is refused — and by the time this runs,
/// a path under the workspace root has already been masked, so what is left is an escape.
const CHANGES_DIRECTORY = /(?:^|[;&|]\s*)cd(?:\s+(?:[~/]|\.\.)|\s*$)/u

const SLEEPS = /(?:^|[;&|]\s*)sleep(?:\s|$)/u

const READ_ONLY_GIT = /^\s*git\s+(?:diff|status|log|show|blame|ls-files)(?:\s|$)/u

const COMMAND_BREAK = /\|\||&&|[;&|\n\r]/u

const REDIRECTS = /[<>]/u

const READS_A_PIPE = /^\s*(?:head|tail|wc|grep|nl|cut|tr)(?:\s|$)/u

function readsOnlyThroughGit(command) {
    const parts = command.split(COMMAND_BREAK).filter(part => part.trim() !== '')
    return (
        parts.length > 0
        && parts.some(part => READ_ONLY_GIT.test(part))
        && parts.every(
            part =>
                (READ_ONLY_GIT.test(part)
                    || (READS_A_PIPE.test(part) && !EDITOR_OWNED_IN_SHELL.test(part)))
                && !REDIRECTS.test(part)
        )
    )
}

const ACTS_ON_WHAT_IT_FINDS =
    /(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fls|fprintf)(?:\s|$)/u
const SEARCH_PATTERN =
    /(?:--(?:include|exclude)(?:-dir)?|(?:^|\s)-(?:i?name|i?path|wholename|lname|regex))[=\s]+(?:"[^"]*"|'[^']*'|\S+)/gu

function withoutASearchGlob(command) {
    if (ACTS_ON_WHAT_IT_FINDS.test(command)) return command
    if (isHandedToAWriter(command)) return command
    return command.replace(SEARCH_PATTERN, ' ')
}

function isHandedToAWriter(command) {
    const [, ...downstream] = command.split(COMMAND_BREAK)
    return downstream.filter(part => part.trim() !== '').some(part => !READS_A_PIPE.test(part))
}

/// Any missing path, not only an absent one: a model spells an omitted optional field as null and
/// as '' too, and `res://` alone is the project root written the way the editor writes it.
function searchedPath(toolName, path) {
    const named = worktreePath(path)
    if (named === '' || named === undefined || named === null) {
        return SEARCHING_TOOLS.includes(toolName) ? '.' : named
    }
    return named
}

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

function worktreePath(path) {
    return typeof path === 'string' && path.startsWith('res://') ?
            path.slice('res://'.length)
        :   path
}

async function nearestExistingAncestor(root, path) {
    for (let candidate = path; candidate !== root; candidate = dirname(candidate)) {
        const resolved = await realpath(candidate).catch(() => undefined)
        if (resolved !== undefined) return resolved
    }
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
    return relative(root, target)
}

function inProjectTerms(workspacePath, error) {
    const message = error instanceof Error ? error.message : String(error)
    const spelled = message.split(`${workspacePath}/`).join('').split(workspacePath).join('.')
    if (spelled === message) throw error
    throw new Error(spelled)
}

const OPENS_A_SEARCH =
    /^\s*(?:(?:if|while|until|do|then|else|!)\s+)?(?:grep|egrep|fgrep|rg|ag)(?:\s|$)/u

/// Whether any pipeline in the command opens with a grep. One that opens a pipeline searches
/// files; one fed by a pipe filters output, which `godot --headless | grep FAIL` does all day.
function isASearch(command) {
    return command
        .split(/\|\||&&|[;&\n\r]/u)
        .some(chain => OPENS_A_SEARCH.test(chain.split('|')[0]))
}

/// Every refusal below names the tool that reads or writes the path. A search is neither, and a
/// model refused for `grep -n RunState project.godot DESIGN.md` was pointed at `read` and `godot`,
/// guessed again, and went back to the shell: seven refusals in one project after the grep tool
/// landed. So a refused search is told what it was, and which tool answers it.
const SEARCH_INSTEAD =
    ' This command is a search, and the grep tool is the one that answers it: it reads scenes, '
    + 'project.godot and every resource by pattern, and its context, countOnly and filesOnly '
    + "parameters stand in for grep's -C, -c and -l."

function refusal(command, message) {
    return new Error(isASearch(command) ? `${message}${SEARCH_INSTEAD}` : message)
}

const ESCAPES_THE_WORKSPACE =
    /(?:^|[\s=<>|;&])["']?(?:\.\.(?:[\\/]|$)|~(?:[\\/]|$)|[A-Za-z]:(?:[\\/]|$)|\/)/u

/// What a masked span is filled with. A word character, and the same width as what it replaced, so
/// every offset the scanner reports still points at the command the caller actually wrote.
const FILLER = 'x'

function blank(text, pattern) {
    return text.replace(pattern, match => FILLER.repeat(match.length))
}

/// The whole path that begins at a refused offset, quoted the way the command quoted it.
///
/// The scanner matches a separator and then the first character of a path, which is enough to
/// refuse and not enough to name. A refusal that repeats the rule and names nothing sends the
/// caller looking at its filenames: a sed address opens on a slash, and reads as a path to
/// everything except the person who wrote it.
function pathAt(command, index) {
    let start = index
    while (start < command.length && /[\s=<>|;&]/u.test(command[start])) start += 1
    const quote = command[start] === '"' || command[start] === "'" ? command[start] : undefined
    if (quote !== undefined) {
        const closed = command.indexOf(quote, start + 1)
        return command.slice(start, closed < 0 ? command.length : closed + 1)
    }
    let end = start
    while (end < command.length && !/[\s;&|<>]/u.test(command[end])) end += 1
    return command.slice(start, end)
}

/// Masks the paths that name the OS's own temporary directory, and only those.
///
/// Scratch output is not part of the project and does not belong in it: a benchmark's stdout
/// written into the worktree has to be remembered and deleted, and one that is forgotten is a file
/// the next commit carries. The directory is the OS's rather than a spelling, because `/tmp` is not
/// where Windows puts one.
///
/// Masked per token rather than by prefix. A prefix comparison calls `/tmp/../root/.ssh` a
/// temporary path, and `path.isAbsolute` answers false for a Windows path on Linux — so containment
/// is counted here, over the separators both platforms use.
function withoutTemporaryPaths(command, root) {
    if (typeof root !== 'string' || root === '') return command
    let masked = ''
    let at = 0
    for (;;) {
        const found = command.indexOf(root, at)
        if (found < 0) return masked + command.slice(at)
        let end = found + root.length
        while (end < command.length && !/[\s;&|<>"']/u.test(command[end])) end += 1
        const token = command.slice(found, end)
        masked +=
            command.slice(at, found)
            + (staysUnder(root, token) ? FILLER.repeat(token.length) : token)
        at = end
    }
}

/// Whether a token that opens with the temporary root stays inside it.
function staysUnder(root, token) {
    const rest = token.slice(root.length)
    if (rest !== '' && !/^[\\/]/u.test(rest)) return false
    let depth = 0
    for (const step of rest.split(/[\\/]+/u)) {
        if (step === '' || step === '.') continue
        if (step !== '..') {
            depth += 1
            continue
        }
        depth -= 1
        if (depth < 0) return false
    }
    return true
}

/// The workspace root is a path a command may name.
///
/// A model writes the absolute path of the project it was given constantly: it is what the skill
/// index and every error message hand it. Reading that as an escape refuses the call and teaches
/// nothing, because the shell already runs there. So the root is masked exactly the way the OS's
/// temporary directory is, and only for tokens that stay under it.
export function validateBashCommand(command, temporaryRoot = tmpdir(), workspaceRoot = undefined) {
    if (typeof command !== 'string' || command.length === 0 || command.includes('\0'))
        throw new Error('Shell commands must be non-empty strings')
    const probed = blank(command, /\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)(?![\w-])/gu)
    const scratched = withoutTemporaryPaths(
        workspaceRoot === undefined ? probed : withoutTemporaryPaths(probed, workspaceRoot),
        temporaryRoot
    )
    const measured = scratched.replace(
        /([^\s|;&]+)([^\S\n]+)\/+([^\S\n]+)(?=[\w$([.])/gu,
        (whole, left, before, after, at, text) =>
            left.startsWith('-') || /(?:^|[|;&\n(])\s*$/u.test(text.slice(0, at)) ?
                whole
            :   left
                + before
                + FILLER.repeat(whole.length - left.length - before.length - after.length)
                + after
    )
    const escaping = ESCAPES_THE_WORKSPACE.exec(measured)
    if (escaping !== null)
        throw refusal(
            command,
            `Shell commands take paths relative to the workspace, and \`${pathAt(command, escaping.index)}\` `
                + 'is an absolute path or one that climbs out. The shell already runs in the '
                + 'workspace root, so name the file the way the project does — scripts/mario.gd, '
                + 'not its full path. Scratch output can go in the temporary directory the OS '
                + 'gives you.'
        )
    if (CHANGES_DIRECTORY.test(measured))
        throw new Error(
            'Shell commands cannot leave the workspace. The shell already runs in its root, so a '
                + 'path is named from there — scripts/mario.gd, not its full path.'
        )
    if (SLEEPS.test(command))
        throw new Error(
            'Shell commands cannot sleep. Sleeping here stops this process while the game carries '
                + 'on unobserved, and costs a whole request to do nothing. Let the game advance '
                + 'with runtime.wait, which renders the frames before it answers — '
                + '{"op": "wait", "frames": 30} or {"op": "wait", "ms": 500}.'
        )
    if (namesTheSkillsDirectory(command))
        throw refusal(
            command,
            'Shell commands cannot name the skills directory. Skills are the instructions this '
                + "project gives you, and they are the user's to change, in the Skills tab. Read "
                + 'one with the read tool, at the location the skill list gave you.'
        )
    if (EDITOR_OWNED_IN_SHELL.test(withoutASearchGlob(command)) && !readsOnlyThroughGit(command))
        throw refusal(
            command,
            'Shell commands cannot name a scene or project.godot. Read one with the read tool, '
                + "and change it with the godot tool's scene, node and project operations, which "
                + 'write it through the editor that has it open.'
        )
}

async function withTheRegionTheFileHolds(workspacePath, toolName, params, error) {
    if (toolName !== 'edit') return error
    const message = error instanceof Error ? error.message : String(error)
    const index = refusedAnchorIndex(message)
    if (index === undefined) return error
    const anchor = params?.edits?.[index]?.oldText
    if (typeof anchor !== 'string' || anchor.length === 0) return error
    const content = await readFile(resolve(workspacePath, params.path), 'utf8').catch(
        () => undefined
    )
    if (content === undefined) return error
    const region = nearMiss(content, anchor)
    if (region === undefined) return error
    return new Error(`${message} ${region}`)
}

const BASH_IS_CONFINED =
    ' It runs in the project root and can reach nothing outside it: every path in the command is'
    + ' relative to that root, and an absolute path, or one that climbs out with .. or ~, is'
    + ' refused before the command runs. Scratch output is the exception: a path under the'
    + ' temporary directory the OS gives you is allowed, and nothing there is part of the project.'
    + " Searching files is the grep tool's job, not this one's: a shell grep over a scene,"
    + ' project.godot or a skill is refused.'

const SHELL_DEADLINE_SECONDS = 120

function withADeadline(params) {
    return params?.timeout === undefined ? {...params, timeout: SHELL_DEADLINE_SECONDS} : params
}

export function confineTool(tool, workspacePath, frozen = []) {
    return {
        ...tool,
        description:
            tool.name === 'bash' ? `${tool.description}${BASH_IS_CONFINED}` : tool.description,
        execute: async (id, params, signal, onUpdate, context) => {
            if (tool.name === 'bash') {
                validateBashCommand(params.command, undefined, workspacePath)
                refuseFrozenShellWrite(params.command, frozen)
                return tool.execute(id, withADeadline(params), signal, onUpdate, context)
            }
            const resolved = {...params, path: searchedPath(tool.name, params.path)}
            const named = await validateToolPath(workspacePath, resolved.path)
            refuseEditorOwnedWrite(tool.name, named)
            refuseFrozenWrite(tool.name, named, frozen)
            return tool
                .execute(id, resolved, signal, onUpdate, context)
                .catch(async error =>
                    inProjectTerms(
                        workspacePath,
                        await withTheRegionTheFileHolds(workspacePath, tool.name, resolved, error)
                    )
                )
        }
    }
}
