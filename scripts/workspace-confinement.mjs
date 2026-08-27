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

import {readFile, realpath} from 'node:fs/promises'
import {basename, dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path'

import {nearMiss, refusedAnchorIndex} from './anchor-near-miss.mjs'
import {refuseFrozenShellWrite, refuseFrozenWrite} from './frozen-paths.mjs'

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

/**
 * A command whose whole job is to wait.
 *
 * Thirteen of thirty shell calls in a live project were `sleep N`, always between a change and a
 * look at what it did. The shell is the wrong place for it twice over: it pauses the agent while
 * the game runs on unwatched, and every one of those is a whole round trip spent on nothing.
 * `godot_runtime wait` runs inside the game and answers once the frames are actually rendered.
 *
 * Matched only where sleeping is the command — at the start, or after a separator — so `timeout 5
 * ./run`, a script with the word in it, and `sleeper.gd` are all left alone.
 */
const SLEEPS = /(?:^|[;&|]\s*)sleep(?:\s|$)/u

/**
 * One `git` invocation that only ever reads.
 *
 * `EDITOR_OWNED_IN_SHELL` matches a scene's name wherever it appears, because a shell command does
 * not say what it is doing to a path. That is right for `sed` and wrong for `git diff -- main.tscn`,
 * which cannot write to anything: a live project sent exactly that and spent a turn rewriting it
 * after the refusal. An allow-list rather than a looser pattern — every subcommand here has no
 * writing form at all, so the guard stays as strict as it was for everything else.
 */
const READ_ONLY_GIT = /^\s*git\s+(?:diff|status|log|show|blame|ls-files)(?:\s|$)/u

/**
 * Every way a shell starts a second command, so a chain is judged part by part.
 *
 * A newline is one of them, and so is a redirection: `git log >> main.tscn` reads through git and
 * writes through the shell, and `git status\nsed -i … a.tscn` is two commands with no operator
 * between them. Both were exempted by a rule that split on `;`, `&`, `|` and their doubles alone.
 */
const COMMAND_BREAK = /\|\||&&|[;&|\n\r]/u

/** A part that sends its output somewhere. Reading through git is exempt; writing is never. */
const REDIRECTS = /[<>]/u

/**
 * A filter that reads its input and has no way to name a file to write.
 *
 * What a diff gets piped into. `git diff --stat && git diff -- main.tscn | head -80` was refused by
 * the first version of this rule, which asked every part to be git and found `head` — so a live
 * project spent a turn on a pager. Deliberately short, and every word on it earns its place: `sort`
 * and `uniq` both take an output file as an argument, `tee` is a writer, and `cat` is left off
 * because reading a scene as text is what the read tool is for whether git is in the chain or not.
 */
const READS_A_PIPE = /^\s*(?:head|tail|wc|grep|nl|cut|tr)(?:\s|$)/u

/**
 * Whether every part of this command reads through git and writes nothing.
 *
 * Judged part by part, because the command that was refused was two of them:
 * `git diff --check && git diff --stat -- scripts/main.gd main.tscn`. One part that writes anywhere
 * in a chain puts the whole command back under the ordinary rule, and a part that redirects writes
 * whatever git just read.
 *
 * A filter may sit in the chain, but only where it names no scene of its own: git is exempt because
 * of what it cannot do to a path it is given, and `grep something main.tscn` is not git.
 */
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

/**
 * A grep's file filter is not the name of a scene.
 *
 * `grep -rn "OldSaveSystem" --include="*.gd" --include="*.tscn" .` searches; it names no file, it
 * cannot write to one, and nothing else in this catalogue searches the *text* of a scene at all —
 * `godot_scene list` names them and `read` opens one. A live turn proving an autoload was dead
 * wrote exactly that command and was told to use the read tool, which cannot answer the question
 * it was asking. Two more in another turn, both grepping for a `uid` across two scenes.
 *
 * Only the glob. `grep -c . scenes/level_1.tscn` still names a scene and is still refused: reading
 * one as text is what the read tool is for, which is the line `READS_A_PIPE` already draws by
 * leaving `cat` off it. `--include` and `--exclude` belong to grep and rg and to nothing that
 * writes, and a redirect after one is still a redirect.
 */
function withoutASearchGlob(command) {
    return command.replace(/--(?:include|exclude)(?:-dir)?[=\s]+(?:"[^"]*"|'[^']*'|\S+)/gu, ' ')
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

export function validateBashCommand(command) {
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
    // Division is taken out of the command too, for the same reason. `1 / 2` opens an argument
    // with a slash exactly the way `/etc/passwd` does, and the rule refused both — so
    // `python3 -c "print(math.sin(2 * math.pi * i / 44100))"`, `awk '{print $1 / $2}'` and
    // `echo $((10 / 2))` were all told they named an absolute path. A live turn met it generating
    // a .wav and never got the file written. Python floors with two slashes, so the whole run of
    // them goes, not just the first: `x // 4` cost another live turn its PNG encoder twice over.
    //
    // What says arithmetic is an operand on *both* sides, on one line. Whitespace after the slash
    // was the rule for a while and it was not a rule at all — `find / -name "*.pem"`,
    // `grep -r secret / `, `ls / | head` and a `ls /` with a newline after it were every one of
    // them read as a division, and the turn could walk the whole filesystem from a rule written to
    // let it divide two numbers. A right-hand side that is a flag, a pipe, a newline or the end of
    // the command is not an operand; neither is a left-hand side that is a flag, and neither is
    // one that is the name of the command being run, because `find` is not a number.
    const measured = probed.replace(
        /([^\s|;&]+)([^\S\n]+)\/+([^\S\n]+)(?=[\w$([.])/gu,
        (whole, left, before, after, at, text) =>
            left.startsWith('-') || /(?:^|[|;&\n(])\s*$/u.test(text.slice(0, at)) ?
                whole
            :   `${left}${before}divided-by${after}`
    )
    // A drive letter is the Windows spelling of a leading slash. `cat C:\Users\me\.ssh\id_rsa`
    // named no `/` and walked straight out.
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
    if (EDITOR_OWNED_IN_SHELL.test(withoutASearchGlob(command)) && !readsOnlyThroughGit(command))
        throw new Error(
            'Shell commands cannot name a scene or project.godot. Read one with the read tool, '
                + 'and change it with godot_scene, godot_node and godot_project, which write it '
                + 'through the editor that has it open.'
        )
}

/**
 * A refused `edit` anchor, with the region the file actually holds added to it.
 *
 * The tool underneath is pi's, and its refusal names the file and the index and stops there —
 * `getNotFoundError` is handed a path and a number and never the content, so it could not say more
 * if it wanted to. The model that met it sent the identical call again rather than reading
 * anything, three times out of seven over the measured week, and was refused every time.
 *
 * Nothing was written when this runs: pi resolves every anchor in
 * `applyEditsToNormalizedContent` before it calls `writeFile`, so the file on disk is still the
 * one the anchors were matched against. A read here is a read of the text that refused them.
 *
 * Everything degrades to the original error — another tool, another failure, an unreadable file,
 * a call whose shape does not carry the anchor. A refusal that cannot be improved is passed
 * through, never replaced with a worse one.
 */
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

/**
 * The boundary, said where the model reads what a tool is for.
 *
 * pi's own descriptions say a path may be "relative or absolute", and for read, write and edit that
 * is true here — `validateToolPath` resolves an absolute path and keeps it if it lands inside the
 * worktree. For bash it is false, and pi's description says nothing at all about a boundary, so the
 * model finds out by being refused. One live turn spent a call on `find /tmp/…/worktree`, and the
 * measurement below spent eight of twenty.
 *
 * Measured with `scripts/bench-prompt-line.mjs`, twenty seeds an arm, arms interleaved inside one
 * process, run twice. Asked for something the project does not hold, so a wider search is a
 * reasonable thing to want, the shipped description wrote a command this rule refuses 8 of 20 and
 * then 7 of 20; with this sentence, **0 of 20 both times**. Asked for something the project does
 * hold, both arms wrote 0 of 20 — the sentence costs nothing where it is not needed.
 *
 * It is also what makes `godot_session status` safe to answer with the worktree's own path, which
 * it still does. Measured after this sentence landed, with the status answer as the turn's priming:
 * an answer carrying the path and one without it both produced 0 refused commands of 20, in both
 * scenarios. The path stopped mattering once the tool said where it may go.
 */
const BASH_IS_CONFINED =
    ' It runs in the project root and can reach nothing outside it: every path in the command is'
    + ' relative to that root, and an absolute path, or one that climbs out with .. or ~, is'
    + ' refused before the command runs.'

/**
 * How long a shell command may run before the turn takes its request back.
 *
 * pi's bash tool takes a timeout and defaults to none: "Timeout in seconds (optional, no default
 * timeout)". A model never sets one, so a command that does not return holds the turn until
 * something outside kills it. Watched live: `godot --headless --script scripts/main.gd` — an editor
 * with no `--quit`, which never exits — ran for **seventeen minutes** while the turn sat on it, and
 * the run had nothing else to show for its budget.
 *
 * Two minutes is chosen against what real commands cost in the recordings: the slowest honest one
 * is a headless import at 2.6 seconds, and a `godot --headless --run` the agent bounded itself was
 * given 5. Nothing legitimate is near this. A command that genuinely needs longer can still say so,
 * because the parameter is the model's and this only fills it in when it was left out.
 */
const SHELL_DEADLINE_SECONDS = 120

/** The same call, with a deadline on it when the caller named none. */
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
            await validateToolPath(workspacePath, resolved.path)
            refuseEditorOwnedWrite(tool.name, resolved.path)
            refuseFrozenWrite(tool.name, resolved.path, frozen)
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
