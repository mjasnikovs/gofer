import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {NodeExecutionEnv, createEditTool} from '@earendil-works/pi-agent-core/node'
import {confineTool, validateBashCommand} from './workspace-confinement.mjs'

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
        description: `Does ${name} things.`,
        execute: async (_id, params) => params
    }
}

const asRun = command => ({command, timeout: 120})

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
        await assert.rejects(
            tool.execute('4', {path: 'scripts/player.gd', text: 'extends Node'}),
            /godot_script edit/u
        )
        assert.deepEqual(await tool.execute('5', {path: 'notes/plan.md', text: 'x'}), {
            path: 'notes/plan.md',
            text: 'x'
        })
    }

    const reader = confineTool(fakeTool('read'), current.path)
    for (const path of ['scenes/level.tscn', 'scripts/player.gd']) {
        assert.deepEqual(await reader.execute('6', {path}), {path})
    }
})

test('refuses every way of writing a skill, and keeps reading one', async context => {
    const current = await workspace()
    context.after(current.remove)
    await mkdir(join(current.path, '.gofer', 'skills', 'tile-levels'), {recursive: true})
    const relative = '.gofer/skills/tile-levels/SKILL.md'
    const spellings = [
        relative,
        '.gofer/./skills/tile-levels/SKILL.md',
        '.gofer/x/../skills/tile-levels/SKILL.md',
        join(current.path, relative)
    ]

    for (const name of ['write', 'edit']) {
        const tool = confineTool(fakeTool(name), current.path)
        for (const path of spellings) {
            await assert.rejects(tool.execute('1', {path, text: 'mine now'}), /Skills tab/u)
        }
    }
    const shell = confineTool(fakeTool('bash'), current.path)
    for (const command of [
        `echo x > ${relative}`,
        `cat >${relative}`,
        'sed -i s/a/b/ .gofer/./skills/tile-levels/SKILL.md',
        'sed -i s/a/b/ .gofer/x/../skills/tile-levels/SKILL.md',
        `cat "${relative}"`,
        `dd of=${relative} if=/dev/stdin`,
        'tar -xzf skills.tgz -C.gofer/skills',
        'cp mine.md --target-directory=.gofer/skills/tile-levels'
    ]) {
        await assert.rejects(shell.execute('2', {command}), /skills directory/u)
    }

    assert.deepEqual(
        await shell.execute('3', {command: 'godot --headless --script .gofer/checks/boss.gd'}),
        asRun('godot --headless --script .gofer/checks/boss.gd')
    )

    const reader = confineTool(fakeTool('read'), current.path)
    for (const path of [relative, join(current.path, relative)]) {
        assert.deepEqual(await reader.execute('4', {path}), {path})
    }
    const writer = confineTool(fakeTool('write'), current.path)
    assert.deepEqual(await writer.execute('5', {path: 'my.gofer-notes.txt', text: 'x'}), {
        path: 'my.gofer-notes.txt',
        text: 'x'
    })
    assert.deepEqual(
        await shell.execute('6', {command: 'tar -czf out.tgz --exclude=build .gofer-notes'}),
        asRun('tar -czf out.tgz --exclude=build .gofer-notes')
    )
})

test('lets a write make the directories it needs', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('write'), current.path)

    assert.deepEqual(await tool.execute('1', {path: 'assets/sprites/mario.png', text: 'x'}), {
        path: 'assets/sprites/mario.png',
        text: 'x'
    })
    await assert.rejects(
        tool.execute('2', {path: '../outside/made/up.txt', text: 'x'}),
        /workspace/iu
    )
})

test('reports a missing file the way the project names it', async context => {
    const current = await workspace()
    context.after(current.remove)
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

    assert.deepEqual(await tool.execute('1', {command: 'npm test'}), asRun('npm test'))
    for (const command of [
        undefined,
        '',
        'bad\0command',
        'cat ../secret',
        'cat /etc/passwd',
        'cat ~/secret',
        'cat C:\\Users\\me\\.ssh\\id_rsa',
        'type C:/Users/me/secrets.txt',
        'true; cd other'
    ])
        await assert.rejects(tool.execute('2', {command}), /Shell|workspace/iu)
})

test('says on the bash tool itself that it cannot leave the workspace', async context => {
    const current = await workspace()
    context.after(current.remove)

    const bash = confineTool(fakeTool('bash'), current.path)
    assert.match(bash.description, /reach nothing outside it/u)
    assert.match(bash.description, /refused before the command runs/u)

    for (const name of ['read', 'write', 'edit'])
        assert.equal(
            confineTool(fakeTool(name), current.path).description,
            fakeTool(name).description
        )
})

test('lets a slash inside an argument be a slash', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    for (const command of [
        'sed -i \'s/add_theme_font_size("/add_theme_font_size_override("/g\' scripts/main.gd',
        'grep -n "res://scripts" scripts/main.gd',
        "awk -F/ '{print $1}' scripts/main.gd",
        'echo "speed = 100/2" >> scripts/notes.txt'
    ])
        assert.deepEqual(await tool.execute('1', {command}), asRun(command))
})

test('gives a shell command a deadline, so one that never returns cannot hold the turn', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    assert.deepEqual(await tool.execute('1', {command: 'npm run build'}), {
        command: 'npm run build',
        timeout: 120
    })

    for (const timeout of [5, 900])
        assert.deepEqual(await tool.execute('2', {command: 'godot --headless --import', timeout}), {
            command: 'godot --headless --import',
            timeout
        })
})

test('lets a command divide, which is not a path', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    for (const command of [
        'python3 -c "print(1 / 2)"',
        'python3 -c "print(math.sin(2 * math.pi * i / 44100))"',
        "awk '{print $1 / $2}' data.txt",
        'echo $((10 / 2))',
        'echo "a / b"'
    ])
        assert.deepEqual(await tool.execute('1', {command}), asRun(command))

    for (const command of [
        'python3 -c "print(7 // 2)"',
        'python3 -c "base = 180 if (x // 4 + y // 4) % 2 == 0 else 195"',
        'echo $((10 // 2))'
    ])
        assert.deepEqual(await tool.execute('3', {command}), asRun(command))

    for (const command of [
        'ls /',
        'cat /etc/shadow',
        'x=/etc/a echo hi',
        'echo hi | cat /etc/hosts',
        'cat //etc/passwd'
    ])
        await assert.rejects(tool.execute('2', {command}), /Shell|workspace/iu)

    for (const command of [
        'find / -name "*.pem"',
        'grep -r secret / ',
        'ls / | head',
        'du -sh / ',
        'cp -r / backup',
        'rm -rf / --no-preserve-root',
        'ls /\ncat notes.md'
    ])
        await assert.rejects(tool.execute('4', {command}), /Shell|workspace/iu)
})

test('lets a command throw output away the way every shell does', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    for (const command of [
        'pip install Pillow -q 2>/dev/null; python3 generate_assets.py',
        'ls assets/*.import 2>/dev/null || echo "none"',
        'npm test > /dev/null',
        'godot --headless 1>/dev/null 2>&1',
        'cat scripts/player.gd >/dev/stdout'
    ])
        assert.deepEqual(await tool.execute('1', {command}), asRun(command))

    for (const command of ['cat /dev/sda', 'cat /dev/nullify', 'cat /devious/secret'])
        await assert.rejects(tool.execute('2', {command}), /Shell|workspace/iu)
})

test('refuses a shell command that names what the editor owns', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    for (const command of [
        'cat > scenes/level_1.tscn << EOF',
        "sed -i '15a shape = x' scenes/level_1.tscn",
        'cp scenes/a.scn scenes/b.scn',
        'echo run/main_scene >> project.godot',
        'cat scenes/level_1.tscn'
    ])
        await assert.rejects(tool.execute('1', {command}), /godot_scene|godot_project/u)

    assert.deepEqual(
        await tool.execute('2', {command: 'cat scripts/player.gd'}),
        asRun('cat scripts/player.gd')
    )
    assert.deepEqual(await tool.execute('3', {command: 'ls scenes'}), asRun('ls scenes'))
})

test('refuses a shell command whose whole job is to wait', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    for (const command of ['sleep 5', 'sleep 0.5', 'sleep 2 && ls scripts', 'ls; sleep 1'])
        await assert.rejects(tool.execute('1', {command}), /godot_runtime wait/u)

    for (const command of [
        'timeout 5 ./run.sh',
        'cat scripts/sleep.gd',
        'grep -rn sleeper scripts'
    ])
        assert.deepEqual(await tool.execute('2', {command}), asRun(command))
})

test('lets git read a scene it can only ever read', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    for (const command of [
        'git diff --check && git diff --stat -- scripts/main.gd scripts/unit.gd main.tscn',
        'git diff -- scenes/level_1.tscn',
        'git log --oneline -- scenes/level_1.tscn',
        'git show HEAD:project.godot',
        'git blame scenes/level_1.tscn'
    ])
        assert.deepEqual(await tool.execute('1', {command}), asRun(command))

    for (const command of [
        'git diff && sed -i "s/a/b/" scenes/level_1.tscn',
        'git checkout -- scenes/level_1.tscn',
        'git apply patch.diff && cat scenes/level_1.tscn',
        'git status | tee scenes/level_1.tscn'
    ])
        await assert.rejects(tool.execute('2', {command}), /godot_scene|godot_project/u)

    for (const command of [
        'git show HEAD:project.godot > project.godot',
        'git diff -- scenes/level_1.tscn > scenes/level_2.tscn',
        'git log >> scenes/level_1.tscn',
        'git status\nsed -i "s/a/b/" scenes/level_1.tscn'
    ])
        await assert.rejects(tool.execute('3', {command}), /godot_scene|godot_project/u)

    for (const command of [
        'git diff --stat && git diff -- main.tscn | head -80',
        'git diff -- scenes/level_1.tscn | wc -l',
        'git log --oneline -- scenes/level_1.tscn | grep fix'
    ])
        assert.deepEqual(await tool.execute('4', {command}), asRun(command))

    for (const command of [
        'git diff --stat | grep -c . scenes/level_1.tscn',
        'git status && head -20 project.godot',
        'head -20 scenes/level_1.tscn'
    ])
        await assert.rejects(tool.execute('5', {command}), /godot_scene|godot_project/u)

    await assert.rejects(tool.execute('6', {command: 'git diff -- /etc/passwd'}), /absolute/u)

    for (const command of [
        'grep -rn "OldSaveSystem" --include="*.gd" --include="*.tscn" .',
        "grep -rln uid --include='*.tscn' scenes",
        'grep -rn Ticker --include=*.tscn .',
        'find . -type f -name "*.tscn" -not -path "./.godot/*"',
        'find . -name "*.gd" -o -name "*.tscn"',
        'grep -rn X --include="*.tscn" . > matches.txt',
        'find . -name "*.tscn" | wc -l',
        'grep -rn X --include="*.tscn" . | head -20'
    ])
        assert.deepEqual(await tool.execute('7', {command}), asRun(command))

    for (const command of [
        'grep -rn X --include="*.gd" . scenes/level_1.tscn',
        'grep -rn X --include="*.gd" . > scenes/level_1.tscn',
        'find . -name "*.tscn" -delete',
        'find . -name "*.tscn" -exec sed -i "s/a/b/" {} +',
        'find . -name "*.tscn" | xargs rm',
        'find . -name "*.tscn" -print0 | xargs -0 sed -i "s/a/b/"',
        'find . -name "*.tscn" | tee scenes.txt',
        'find . -name "*.tscn" | xargs cat'
    ])
        await assert.rejects(tool.execute('8', {command}), /godot_scene|godot_project/u)
})

function editing(workspacePath) {
    const tool = confineTool(createEditTool(), workspacePath)
    const context = {env: new NodeExecutionEnv({cwd: workspacePath})}
    return (path, oldText, newText) =>
        tool.execute('1', {path, edits: [{oldText, newText}]}, undefined, undefined, context)
}

test('answers a refused anchor with the region the file actually holds', async context => {
    const current = await workspace()
    context.after(current.remove)
    await writeFile(join(current.path, 'DESIGN.md'), '# Notes\n\n- first\n  - nested\n- second\n')
    const edit = editing(current.path)

    const refusal = await edit('DESIGN.md', '- first\n    - nested\n- second', '- only').then(
        () => '',
        error => error.message
    )

    assert.match(refusal, /Could not find the exact text in DESIGN\.md/u)
    assert.match(refusal, /Apart from whitespace it matches lines 3 to 5/u)
    assert.match(refusal, /- first\n {2}- nested\n- second/u)
    assert.equal(
        await readFile(join(current.path, 'DESIGN.md'), 'utf8'),
        '# Notes\n\n- first\n  - nested\n- second\n'
    )
})

test('leaves a refused anchor alone when the file holds no such region', async context => {
    const current = await workspace()
    context.after(current.remove)
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

    const unrelated = new Error('Could not edit file: DESIGN.md. Path is not a file.')
    assert.equal(
        await refusalFrom(refusing(unrelated), {path: 'DESIGN.md', edits: [{oldText: anchor}]}),
        unrelated
    )

    const fromString = await refusalFrom(refusing(miss), {
        path: 'DESIGN.md',
        edits: [{oldText: anchor}]
    })
    assert.match(fromString.message, /Apart from whitespace it matches lines 3 to 5/u)

    assert.equal(
        (await refusalFrom(refusing(new Error(miss)), {path: 'DESIGN.md', edits: []})).message,
        miss
    )

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
    assert.equal(await tool('read').execute('3', {path: 'DESIGN.md'}), 'ok')
    assert.equal(await tool('write').execute('4', {path: 'inside.txt', content: 'x'}), 'ok')
    assert.deepEqual(seen, ['read:DESIGN.md', 'write:inside.txt'])

    const nested = name =>
        confineTool({name, execute: () => Promise.resolve('ok')}, current.path, ['docs/spec.md'])
    for (const path of ['docs/spec.md', 'docs/./spec.md', 'docs/x/../spec.md']) {
        await assert.rejects(
            nested('write').execute('5', {path, content: 'x'}),
            /specification freezes docs\/spec\.md/u,
            path
        )
    }
})

test('names the token it refused, so a false positive is visible', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)

    // A sed or awk address opens on a slash and is not a path. It stays refused, because the
    // scanner cannot tell one from the other without parsing the shell — but a refusal that
    // repeats the whole rule and names nothing sends the caller looking at its filenames.
    //
    // Quoted, so this cannot be satisfied by echoing the command back: every one of these tokens
    // is already a substring of the command it came from.
    for (const [command, named] of [
        ['cat /etc/passwd', '/etc/passwd'],
        ['cat ~/secret', '~/secret'],
        ['cat ../secret', '../secret'],
        ['type C:/Users/me/secrets.txt', 'C:/Users/me/secrets.txt'],
        ["sed -n '/=== SUMMARY ===/,$p' notes.txt", "'/=== SUMMARY ===/,$p'"],
        ["awk '/SUMMARY/,0' notes.txt", "'/SUMMARY/,0'"],
        ["sed -n '/=== SUMMARY notes.txt", "'/=== SUMMARY notes.txt"]
    ]) {
        const refusal = await tool.execute('1', {command}).then(
            () => undefined,
            error => error.message
        )
        assert.ok(refusal !== undefined, `${command} was allowed`)
        assert.ok(
            refusal.includes(`\`${named}\``),
            `${command} was refused without naming ${named}`
        )
        assert.ok(!refusal.includes(command), `${command} was echoed back instead of named`)
    }
})

test('lets a command write scratch output to the temporary directory the OS gives it', async context => {
    const current = await workspace()
    context.after(current.remove)
    const tool = confineTool(fakeTool('bash'), current.path)
    const scratch = join(tmpdir(), 'gofer-probe.txt')

    for (const command of [
        `npm test > ${scratch}`,
        `godot --headless --import 2> ${scratch}`,
        `grep SUMMARY ${scratch}`,
        `rm ${scratch}`
    ])
        assert.deepEqual(await tool.execute('1', {command}), asRun(command))

    for (const command of [`cat /etc/passwd > ${scratch}`, `cp ${scratch} ~/keep.txt`])
        await assert.rejects(tool.execute('2', {command}), /Shell|workspace/iu)
})

test('takes the temporary directory from the OS rather than assuming it is /tmp', async context => {
    const current = await workspace()
    context.after(current.remove)

    // The regression this holds is a hardcoded `/tmp`. Windows hands out
    // C:\Users\me\AppData\Local\Temp, which that spelling refuses and this one allows — and the
    // reverse: a Linux `/tmp` is not a temporary path on a machine whose OS does not say so.
    const windows = 'C:\\Users\\me\\AppData\\Local\\Temp'
    assert.doesNotThrow(() => validateBashCommand(`npm test > ${windows}\\out.txt`, windows))
    assert.throws(() => validateBashCommand('npm test > /tmp/out.txt', windows), /workspace/iu)

    const linux = '/tmp'
    assert.doesNotThrow(() => validateBashCommand('npm test > /tmp/out.txt', linux))
    assert.throws(() => validateBashCommand(`npm test > ${windows}\\out.txt`, linux), /workspace/iu)

    assert.throws(() => validateBashCommand('cat /etc/passwd', linux), /workspace/iu)
    assert.throws(() => validateBashCommand('cat /tmpfoo/secret', linux), /workspace/iu)

    // A machine that names no temporary directory has none to allow, and the workspace is still
    // the workspace.
    for (const none of ['', null])
        assert.throws(() => validateBashCommand('npm test > /tmp/out.txt', none), /workspace/iu)
})

test('lets nothing climb out of the temporary directory it allowed', async context => {
    const current = await workspace()
    context.after(current.remove)

    // `path.isAbsolute` answers false for a Windows path on Linux, so no path-aware containment
    // check can span both spellings and the allowance is a prefix comparison. A prefix comparison
    // on its own reaches /root: every one of these starts with an allowed temporary root.
    const windows = 'C:\\Users\\me\\AppData\\Local\\Temp'
    for (const [command, root] of [
        ['cat /tmp/../root/.ssh/authorized_keys', '/tmp'],
        ['npm test > /tmp/../root/.ssh/authorized_keys', '/tmp'],
        ['cat /tmp/./../etc/shadow', '/tmp'],
        [`cat ${windows}\\..\\..\\..\\.ssh\\id_rsa`, windows],
        [`cat ${windows}/../secrets.txt`, windows]
    ])
        assert.throws(() => validateBashCommand(command, root), /workspace/iu, command)
})
