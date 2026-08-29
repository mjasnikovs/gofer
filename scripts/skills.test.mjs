import assert from 'node:assert/strict'
import {mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {NodeExecutionEnv} from '@earendil-works/pi-agent-core/node'
import {
    MAX_BUNDLE_FILES,
    MAX_SKILLS_PROMPT_BYTES,
    explainDiagnostic,
    importSkillFile,
    listProjectSkills,
    promptWithSkills,
    skillPath,
    skillsPromptBlock,
    validName
} from './skills.mjs'

async function workspace() {
    const path = await mkdtemp(join(tmpdir(), 'gofer-skills-'))
    return {
        path,
        env: new NodeExecutionEnv({cwd: path}),
        /** Writes one skill the way the tab writes one, and answers with the file it wrote. */
        async give(name, text) {
            const directory = join(path, '.gofer', 'skills', name)
            await mkdir(directory, {recursive: true})
            const file = join(directory, 'SKILL.md')
            await writeFile(file, text)
            return file
        },
        remove: () => rm(path, {recursive: true, force: true})
    }
}

const skill = (description, body = 'Do the thing.') =>
    `---\ndescription: ${description}\n---\n${body}\n`

test('a project with no skills directory has no skills and no complaints', async context => {
    const project = await workspace()
    context.after(project.remove)

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)

    assert.deepEqual(skills, [])
    assert.deepEqual(diagnostics, [])
})

test('a skill is named after its directory and keeps its description', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('tile-levels', skill('How to build a 2D level from tiles'))

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)

    assert.deepEqual(diagnostics, [])
    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'tile-levels')
    assert.equal(skills[0].description, 'How to build a 2D level from tiles')
    assert.equal(skills[0].filePath, skillPath(project.path, 'tile-levels'))
})

/**
 * The failure the tab exists to explain. A file with no description is not a skill at all — the
 * loader drops it — so without the warning beside it the row would simply never appear and the
 * user would have no idea why.
 */
test('a skill with no description is dropped, and says so', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('half-written', 'No frontmatter yet.\n')

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)

    assert.deepEqual(skills, [])
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].code, 'invalid_metadata')
    assert.match(diagnostics[0].message, /description is required/u)
})

test('a name that disagrees with its directory still loads, and warns', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('one-name', `---\nname: another-name\ndescription: mismatched\n---\nbody\n`)

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)

    assert.deepEqual(
        skills.map(one => one.name),
        ['another-name']
    )
    assert.equal(diagnostics.length, 1)
    assert.match(diagnostics[0].message, /does not match parent directory/u)
})

test('the prompt block names every enabled skill and leaves out the rest', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('tile-levels', skill('How to build a 2D level from tiles'))
    await project.give('sound-design', skill('Where the audio buses go'))
    const {skills} = await listProjectSkills(project.env, project.path)

    const block = skillsPromptBlock(skills, ['sound-design'])

    assert.match(block, /<name>tile-levels<\/name>/u)
    assert.match(block, /How to build a 2D level from tiles/u)
    assert.doesNotMatch(block, /sound-design/u)
    // The location is what the agent's read tool is given, so it has to be the real absolute path.
    assert.match(
        block,
        new RegExp(skillPath(project.path, 'tile-levels').replace(/\//gu, '\\/'), 'u')
    )
})

/**
 * A project whose every skill is off sends nothing at all, rather than an empty list with a
 * paragraph of instructions above it telling the model to read skills it has not been given.
 */
test('a project with nothing enabled adds nothing to the prompt', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('tile-levels', skill('How to build a 2D level from tiles'))
    const {skills} = await listProjectSkills(project.env, project.path)

    assert.equal(skillsPromptBlock(skills, ['tile-levels']), '')
    assert.equal(skillsPromptBlock([], []), '')
})

test('a skill hidden in its own frontmatter never reaches the model', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give(
        'private-notes',
        `---\ndescription: mine\ndisable-model-invocation: true\n---\nbody\n`
    )
    const {skills} = await listProjectSkills(project.env, project.path)

    // Still listed, so the tab can show it and say why it is off.
    assert.equal(skills.length, 1)
    assert.equal(skills[0].disableModelInvocation, true)
    assert.equal(skillsPromptBlock(skills, []), '')
})

test('an imported file is named by its frontmatter, and by its filename when it has none', async context => {
    const project = await workspace()
    context.after(project.remove)
    const source = join(project.path, 'Tile Levels.md')
    await writeFile(source, skill('picked out of a folder'))

    assert.equal(await importSkillFile(project.env, project.path, source), 'tile-levels')

    const named = join(project.path, 'other.md')
    await writeFile(named, `---\nname: sound-design\ndescription: named itself\n---\nbody\n`)
    assert.equal(await importSkillFile(project.env, project.path, named), 'sound-design')

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)
    assert.deepEqual(skills.map(one => one.name).sort(), ['sound-design', 'tile-levels'])
    assert.deepEqual(diagnostics, [])
})

/**
 * The regression. A `SKILL.md` with no description loads as *no skill*, so asking the loader
 * whether a name is taken answers "no" for exactly the file a user is most likely to be coming
 * back to finish — and the import overwrites the text they wrote.
 */
test('importing over a half-written skill is refused, not silently overwritten', async context => {
    const project = await workspace()
    context.after(project.remove)
    const existing = await project.give(
        'tile-levels',
        'Half a page of notes, no frontmatter yet.\n'
    )
    const source = join(project.path, 'tile-levels.md')
    await writeFile(source, skill('a different skill entirely'))

    await assert.rejects(
        importSkillFile(project.env, project.path, source),
        /already has a skill called "tile-levels"/u
    )
    assert.equal(await readFile(existing, 'utf8'), 'Half a page of notes, no frontmatter yet.\n')
})

/**
 * The gap this whole folder path exists to close.
 *
 * A real skill is usually more than one file: `SKILL.md` is what the model is told about, and it
 * names the rest by relative path for the agent to open once the description matches. Importing
 * only the Markdown file left a skill whose every reference pointed at nothing.
 */
test('a skill folder is imported whole, not just its SKILL.md', async context => {
    const project = await workspace()
    context.after(project.remove)
    const folder = join(project.path, 'godot-pixel-camera')
    await mkdir(join(folder, 'reference'), {recursive: true})
    await writeFile(
        join(folder, 'SKILL.md'),
        skill('Pixel perfect cameras', 'The traps are in `reference/traps.md`.')
    )
    await writeFile(join(folder, 'reference', 'traps.md'), '# Traps\n')
    await writeFile(join(folder, 'reference', 'camera.md'), '# Camera\n')

    assert.equal(await importSkillFile(project.env, project.path, folder), 'godot-pixel-camera')

    const landed = join(project.path, '.gofer', 'skills', 'godot-pixel-camera')
    assert.equal(await readFile(join(landed, 'reference', 'traps.md'), 'utf8'), '# Traps\n')
    assert.equal(await readFile(join(landed, 'reference', 'camera.md'), 'utf8'), '# Camera\n')
    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)
    assert.deepEqual(diagnostics, [])
    assert.equal(skills[0].name, 'godot-pixel-camera')
})

test('a folder with no SKILL.md in it is not a skill', async context => {
    const project = await workspace()
    context.after(project.remove)
    const folder = join(project.path, 'just-notes')
    await mkdir(folder, {recursive: true})
    await writeFile(join(folder, 'notes.md'), '# Notes\n')

    await assert.rejects(
        importSkillFile(project.env, project.path, folder),
        /"just-notes" holds no SKILL.md/u
    )
    assert.deepEqual((await listProjectSkills(project.env, project.path)).skills, [])
})

/**
 * The folder the user picked is the whole of what they agreed to hand over. A link inside it can
 * name anything on the disk, and following one would copy a file from outside into the directory
 * the agent reads. `.git` is skipped because a folder cloned from GitHub carries one, it is the
 * largest thing in there, and nothing in it is ever read.
 */
test('a skill folder leaves its links and its .git behind', async context => {
    const project = await workspace()
    context.after(project.remove)
    const secret = join(project.path, 'private.txt')
    await writeFile(secret, 'not theirs to copy')
    const folder = join(project.path, 'linked')
    await mkdir(join(folder, '.git'), {recursive: true})
    await writeFile(join(folder, 'SKILL.md'), skill('has a link in it'))
    await writeFile(join(folder, '.git', 'HEAD'), 'ref: refs/heads/master\n')
    await symlink(secret, join(folder, 'elsewhere.txt'))

    await importSkillFile(project.env, project.path, folder)

    const landed = join(project.path, '.gofer', 'skills', 'linked')
    await assert.rejects(stat(join(landed, 'elsewhere.txt')), {code: 'ENOENT'})
    await assert.rejects(stat(join(landed, '.git')), {code: 'ENOENT'})
})

/** Half a folder is worse than none: it is listed as a skill whose references are missing. */
test('a folder with too many files in it leaves nothing behind', async context => {
    const project = await workspace()
    context.after(project.remove)
    const folder = join(project.path, 'too-many')
    await mkdir(folder, {recursive: true})
    await writeFile(join(folder, 'SKILL.md'), skill('far too many notes'))
    for (let index = 0; index <= MAX_BUNDLE_FILES; index += 1) {
        await writeFile(join(folder, `note-${index}.md`), 'x')
    }

    await assert.rejects(importSkillFile(project.env, project.path, folder), /at most/u)
    await assert.rejects(stat(join(project.path, '.gofer', 'skills', 'too-many')), {
        code: 'ENOENT'
    })
})

/**
 * The name is the only thing every command has to go on.
 *
 * A skill's name comes from its frontmatter, and pi only *warns* when that disagrees with the
 * directory — so two files can both declare the same name and both come back as skills. Edit,
 * Save, Delete and the off-switch all look one up by name and take the first match, so the second
 * row's Delete removed the first one's directory and answered with a list that still held the row.
 */
test('two files claiming one name leave one skill and a warning', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('one', `---\nname: tile-levels\ndescription: from one\n---\nbody\n`)
    await project.give('two', `---\nname: tile-levels\ndescription: from two\n---\nbody\n`)

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)

    assert.equal(skills.length, 1)
    assert.equal(skills[0].description, 'from one')
    const repeated = diagnostics.filter(one => one.code === 'duplicate_skill_name')
    assert.equal(repeated.length, 1)
    assert.match(repeated[0].path, /two[\\/]SKILL\.md$/u)
    // And the prompt names it once, not twice.
    assert.equal(skillsPromptBlock(skills, []).match(/<name>tile-levels<\/name>/gu).length, 1)
})

test('a name that would climb out of the skills directory is not a name', () => {
    assert.equal(validName('tile-levels'), 'tile-levels')
    for (const refused of [
        '../escape',
        'a/b',
        'a\\b',
        'Tile-Levels',
        '-leading',
        'trailing-',
        'double--hyphen',
        '',
        'x'.repeat(65)
    ]) {
        assert.throws(() => validName(refused), Error, `"${refused}" must be refused`)
    }
})

test('a file too large to be a skill is refused before anything is written', async context => {
    const project = await workspace()
    context.after(project.remove)
    const source = join(project.path, 'huge.md')
    await writeFile(source, `---\ndescription: big\n---\n${'x'.repeat(300 * 1024)}`)

    await assert.rejects(importSkillFile(project.env, project.path, source), /too large/u)
    assert.deepEqual((await listProjectSkills(project.env, project.path)).skills, [])
})

test('the prompt keeps its own text and gains the block beneath it', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('tile-levels', skill('How to build a 2D level from tiles'))

    const prompt = await promptWithSkills(project.env, project.path, 'You are Gofer.')

    assert.match(prompt, /^You are Gofer\.\n\n/u)
    assert.match(prompt, /<name>tile-levels<\/name>/u)
})

test('a project with no skills sends the prompt it was given, unchanged', async context => {
    const project = await workspace()
    context.after(project.remove)

    assert.equal(
        await promptWithSkills(project.env, project.path, 'You are Gofer.'),
        'You are Gofer.'
    )
})

/**
 * The agent worked without skills for every version before this one. A directory that cannot be
 * read is a turn with no skills, never a turn that does not happen.
 */
test('a skills directory that cannot be read costs the turn nothing', async context => {
    const project = await workspace()
    context.after(project.remove)
    const broken = new Proxy(project.env, {
        get: (target, key) =>
            key === 'fileInfo' ?
                () => {
                    throw new Error('the disk is on fire')
                }
            :   Reflect.get(target, key).bind(target)
    })

    assert.equal(await promptWithSkills(broken, project.path, 'You are Gofer.'), 'You are Gofer.')
})

test('more skills than the prompt can hold are left out, not sent', async context => {
    const project = await workspace()
    context.after(project.remove)
    const description = 'x'.repeat(1000)
    for (let index = 0; index < 60; index += 1) {
        await project.give(`skill-${index}`, skill(description))
    }

    const prompt = await promptWithSkills(project.env, project.path, 'You are Gofer.')

    assert.ok(Buffer.byteLength(prompt) < MAX_SKILLS_PROMPT_BYTES + 200, 'the block is bounded')
    assert.match(prompt, /<name>skill-0<\/name>/u)
    assert.doesNotMatch(prompt, /<name>skill-59<\/name>/u)
})

/**
 * The likeliest way to write a skill that does not load, and the least helpful thing to be told
 * about it. A description is a sentence, sentences contain colons, and frontmatter is YAML.
 */
test('a description with a colon in it is explained, not just reported', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give(
        'tile-levels',
        `---\ndescription: How to build a level: the rule\n---\nbody\n`
    )

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)

    assert.deepEqual(skills, [])
    assert.equal(diagnostics.length, 1)
    const explained = explainDiagnostic(diagnostics[0])
    // The parser's own text stays in front: it names the line and the column.
    assert.match(explained.message, /Nested mappings/u)
    assert.match(explained.message, /has to be quoted/u)

    // And quoting it is the fix, so the sentence is true.
    await project.give(
        'tile-levels',
        `---\ndescription: "How to build a level: the rule"\n---\nbody\n`
    )
    const fixed = await listProjectSkills(project.env, project.path)
    assert.deepEqual(fixed.diagnostics, [])
    assert.equal(fixed.skills[0].description, 'How to build a level: the rule')
})

/** Every other warning is the loader's own words, untouched. */
test('a warning that is not a parse failure is left exactly as it arrived', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('half-written', 'No frontmatter yet.\n')

    const {diagnostics} = await listProjectSkills(project.env, project.path)

    assert.deepEqual(explainDiagnostic(diagnostics[0]), diagnostics[0])
})

/**
 * The one arrangement that hides every skill and says nothing.
 *
 * pi stops at the first `SKILL.md` in the directory it was handed and does not recurse, so one
 * sitting directly in the skills directory turns the whole store into a single skill and every
 * real skill under it disappears — from the tab and from the prompt.
 */
test('a SKILL.md in the skills directory itself is named, not silently obeyed', async context => {
    const project = await workspace()
    context.after(project.remove)
    await project.give('tile-levels', skill('How to build a 2D level from tiles'))
    await writeFile(
        join(project.path, '.gofer', 'skills', 'SKILL.md'),
        skill('a file somebody put in the wrong place')
    )

    const {skills, diagnostics} = await listProjectSkills(project.env, project.path)

    // pi's own answer, which is why the warning has to exist: one skill, and it is not the real one.
    assert.deepEqual(
        skills.map(one => one.name),
        ['skills']
    )
    assert.ok(
        diagnostics.some(one => one.code === 'shadowing_skill'),
        JSON.stringify(diagnostics)
    )
})

/** A filename with nothing usable in it fails by name, not by quoting a temporary path. */
test('a file whose name normalises to nothing is refused in its own words', async context => {
    const project = await workspace()
    context.after(project.remove)
    const source = join(project.path, '____.md')
    await writeFile(source, skill('picked out of a folder'))

    await assert.rejects(
        importSkillFile(project.env, project.path, source),
        /"____\.md" has no name a skill can be called/u
    )
})

/** Nothing is left in the temporary directory an import borrows to read a name. */
test('an import collects the temporary directory it borrowed', async context => {
    const project = await workspace()
    context.after(project.remove)
    const source = join(project.path, 'tile-levels.md')
    await writeFile(source, skill('picked out of a folder'))
    const borrowed = []
    // A Proxy rather than a spread: `NodeExecutionEnv` keeps its methods on the prototype, so a
    // copy made with `...` has none of them.
    const watched = new Proxy(project.env, {
        get: (target, key) =>
            key === 'createTempDir' ?
                async prefix => {
                    const made = await target.createTempDir(prefix)
                    if (made.ok) borrowed.push(made.value)
                    return made
                }
            :   Reflect.get(target, key).bind(target)
    })

    await importSkillFile(watched, project.path, source)

    assert.equal(borrowed.length, 1)
    await assert.rejects(stat(borrowed[0]), {code: 'ENOENT'})
})
