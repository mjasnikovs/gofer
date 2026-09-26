import assert from 'node:assert/strict'
import {chmod, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node'
import {
    DEFAULT_MATCH_LIMIT,
    LARGEST_SEARCHED_FILE_BYTES,
    MAX_LINE_CHARS,
    createGrepTool,
    isSkipped,
    pathsOf,
    matcherFor,
    suffixesOf,
    workspaceRelative
} from './ai-grep.mjs'

async function workspace(build) {
    const root = await mkdtemp(join(tmpdir(), 'gofer-grep-'))
    const path = join(root, 'workspace')
    await mkdir(path)
    if (build) await build(path)
    return {path, remove: () => rm(root, {recursive: true, force: true})}
}

function grepIn(workspacePath) {
    const env = new NodeExecutionEnv({cwd: workspacePath})
    const tool = createGrepTool()
    return async params => {
        const answer = await tool.execute('1', params, undefined, undefined, {env})
        return answer.content[0].text
    }
}

async function project(path) {
    await mkdir(join(path, 'scripts'))
    await mkdir(join(path, 'scenes'))
    await writeFile(
        join(path, 'scripts', 'player.gd'),
        'extends Node\n\nfunc hit() -> void:\n\thealth -= 1\n'
    )
    await writeFile(
        join(path, 'scripts', 'enemy.gd'),
        'extends Node\n\nfunc hit() -> void:\n\thealth = 0\n'
    )
    await writeFile(join(path, 'scenes', 'main.tscn'), '[node name="Main"]\nscript = "player.gd"\n')
}

test('formats a match as path:line: text', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'health -= 1'})

    assert.equal(text, 'scripts/player.gd:4: \thealth -= 1')
})

test('says so plainly when nothing matches', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    assert.equal(await grepIn(current.path)({pattern: 'nowhere'}), 'No matches found')
})

test('searches one file, one directory, or the whole project', async context => {
    const current = await workspace(project)
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal(
        (await grep({pattern: 'func hit', path: 'scripts/enemy.gd'})).split('\n').length,
        1
    )
    assert.equal((await grep({pattern: 'func hit', path: 'scripts'})).split('\n').length, 2)
    assert.equal((await grep({pattern: 'Node|Main'})).split('\n').length, 3)
})

test('names a path it cannot open', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    await assert.rejects(grepIn(current.path)({pattern: 'x', path: 'nope'}), /nope/u)
    await assert.rejects(
        grepIn(current.path)({pattern: 'x', path: 'scripts,scenes'}),
        /a list of them: \["scripts", "scenes"\]/u
    )
})

test('a list written as text is a list', () => {
    assert.deepEqual(pathsOf('["scripts", "scenes"]'), ['scripts', 'scenes'])
    assert.deepEqual(pathsOf('[not json'), ['[not json'])
    assert.deepEqual(pathsOf(['a', 'b']), ['a', 'b'])
})

test('keeps only the files the glob names', async context => {
    const current = await workspace(async path => {
        await project(path)
        await writeFile(join(path, 'scripts', 'LOUD.GD'), 'extends Node\n')
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal((await grep({pattern: 'Node|Main', glob: '*.gd'})).split('\n').length, 2)
    assert.equal((await grep({pattern: 'Node|Main', glob: '*.gd,*.tscn'})).split('\n').length, 3)
    assert.equal(
        await grep({pattern: 'Node', glob: '*.gd', path: 'scripts/LOUD.GD'}),
        'scripts/LOUD.GD:1: extends Node'
    )
})

test('ignores case only when asked', async context => {
    const current = await workspace(project)
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal(await grep({pattern: 'EXTENDS', path: 'scripts/player.gd'}), 'No matches found')
    assert.match(
        await grep({pattern: 'EXTENDS', path: 'scripts/player.gd', ignoreCase: true}),
        /extends/u
    )
})

test('escapes every regex character when literal is set', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'a.b\naxb\n')
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal((await grep({pattern: 'a.b'})).split('\n').length, 2)
    assert.equal(await grep({pattern: 'a.b', literal: true}), 'a.txt:1: a.b')
})

test('shows context each side once, merged where two matches share a line', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'one\ntwo\nhit\nfour\nhit\nsix\n')
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'hit', context: 1})

    assert.deepEqual(text.split('\n'), [
        'a.txt-2- two',
        'a.txt:3: hit',
        'a.txt-4- four',
        'a.txt:5: hit',
        'a.txt-6- six'
    ])
})

test('parts context groups with --, within a file and between files, as grep does', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'hit\na\nb\nc\nhit\n')
        await writeFile(join(path, 'b.txt'), 'hit\n')
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.deepEqual((await grep({pattern: 'hit', context: 1})).split('\n'), [
        'a.txt:1: hit',
        'a.txt-2- a',
        '--',
        'a.txt-4- c',
        'a.txt:5: hit',
        '--',
        'b.txt:1: hit'
    ])
    assert.deepEqual((await grep({pattern: 'hit'})).split('\n'), [
        'a.txt:1: hit',
        'a.txt:5: hit',
        'b.txt:1: hit'
    ])
})

test('before and after are separate, and each overrides context on its side', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'one\ntwo\nhit\nfour\nfive\n')
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.deepEqual((await grep({pattern: 'hit', after: 2})).split('\n'), [
        'a.txt:3: hit',
        'a.txt-4- four',
        'a.txt-5- five'
    ])
    assert.deepEqual((await grep({pattern: 'hit', before: 1})).split('\n'), [
        'a.txt-2- two',
        'a.txt:3: hit'
    ])
    assert.deepEqual((await grep({pattern: 'hit', context: 2, after: 0})).split('\n'), [
        'a.txt-1- one',
        'a.txt-2- two',
        'a.txt:3: hit'
    ])
})

test('a further match inside the last context window is shown as context once the limit is hit', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'hit\nhit\nhit\n')
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'hit', after: 1, limit: 1})

    assert.deepEqual(text.split('\n'), [
        'a.txt:1: hit',
        'a.txt-2- hit',
        '',
        '[1 matches limit reached. Use limit=2 for more, or refine pattern]'
    ])
})

test('wordMatch stops failure from matching failures="0"', async context => {
    const current = await workspace(async path => {
        await writeFile(
            join(path, 'report.xml'),
            '<testsuite failures="0">\n<failure message="boom"/>\n'
        )
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal((await grep({pattern: 'failure'})).split('\n').length, 2)
    assert.equal(
        await grep({pattern: 'failure', wordMatch: true}),
        'report.xml:2: <failure message="boom"/>'
    )
    assert.equal(
        await grep({pattern: 'boom"/>', wordMatch: true, literal: true}),
        'report.xml:2: <failure message="boom"/>'
    )
})

test('lineMatch takes the whole line and nothing less', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'pass\npassed\n pass\n')
    })
    context.after(current.remove)

    assert.equal(await grepIn(current.path)({pattern: 'pass', lineMatch: true}), 'a.txt:1: pass')
})

test('invert returns the lines that do not match, and they count toward the limit', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'keep\ndrop\nkeep\ndrop\n')
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal(await grep({pattern: 'drop', invert: true}), 'a.txt:1: keep\na.txt:3: keep')
    assert.match(
        await grep({pattern: 'drop', invert: true, limit: 1}),
        /^a.txt:1: keep\n\n\[1 matches limit/u
    )
})

test('onlyMatching returns each matched part on its own row', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'id=12 and id=34\nnone\nid=5\n')
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'id=\\d+', onlyMatching: true})

    assert.deepEqual(text.split('\n'), ['a.txt:1: id=12', 'a.txt:1: id=34', 'a.txt:3: id=5'])
})

test('perFile caps one file without ending the search or claiming the limit', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'hit\nhit\nhit\n')
        await writeFile(join(path, 'b.txt'), 'hit\n')
    })
    context.after(current.remove)

    assert.equal(
        await grepIn(current.path)({pattern: 'hit', perFile: 1}),
        'a.txt:1: hit\nb.txt:1: hit'
    )
})

test('filesOnly stops at the limit and says so', async context => {
    const current = await workspace(async path => {
        for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(path, `${name}.txt`), 'hit\n')
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'hit', filesOnly: true, limit: 2})

    assert.deepEqual(text.split('\n'), [
        'a.txt',
        'b.txt',
        '',
        '[2 matches limit reached. Use limit=4 for more, or refine pattern]'
    ])
})

test('a limit hit under perFile names both knobs', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'hit\nhit\nhit\n')
        await writeFile(join(path, 'b.txt'), 'hit\nhit\nhit\n')
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'hit', limit: 4, perFile: 2})

    assert.match(text, /Use limit=8 and perFile=4 for more/u)
})

test('an empty match is not a hit under onlyMatching', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'none\nnone\nxx here\n')
    })
    context.after(current.remove)

    assert.equal(
        await grepIn(current.path)({pattern: 'x*', onlyMatching: true, limit: 2}),
        'a.txt:3: xx'
    )
})

test('filesWithoutMatch names the searched files the pattern is absent from', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    assert.equal(
        await grepIn(current.path)({pattern: 'health -= 1', filesWithoutMatch: true}),
        'scenes/main.tscn\nscripts/enemy.gd'
    )
})

test('returns paths alone when filesOnly is set', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'func hit', filesOnly: true})

    assert.deepEqual(text.split('\n'), ['scripts/enemy.gd', 'scripts/player.gd'])
})

test('stops at the match limit and says how to see more', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'hit\n'.repeat(DEFAULT_MATCH_LIMIT + 20))
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    const capped = await grep({pattern: 'hit'})
    assert.equal(capped.split('\n').length, DEFAULT_MATCH_LIMIT + 2)
    assert.ok(
        capped.endsWith(
            `\n\n[${DEFAULT_MATCH_LIMIT} matches limit reached. `
                + `Use limit=${DEFAULT_MATCH_LIMIT * 2} for more, or refine pattern]`
        ),
        capped.slice(-120)
    )
    assert.equal((await grep({pattern: 'hit', limit: 120})).split('\n').length, 120)
})

test('stops at the byte cap', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), `${'w'.repeat(400)}\n`.repeat(400))
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'w', limit: 1000})

    assert.ok(text.includes('[50.0KB limit reached]'), text.slice(-80))
})

test('cuts a long line once and says it once', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), `${'w'.repeat(900)}\n${'w'.repeat(900)}\n`)
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'w'})

    assert.equal(text.split('... [truncated]').length, 3)
    assert.equal(
        text.split('\n').at(-1),
        `[Some lines truncated to ${MAX_LINE_CHARS} chars. Use read tool to see full lines]`
    )
})

test('skips the caches and the skills, and searches the agent workshop', async context => {
    const current = await workspace(async path => {
        for (const directory of [
            '.git',
            '.godot',
            '.gofer/skills',
            '.gofer/blobs',
            '.gofer/checks'
        ]) {
            await mkdir(join(path, directory), {recursive: true})
            await writeFile(join(path, directory, 'a.txt'), 'needle\n')
        }
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'needle'})

    assert.equal(text, '.gofer/checks/a.txt:1: needle')
})

test('skips a file holding a zero byte', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.bin'), Buffer.from('needle\0more'))
        await writeFile(join(path, 'a.txt'), 'needle\n')
    })
    context.after(current.remove)

    assert.equal(await grepIn(current.path)({pattern: 'needle'}), 'a.txt:1: needle')
})

test('skips a file too large to search, and counts it', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'big.txt'), 'needle\n'.repeat(LARGEST_SEARCHED_FILE_BYTES))
        await writeFile(join(path, 'a.txt'), 'needle\n')
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'needle'})

    assert.equal(
        text,
        'a.txt:1: needle\n\n[1 file skipped as too large to search. Read one with the read tool]'
    )
})

test('never follows a symlink out of the workspace', async context => {
    const current = await workspace(async path => {
        const outside = join(path, '..', 'outside')
        await mkdir(outside)
        await writeFile(join(outside, 'secret.txt'), 'needle\n')
        await symlink(join(outside, 'secret.txt'), join(path, 'escape.txt'))
    })
    context.after(current.remove)

    assert.equal(await grepIn(current.path)({pattern: 'needle'}), 'No matches found')
})

test('names the pattern and the way out when it cannot be read', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    await assert.rejects(grepIn(current.path)({pattern: '('}), error => {
        assert.match(error.message, /`\(`/u)
        assert.match(error.message, /JavaScript/u)
        assert.match(error.message, /literal/u)
        return true
    })
})

test('a GNU word mark is a usable pattern, not a refusal', () => {
    assert.ok(matcherFor({pattern: '\\<foo\\>'}).test('<foo>'))
})

test('anchors to the line, not to the file', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'not_here\nis not there\n')
    })
    context.after(current.remove)

    assert.equal(
        await grepIn(current.path)({pattern: '(^|[^\\w!])not [^_]'}),
        'a.txt:2: is not there'
    )
})

test('answers the same call with the same bytes', async context => {
    const current = await workspace(project)
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal(await grep({pattern: 'func hit'}), await grep({pattern: 'func hit'}))
})

test('an aborted call says it searched nothing, rather than nothing was there', async context => {
    const current = await workspace(project)
    context.after(current.remove)
    const env = new NodeExecutionEnv({cwd: current.path})
    const controller = new AbortController()
    controller.abort()

    const answer = await createGrepTool().execute(
        '1',
        {pattern: 'func hit'},
        controller.signal,
        undefined,
        {env}
    )

    assert.match(answer.content[0].text, /could not be opened/u)
})

test('reads a glob as the suffixes it names', () => {
    assert.equal(suffixesOf(undefined), undefined)
    assert.equal(suffixesOf('  '), undefined)
    assert.equal(suffixesOf('*'), undefined)
    assert.deepEqual(suffixesOf('*.gd, *.tscn'), ['.gd', '.tscn'])
    assert.deepEqual(suffixesOf('gd'), ['gd'])
})

test('the limit counts matches, not the rows context adds', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'a\nhit\nb\nc\nhit\nd\n')
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'hit', context: 1, limit: 2})

    assert.deepEqual(text.split('\n'), [
        'a.txt-1- a',
        'a.txt:2: hit',
        'a.txt-3- b',
        'a.txt-4- c',
        'a.txt:5: hit',
        'a.txt-6- d'
    ])
})

test('labels and skips read the same on a backslash filesystem', () => {
    assert.equal(workspaceRelative('C:\\ws', 'C:\\ws\\scripts\\a.gd'), 'scripts/a.gd')
    assert.equal(workspaceRelative('/ws', '/ws/scripts/a.gd'), 'scripts/a.gd')
    assert.ok(isSkipped(workspaceRelative('C:\\ws', 'C:\\ws\\.gofer\\skills\\a.md')))
    assert.ok(!isSkipped(workspaceRelative('C:\\ws', 'C:\\ws\\.gofer\\checks\\a.gd')))
})

test('a search that ended on its own is not reported as cut short', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'hit\nhit\n')
    })
    context.after(current.remove)
    const grep = grepIn(current.path)

    assert.equal(await grep({pattern: 'hit', limit: 2}), 'a.txt:1: hit\na.txt:2: hit')
    assert.match(await grep({pattern: 'hit', limit: 1}), /1 matches limit reached/u)
})

test('a folder it cannot list is counted, not passed over in silence', async context => {
    const current = await workspace(async path => {
        await mkdir(join(path, 'locked'))
        await writeFile(join(path, 'locked', 'a.txt'), 'needle\n')
        await writeFile(join(path, 'a.txt'), 'needle\n')
        await chmod(join(path, 'locked'), 0o000)
    })
    context.after(async () => {
        await chmod(join(current.path, 'locked'), 0o755).catch(() => undefined)
        await current.remove()
    })

    const text = await grepIn(current.path)({pattern: 'needle'})

    assert.match(text, /1 folder could not be opened/u)
})

test('a media file is passed over without being read', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'art.png'), Buffer.from('needle'))
        await writeFile(join(path, 'a.txt'), 'needle\n')
    })
    context.after(current.remove)

    assert.equal(await grepIn(current.path)({pattern: 'needle'}), 'a.txt:1: needle')
})

test('several patterns are answered in one call, each under its own heading', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    const text = await grepIn(current.path)({
        pattern: ['func hit', 'extends Node'],
        glob: '*.gd'
    })

    assert.deepEqual(text.split('\n'), [
        'func hit:',
        'scripts/enemy.gd:3: func hit() -> void:',
        'scripts/player.gd:3: func hit() -> void:',
        '',
        'extends Node:',
        'scripts/enemy.gd:1: extends Node',
        'scripts/player.gd:1: extends Node'
    ])
})

test('a pattern nothing matches says so under its own heading', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: ['func hit', 'nowhere']})

    assert.match(text, /^func hit:\n/u)
    assert.match(text, /\nnowhere:\nNo matches found$/u)
})

test('countOnly answers one number a pattern and nothing else', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    const text = await grepIn(current.path)({
        pattern: ['func hit', 'extends Node', 'nowhere'],
        countOnly: true
    })

    assert.deepEqual(text.split('\n'), ['func hit: 2', 'extends Node: 2', 'nowhere: 0'])
})

test('a count is not capped by the limit, because a short count is a wrong one', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), 'hit\n'.repeat(DEFAULT_MATCH_LIMIT + 40))
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'hit', countOnly: true})

    assert.equal(text, `hit: ${DEFAULT_MATCH_LIMIT + 40}`)
})

test('the limit is per pattern, so one busy search does not starve the others', async context => {
    const current = await workspace(async path => {
        await writeFile(join(path, 'a.txt'), `${'noisy\n'.repeat(DEFAULT_MATCH_LIMIT + 5)}quiet\n`)
    })
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: ['noisy', 'quiet']})

    assert.match(text, /\nquiet:\na\.txt:\d+: quiet/u)
})

test('an empty list of patterns is refused, not treated as a match-everything', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    await assert.rejects(grepIn(current.path)({pattern: []}), /needs a pattern/u)
})

test('several paths are searched in one call', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    const text = await grepIn(current.path)({pattern: 'extends Node', path: ['scripts', 'scenes']})

    assert.deepEqual(text.split('\n'), [
        'scripts/enemy.gd:1: extends Node',
        'scripts/player.gd:1: extends Node'
    ])
})

test('a path in the list that does not exist is named, not passed over', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    await assert.rejects(grepIn(current.path)({pattern: 'x', path: ['scripts', 'nope']}), /nope/u)
})

test('an empty path list searches the whole project', async context => {
    const current = await workspace(project)
    context.after(current.remove)

    assert.equal(
        await grepIn(current.path)({pattern: 'extends Node', path: []}),
        await grepIn(current.path)({pattern: 'extends Node'})
    )
})
