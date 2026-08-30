import {readFile, realpath} from 'node:fs/promises'
import {basename, dirname, extname, isAbsolute, normalize, relative, resolve, sep} from 'node:path'

import {nearMiss, refusedAnchorIndex} from './anchor-near-miss.mjs'
import {refuseFrozenShellWrite, refuseFrozenWrite} from './frozen-paths.mjs'

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
        matches: path => extname(path) === '.gd',
        instead:
            'GDScript belongs to the language server. Change this one with godot_script edit, '
            + 'which anchors on the text you are replacing and answers with the diagnostics for '
            + 'what it wrote, or create it with godot_script save. A .gd written as text leaves '
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

const EDITOR_OWNED_IN_SHELL = /\.(?:tscn|scn)(?![\w-])|(?:^|[\s"'/=])project\.godot(?![\w-])/u

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

export function validateBashCommand(command) {
    if (typeof command !== 'string' || command.length === 0 || command.includes('\0'))
        throw new Error('Shell commands must be non-empty strings')
    const probed = command.replace(
        /\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)(?![\w-])/gu,
        'standard-stream'
    )
    const measured = probed.replace(
        /([^\s|;&]+)([^\S\n]+)\/+([^\S\n]+)(?=[\w$([.])/gu,
        (whole, left, before, after, at, text) =>
            left.startsWith('-') || /(?:^|[|;&\n(])\s*$/u.test(text.slice(0, at)) ?
                whole
            :   `${left}${before}divided-by${after}`
    )
    if (
        /(?:^|[\s=<>|;&])["']?(?:\.\.(?:[\\/]|$)|~(?:[\\/]|$)|[A-Za-z]:(?:[\\/]|$)|\/)/u.test(
            measured
        )
    )
        throw new Error(
            'Shell commands take paths relative to the workspace, and this one names an absolute '
                + 'path or one that climbs out. The shell already runs in the workspace root, so '
                + 'name the file the way the project does — scripts/mario.gd, not its full path.'
        )
    if (/(?:^|[;&|]\s*)cd(?:\s|$)/u.test(command))
        throw new Error('Shell commands cannot change the workspace directory')
    if (SLEEPS.test(command))
        throw new Error(
            'Shell commands cannot sleep. Sleeping here stops this process while the game carries '
                + 'on unobserved, and costs a whole request to do nothing. Let the game advance '
                + 'with godot_runtime wait, which renders the frames before it answers — '
                + '{"op": "wait", "frames": 30} or {"op": "wait", "ms": 500}.'
        )
    if (namesTheSkillsDirectory(command))
        throw new Error(
            'Shell commands cannot name the skills directory. Skills are the instructions this '
                + "project gives you, and they are the user's to change, in the Skills tab. Read "
                + 'one with the read tool, at the location the skill list gave you.'
        )
    if (EDITOR_OWNED_IN_SHELL.test(withoutASearchGlob(command)) && !readsOnlyThroughGit(command))
        throw new Error(
            'Shell commands cannot name a scene or project.godot. Read one with the read tool, '
                + 'and change it with godot_scene, godot_node and godot_project, which write it '
                + 'through the editor that has it open.'
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
    + ' refused before the command runs.'

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
                validateBashCommand(params.command)
                refuseFrozenShellWrite(params.command, frozen)
                return tool.execute(id, withADeadline(params), signal, onUpdate, context)
            }
            const resolved = {...params, path: worktreePath(params.path)}
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
