import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {NodeExecutionEnv, createEditTool} from '@earendil-works/pi-agent-core/node'
import {confineTool} from './workspace-confinement.mjs'

async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'gofer-confinement-'))
    const path = join(root, 'workspace')
    const outside = join(root, 'outside')
    await mkdir(path)
    await mkdir(outside)
    await mkdir(join(path, 'scenes'))
    await mkdir(join(path, 'scripts'))
    await writeFile(join(path, 'inside.txt'), 'inside')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(path, 'escape.txt'))
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

function fakeTool(name) {
    return {
        name,
        execute: async (_id, params) => params
    }
}

test('allows existing and new paths that remain in the workspace', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('read'), current.path)

    assert.deepEqual(await tool.execute('1', {path: 'inside.txt'}), {path: 'inside.txt'})
    assert.deepEqual(await tool.execute('2', {path: 'new.txt'}), {path: 'new.txt'})
    assert.deepEqual(await tool.execute('3', {path: '.'}), {path: '.'})
})

test('accepts the resource paths Godot names files by', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('read'), current.path)

    // The agent writes back the names it reads — the editor's, the addon's, and Gofer's own errors
    // all say `res://`. Untranslated they resolved to a `res:/` directory that never existed.
    assert.deepEqual(await tool.execute('1', {path: 'res://inside.txt'}), {path: 'inside.txt'})
    assert.deepEqual(await tool.execute('2', {path: 'res://new.txt', text: 'x'}), {
        path: 'new.txt',
        text: 'x'
    })
    await assert.rejects(tool.execute('3', {path: 'res://../outside/secret.txt'}), /workspace/iu)
})

test('rejects malformed, traversal, and escaping-symlink tool paths', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('read'), current.path)

    for (const path of [undefined, '', 'bad\0path', '../outside/secret.txt', 'escape.txt'])
        await assert.rejects(tool.execute('1', {path}), /path|workspace/iu)
})

test('refuses to let the raw file tools write what the editor owns', async context => {
    const current = await workspace()
    context.after(current.remove)

    for (const name of ['write', 'edit']) {
        const tool = confineTool(fakeTool(name), current.path)
        // Both of these hang the editor on a modal nobody can answer when they are written as text.
        await assert.rejects(
            tool.execute('1', {path: 'scenes/level.tscn', text: '[gd_scene]'}),
            /godot_scene/u
        )
        await assert.rejects(
            tool.execute('2', {path: 'res://scenes/level.scn', text: 'x'}),
            /godot_scene/u
        )
        await assert.rejects(
            tool.execute('3', {path: 'project.godot', text: 'x'}),
            /godot_project/u
        )
        // A .gd written this way survives, and that is the problem: the language server is never
        // told, so Godot keeps running the old code.
        await assert.rejects(
            tool.execute('4', {path: 'scripts/player.gd', text: 'extends Node'}),
            /godot_script edit/u
        )
        // Everything else the project holds is the agent's to write.
        assert.deepEqual(await tool.execute('5', {path: 'notes/plan.md', text: 'x'}), {
            path: 'notes/plan.md',
            text: 'x'
        })
    }

    // Reading one is how the agent finds out what is in it, and that stays allowed.
    const reader = confineTool(fakeTool('read'), current.path)
    for (const path of ['scenes/level.tscn', 'scripts/player.gd']) {
        assert.deepEqual(await reader.execute('6', {path}), {path})
    }
})

test('lets a write make the directories it needs', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('write'), current.path)

    // Observed live: a blank project has no `assets/`, the agent wrote its first file into one,
    // and confinement refused it before the write tool — which makes its own parents — ever ran.
    // The refusal was Node's own `ENOENT ... realpath '/tmp/…/worktrees/019…/assets'`, which names
    // no cause, suggests no next step, and spells the path the one way the shell tool forbids.
    assert.deepEqual(await tool.execute('1', {path: 'assets/sprites/mario.png', text: 'x'}), {
        path: 'assets/sprites/mario.png',
        text: 'x'
    })
    // A new directory that would leave the workspace is still refused, however deep it is.
    await assert.rejects(
        tool.execute('2', {path: '../outside/made/up.txt', text: 'x'}),
        /workspace/iu
    )
})

test('reports a missing file the way the project names it', async context => {
    const current = await workspace()
    context.after(current.remove)
    // What the underlying tool does to a path that is not there: Node's errno, absolute path and
    // all. The agent typed `project.godod`, and what came back named a directory it has never been
    // allowed to type — so it cannot see its own typo in the answer.
    const failing = {
        name: 'read',
        execute: async (_id, params) => {
            throw new Error(
                `ENOENT: no such file or directory, open '${join(current.path, params.path)}'`
            )
        }
    }
    const tool = confineTool(failing, current.path)

    const refusal = await tool.execute('1', {path: 'project.godod'}).then(
        () => '',
        error => error.message
    )
    assert.match(refusal, /project\.godod/u)
    assert.ok(
        !refusal.includes(current.path),
        `the failure spelled the worktree's absolute path: ${refusal}`
    )
})

test('leaves a failure that names no path exactly as the tool wrote it', async context => {
    const current = await workspace()
    context.after(current.remove)
    // Most failures are about the content rather than the file, and rewriting one is a chance to
    // damage it: this passes the tool's own error object through, not a copy of its message.
    const thrown = new Error('The file is not valid UTF-8')
    const tool = confineTool(
        {
            name: 'read',
            execute: async () => {
                throw thrown
            }
        },
        current.path
    )

    await assert.rejects(tool.execute('1', {path: 'inside.txt'}), error => error === thrown)
})

test('reads a rejection that is not an Error without losing the workspace path', async context => {
    const current = await workspace()
    context.after(current.remove)
    // A promise may be rejected with anything, and a string carrying the worktree's absolute path
    // has to be rewritten like any other — reading `.message` off it would find nothing at all.
    const tool = confineTool(
        {
            name: 'read',
            execute: () =>
                Promise.reject(
                    `EACCES: permission denied, open '${join(current.path, 'inside.txt')}'`
                )
        },
        current.path
    )

    const refusal = await tool.execute('1', {path: 'inside.txt'}).then(
        () => '',
        error => error.message
    )
    assert.equal(refusal, "EACCES: permission denied, open 'inside.txt'")
})

test('allows workspace shell commands and rejects every explicit escape form', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    assert.deepEqual(await tool.execute('1', {command: 'npm test'}), {command: 'npm test'})
    for (const command of [
        undefined,
        '',
        'bad\0command',
        'cat ../secret',
        'cat /etc/passwd',
        'cat ~/secret',
        'true; cd other'
    ])
        await assert.rejects(tool.execute('2', {command}), /Shell|workspace/iu)
})

test('lets a slash inside an argument be a slash', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    // Observed live, three turns in a row. Not one of these names a path outside the workspace —
    // the slashes are sed's own separators and the contents of a quoted string — and every one was
    // refused for naming an absolute path. The agent dropped its `cd`, then quoted the filename,
    // and got the same answer each time, because the answer was about something it had not done.
    for (const command of [
        'sed -i \'s/add_theme_font_size("/add_theme_font_size_override("/g\' scripts/main.gd',
        'grep -n "res://scripts" scripts/main.gd',
        "awk -F/ '{print $1}' scripts/main.gd",
        'echo "speed = 100/2" >> scripts/notes.txt'
    ])
        assert.deepEqual(await tool.execute('1', {command}), {command})
})

test('lets a command throw output away the way every shell does', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    // Observed live. `/dev/null` is an absolute path and the rule refuses every one of them, so
    // `2>/dev/null` — the commonest idiom there is — came back as "this one names an absolute path
    // or one that climbs out", advising the agent to name the file the way the project does. There
    // is no project-relative spelling of the null device, so the advice cannot be followed; the
    // agent dropped its `cd`, was refused again for the redirect it had not thought about, and gave
    // up on the command. None of these reaches a file: the null device swallows what it is given
    // and the standard streams are the process's own.
    for (const command of [
        'pip install Pillow -q 2>/dev/null; python3 generate_assets.py',
        'ls assets/*.import 2>/dev/null || echo "none"',
        'npm test > /dev/null',
        'godot --headless 1>/dev/null 2>&1',
        'cat scripts/player.gd >/dev/stdout'
    ])
        assert.deepEqual(await tool.execute('1', {command}), {command})

    // A real path under `/dev` is still a path out of the workspace, and still refused.
    for (const command of ['cat /dev/sda', 'cat /dev/nullify', 'cat /devious/secret'])
        await assert.rejects(tool.execute('2', {command}), /Shell|workspace/iu)
})

test('refuses a shell command that names what the editor owns', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    // Every one of these is a way a refused write came back as a shell command instead.
    for (const command of [
        'cat > scenes/level_1.tscn << EOF',
        "sed -i '15a shape = x' scenes/level_1.tscn",
        'cp scenes/a.scn scenes/b.scn',
        'echo run/main_scene >> project.godot',
        'cat scenes/level_1.tscn'
    ])
        await assert.rejects(tool.execute('1', {command}), /godot_scene|godot_project/u)

    // The rest of the project is the agent's to work with from a shell.
    assert.deepEqual(await tool.execute('2', {command: 'cat scripts/player.gd'}), {
        command: 'cat scripts/player.gd'
    })
    assert.deepEqual(await tool.execute('3', {command: 'ls scenes'}), {command: 'ls scenes'})
})

test('refuses a shell command whose whole job is to wait', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    // Thirteen of thirty shell calls in a live project were one of these, always between a change
    // and a look at what it did.
    for (const command of ['sleep 5', 'sleep 0.5', 'sleep 2 && ls scripts', 'ls; sleep 1'])
        await assert.rejects(tool.execute('1', {command}), /godot_runtime wait/u)

    // The word is not the rule: waiting on something else, or reading a file that is merely named
    // for it, is an ordinary command.
    for (const command of [
        'timeout 5 ./run.sh',
        'cat scripts/sleep.gd',
        'grep -rn sleeper scripts'
    ])
        assert.deepEqual(await tool.execute('2', {command}), {command})
})

test('lets git read a scene it can only ever read', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    // The command a live project sent, refused for naming a scene it could not have written to.
    for (const command of [
        'git diff --check && git diff --stat -- scripts/main.gd scripts/unit.gd main.tscn',
        'git diff -- scenes/level_1.tscn',
        'git log --oneline -- scenes/level_1.tscn',
        'git show HEAD:project.godot',
        'git blame scenes/level_1.tscn'
    ])
        assert.deepEqual(await tool.execute('1', {command}), {command})

    // One writing part anywhere in the chain puts the whole command back under the ordinary rule,
    // and a subcommand that is not on the list was never exempt.
    for (const command of [
        'git diff && sed -i "s/a/b/" scenes/level_1.tscn',
        'git checkout -- scenes/level_1.tscn',
        'git apply patch.diff && cat scenes/level_1.tscn',
        'git status | tee scenes/level_1.tscn'
    ])
        await assert.rejects(tool.execute('2', {command}), /godot_scene|godot_project/u)

    // Reading through git and writing through the shell is writing. A redirection is not an
    // operator this used to split on, and a newline is not one either, so all four of these were
    // exempted by the first version of this rule.
    for (const command of [
        'git show HEAD:project.godot > project.godot',
        'git diff -- scenes/level_1.tscn > scenes/level_2.tscn',
        'git log >> scenes/level_1.tscn',
        'git status\nsed -i "s/a/b/" scenes/level_1.tscn'
    ])
        await assert.rejects(tool.execute('3', {command}), /godot_scene|godot_project/u)

    // And git is not a way past the other rules: an absolute path is still an absolute path.
    await assert.rejects(tool.execute('4', {command: 'git diff -- /etc/passwd'}), /absolute/u)
})

/**
 * The three `edit` refusals of the measured week were all Markdown, and all of this tool — pi's,
 * not Gofer's. So these drive pi's real tool rather than a stub: what is being pinned is that the
 * region survives pi's own fuzzy pass, which strips trailing whitespace and leaves indentation
 * alone, and that the file is still on disk to be read when the refusal arrives.
 */
function editing(workspacePath) {
    const tool = confineTool(createEditTool(), workspacePath)
    const context = {env: new NodeExecutionEnv({cwd: workspacePath})}
    return (path, oldText, newText) =>
        tool.execute('1', {path, edits: [{oldText, newText}]}, undefined, undefined, context)
}

test('answers a refused anchor with the region the file actually holds', async context => {
    const current = await workspace()
    context.after(current.remove)
    // Indentation, which is the one thing pi's fuzzy pass does not forgive: it strips trailing
    // whitespace per line and folds Unicode, and leaves every leading tab and space exactly alone.
    await writeFile(join(current.path, 'DESIGN.md'), '# Notes\n\n- first\n  - nested\n- second\n')
    const edit = editing(current.path)

    const refusal = await edit('DESIGN.md', '- first\n    - nested\n- second', '- only').then(
        () => '',
        error => error.message
    )

    assert.match(refusal, /Could not find the exact text in DESIGN\.md/u)
    assert.match(refusal, /Apart from whitespace it matches lines 3 to 5/u)
    // The file's own bytes, at the file's own indentation — not the squeezed form the region was
    // found with, which would be unusable as the next anchor.
    assert.match(refusal, /- first\n {2}- nested\n- second/u)
    // And nothing was written, which is what makes the read above a read of the refusing text.
    assert.equal(
        await readFile(join(current.path, 'DESIGN.md'), 'utf8'),
        '# Notes\n\n- first\n  - nested\n- second\n'
    )
})

test('leaves a refused anchor alone when the file holds no such region', async context => {
    const current = await workspace()
    context.after(current.remove)
    // The worst anchor of the measured week: the model wrote the heading in bold. Squeezing
    // whitespace does not reach a content mistake, and this says so by adding nothing at all —
    // which is what held the false-positive count at zero over the same corpus.
    await writeFile(join(current.path, 'DESIGN.md'), '### The kit has no letters\n\nSilkscreen.\n')
    const edit = editing(current.path)

    const refusal = await edit('DESIGN.md', '**The kit has no letters**\n', '## Letters\n').then(
        () => '',
        error => error.message
    )

    assert.match(refusal, /Could not find the exact text in DESIGN\.md/u)
    assert.doesNotMatch(refusal, /Apart from whitespace/u)
})

test('names the index of the anchor it refused when a call carries several', async context => {
    const current = await workspace()
    context.after(current.remove)
    await writeFile(join(current.path, 'DESIGN.md'), '# Notes\n\n- first\n  - nested\n- second\n')
    const tool = confineTool(createEditTool(), current.path)
    const runtime = {env: new NodeExecutionEnv({cwd: current.path})}

    // pi writes a different sentence for a call of several, and the region has to be read for the
    // anchor it actually named rather than for the first one in the list.
    const refusal = await tool
        .execute(
            '1',
            {
                path: 'DESIGN.md',
                edits: [
                    {oldText: '# Notes', newText: '# Design'},
                    {oldText: '- first\n    - nested\n- second', newText: '- only'}
                ]
            },
            undefined,
            undefined,
            runtime
        )
        .then(
            () => '',
            error => error.message
        )

    assert.match(refusal, /Could not find edits\[1\] in DESIGN\.md/u)
    assert.match(refusal, /Apart from whitespace it matches lines 3 to 5/u)
})

test('leaves an edit refusal it cannot improve exactly as it arrived', async context => {
    const current = await workspace()
    context.after(current.remove)
    await writeFile(join(current.path, 'DESIGN.md'), '# Notes\n\n- first\n  - nested\n- second\n')
    const miss =
        'Could not find the exact text in DESIGN.md. The old text must match exactly '
        + 'including all whitespace and newlines.'
    const anchor = '- first\n    - nested\n- second'
    const refusing = thrown =>
        confineTool(
            {
                name: 'edit',
                execute: () => Promise.reject(thrown)
            },
            current.path
        )
    const refusalFrom = (tool, params) =>
        tool.execute('1', params).then(
            () => '',
            error => error
        )

    // A failure that is not a missing anchor is not this one's to touch, and it is passed through
    // as the object the tool threw rather than a copy of its message.
    const unrelated = new Error('Could not edit file: DESIGN.md. Path is not a file.')
    assert.equal(
        await refusalFrom(refusing(unrelated), {path: 'DESIGN.md', edits: [{oldText: anchor}]}),
        unrelated
    )

    // A promise may be rejected with anything, and the region is read for a string exactly as it
    // is for an Error.
    const fromString = await refusalFrom(refusing(miss), {
        path: 'DESIGN.md',
        edits: [{oldText: anchor}]
    })
    assert.match(fromString.message, /Apart from whitespace it matches lines 3 to 5/u)

    // A call whose shape does not carry the anchor the message names has nothing to look up.
    assert.equal(
        (await refusalFrom(refusing(new Error(miss)), {path: 'DESIGN.md', edits: []})).message,
        miss
    )

    // Nor has one whose file cannot be read. `edit` reaches a missing path the same way `write`
    // does, and a refusal about a file that is not there must not become a refusal about reading.
    assert.equal(
        (
            await refusalFrom(refusing(new Error(miss)), {
                path: 'GONE.md',
                edits: [{oldText: anchor}]
            })
        ).message,
        miss
    )
})

/**
 * The frozen list is enforced by the tool that would have written the file, not noticed afterwards.
 *
 * Prompt framing is measured insufficient for this class — `pi-task` records "FROZEN CONTRACT, MUST
 * NOT edit" holding 0 of 5 unguarded and about 1 of 5 with framing — so it is a refusal, in the
 * same place and shape as the rule that keeps a `.tscn` away from these tools.
 */
test('refuses a write to a path the task froze, and still reads it', async context => {
    const current = await workspace()
    context.after(current.remove)
    await writeFile(join(current.path, 'DESIGN.md'), '# Design\n')
    const seen = []
    const tool = name =>
        confineTool(
            {
                name,
                execute: (id, params) => {
                    seen.push(`${name}:${params.path}`)
                    return Promise.resolve('ok')
                }
            },
            current.path,
            ['DESIGN.md']
        )

    await assert.rejects(
        tool('edit').execute('1', {path: 'DESIGN.md', edits: []}),
        /specification freezes DESIGN\.md/u
    )
    await assert.rejects(
        tool('write').execute('2', {path: 'DESIGN.md', content: 'x'}),
        /never yours to make/u
    )
    // Reading is how a task learns what binds it. Only writing is refused.
    assert.equal(await tool('read').execute('3', {path: 'DESIGN.md'}), 'ok')
    // A file the specification did not name is untouched by the rule.
    assert.equal(await tool('write').execute('4', {path: 'inside.txt', content: 'x'}), 'ok')
    assert.deepEqual(seen, ['read:DESIGN.md', 'write:inside.txt'])
})
