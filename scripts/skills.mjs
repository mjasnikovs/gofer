/**
 * Skills: the instructions a project adds to its agent, and the only place Gofer parses one.
 *
 * A skill is a Markdown file with YAML frontmatter, laid out the way the Agent Skills standard
 * lays one out — `.gofer/skills/<name>/SKILL.md`. Only its name and description reach the model;
 * the body is read with the agent's own `read` tool, and only when the description matches what
 * it is doing. That is the whole point: a body of knowledge that costs two lines of prompt until
 * the turn that needs it.
 *
 * Nothing here parses frontmatter. `@earendil-works/pi-agent-core` already does, with the
 * standard's validation rules and its diagnostics, and Gofer depends on it for the agent loop
 * anyway. A second parser would be a second answer to "is this skill valid", and the tab and the
 * turn would eventually disagree about a file neither of them wrote.
 *
 * Two consumers, one module: `ai-provider.mjs` composes the prompt block, and `skills-worker.mjs`
 * answers the Skills tab. Both see the same skills and the same warnings.
 */

import {access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {basename, join} from 'node:path'
import {formatSkillsForSystemPrompt, loadSkills} from '@earendil-works/pi-agent-core'

/** Where a project keeps its skills, relative to the workspace the agent is confined to. */
export const SKILLS_DIRECTORY = join('.gofer', 'skills')

/**
 * The name rule, which is the standard's and is also a path check.
 *
 * Pi validates the same shape and only warns about it. Here it decides a directory name, so it
 * refuses instead: a name with a separator in it is a write outside the skills directory.
 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_NAME_LENGTH = 64

/** A skill no larger than this. Generous for prose, and a ceiling on a file picked by mistake. */
export const MAX_SKILL_BYTES = 256 * 1024

export function skillsDirectory(workspacePath) {
    return join(workspacePath, SKILLS_DIRECTORY)
}

/** The path a skill's own file sits at, once its name has been checked. */
export function skillPath(workspacePath, name) {
    return join(skillsDirectory(workspacePath), validName(name), 'SKILL.md')
}

/** The name, or an explanation of why it is not one. Every path this module builds goes through it. */
export function validName(name) {
    if (typeof name !== 'string' || name.length === 0) throw new Error('A skill needs a name')
    if (name.length > MAX_NAME_LENGTH) {
        throw new Error(`A skill name is at most ${MAX_NAME_LENGTH} characters`)
    }
    if (!NAME_PATTERN.test(name)) {
        throw new Error(
            `"${name}" is not a skill name: use lowercase letters, digits and single hyphens`
        )
    }
    return name
}

/**
 * Every skill this project has, valid or not, with the warnings that explain the ones that are not.
 *
 * A missing directory is a project with no skills rather than a failure — `loadSkills` already
 * treats it that way, and a first run has no directory to find.
 */
export async function listProjectSkills(env, workspacePath) {
    const directory = skillsDirectory(workspacePath)
    const loaded = await loadSkills(env, directory)
    const {skills, duplicates} = withoutRepeatedNames(loaded.skills)
    const shadow = await shadowingSkillFile(env, directory)
    return {
        ...loaded,
        skills,
        diagnostics: [...loaded.diagnostics, ...duplicates, ...(shadow ? [shadow] : [])]
    }
}

/**
 * One skill per name, and a warning for each file that wanted a name already taken.
 *
 * A skill's name comes from its frontmatter, and pi only *warns* when that disagrees with the
 * directory — so two directories can both declare `name: tile-levels` and both come back as
 * skills. The name is the only thing every command has to go on: Edit, Save, Delete and the
 * off-switch all look a skill up by it and take the first match. Measured with two such files, the
 * second row's Delete removed the first one's directory and answered with a list that still held
 * the row. The tab drew both rows under one React key besides.
 *
 * The first is kept because that is the one every command already acted on, so nothing that worked
 * before starts pointing somewhere new.
 */
function withoutRepeatedNames(loaded) {
    const seen = new Map()
    const duplicates = []
    for (const skill of loaded) {
        const first = seen.get(skill.name)
        if (first === undefined) {
            seen.set(skill.name, skill)
            continue
        }
        duplicates.push({
            type: 'warning',
            code: 'duplicate_skill_name',
            message: `Another skill is already called "${skill.name}", so this file is not used. Give it a name of its own, or delete it.`,
            path: skill.filePath
        })
    }
    return {skills: [...seen.values()], duplicates}
}

/**
 * The one arrangement that hides every skill and says nothing.
 *
 * pi stops as soon as it finds a `SKILL.md` in the directory it was handed: that directory *is* the
 * skill, and it does not recurse. So a `SKILL.md` sitting directly in `.gofer/skills` turns the
 * whole store into one skill named `skills` and every real skill under it disappears — from the
 * tab and from the prompt — with no warning anywhere.
 *
 * Nothing in Gofer creates that file, which is exactly why it is worth naming: it can only arrive
 * by hand, and the person who put it there has no other way to find out what it did.
 */
async function shadowingSkillFile(env, directory) {
    const path = await env.joinPath([directory, 'SKILL.md'])
    if (!path.ok) return undefined
    const info = await env.fileInfo(path.value)
    if (!info.ok || info.value.kind !== 'file') return undefined
    return {
        type: 'warning',
        code: 'shadowing_skill',
        message:
            'A SKILL.md sitting directly in the skills directory makes the whole directory one '
            + 'skill, and hides every skill inside it. Move it into a directory of its own.',
        path: path.value
    }
}

/**
 * One of the loader's warnings, with the sentence that says what to do about it.
 *
 * `parse_failed` earns this and the others do not. A description is a sentence, sentences contain
 * colons, and frontmatter is YAML — so `description: How to build a level: the rule` is the single
 * likeliest way to write a skill that does not load. What the loader reports for it is "Nested
 * mappings are not allowed in compact mappings at line 2, column 14", which is true, is about YAML,
 * and tells someone writing a skill nothing they can act on.
 *
 * The parser's own text is kept in front of the hint rather than replaced: it names the line and
 * column, and a file can fail to parse for reasons that have nothing to do with a colon.
 */
export function explainDiagnostic(diagnostic) {
    if (diagnostic.code !== 'parse_failed') return diagnostic
    return {
        ...diagnostic,
        message: `${diagnostic.message.trim()}\n\nThe part between the --- lines is YAML. A description that contains a colon has to be quoted: description: "How to build a level: the rule".`
    }
}

/**
 * The `<available_skills>` block, or nothing at all.
 *
 * `disabled` is the project's own off switch, kept beside the project rather than in the file, so
 * turning a skill off never rewrites text the user wrote. Pi's own `disable-model-invocation`
 * still counts: `formatSkillsForSystemPrompt` filters those itself, and Gofer has no explicit
 * invocation to keep them around for.
 */
export function skillsPromptBlock(skills, disabled = []) {
    const off = new Set(disabled)
    return formatSkillsForSystemPrompt(skills.filter(skill => !off.has(skill.name)))
}

/**
 * A ceiling on what skills may add to the prompt, in the spirit of `MAX_PROMPT_BYTES` in
 * `agent_prompt.rs`: a bound on a mistake rather than a budget anyone is meant to spend.
 *
 * Pi caps a description at 1,024 characters, so this is around thirty skills — more than a project
 * has, and far fewer than the number that would quietly eat a context window. Past it the extra
 * skills are left out rather than the turn being refused, because a project that has collected too
 * many skills still wants its turn.
 */
export const MAX_SKILLS_PROMPT_BYTES = 32 * 1024

/**
 * The prompt a turn actually sends: what the backend composed, plus this project's skills.
 *
 * Never throws. A skills directory that cannot be read is a turn with no skills, not a turn that
 * does not happen — the agent worked without skills for every version before this one, and a
 * permission error on one file is not a reason to stop.
 */
export async function promptWithSkills(env, workspacePath, systemPrompt, disabled = []) {
    const block = await skillsBlockFor(env, workspacePath, disabled)
    return block ? `${systemPrompt}\n\n${block}` : systemPrompt
}

async function skillsBlockFor(env, workspacePath, disabled) {
    try {
        const {skills} = await listProjectSkills(env, workspacePath)
        return withinBudget(skills, disabled)
    } catch {
        return ''
    }
}

/** As many skills as fit, in the order they were found, so the block is stable between turns. */
function withinBudget(skills, disabled) {
    let kept = skills
    let block = skillsPromptBlock(kept, disabled)
    while (kept.length > 0 && Buffer.byteLength(block) > MAX_SKILLS_PROMPT_BYTES) {
        kept = kept.slice(0, -1)
        block = skillsPromptBlock(kept, disabled)
    }
    return block
}

/**
 * A skill folder holds at most this many files, and this many bytes across them.
 *
 * A bound on a mistake rather than a budget. A skill is prose plus the odd diagram, and the folder
 * a user picks by accident is a whole repository — which is copied file by file into the project
 * the agent reads, so the ceiling has to be reached before the copy finishes, not after.
 */
export const MAX_BUNDLE_FILES = 256
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024

/**
 * Takes the Markdown file or the skill folder the user picked and makes it this project's skill.
 *
 * A skill is often more than one file. `SKILL.md` is the part the model is told about, and it
 * points at the rest by relative path — `reference/traps.md` — which the agent opens with its own
 * read tool once the description matches. Copying only the one file leaves a skill whose every
 * reference is a path to nothing, so a folder is imported whole.
 *
 * The name comes from the file's own frontmatter where it has one, because that is the name the
 * standard says a skill has and the name pi will check the directory against. The filename is the
 * fallback, and `SKILL.md` is not a name — a file picked out of somebody else's skill directory is
 * named after the directory it sat in, so that is what is read instead.
 */
export async function importSkillFile(env, workspacePath, sourcePath) {
    const picked = await pickedSkill(sourcePath)
    const source = await readFile(picked.skillFile, 'utf8')
    if (Buffer.byteLength(source) > MAX_SKILL_BYTES) {
        throw new Error('That file is too large to be a skill')
    }
    const name = validName(await nameFor(env, picked.skillFile, source))
    const directory = join(skillsDirectory(workspacePath), name)
    // The directory, not a skill loaded out of it. A SKILL.md with no description loads as no
    // skill at all, so asking the loader whether this name is taken answers "no" for exactly the
    // file the user is most likely to be coming back to fix, and overwrites it.
    if (await exists(directory)) {
        throw new Error(`This project already has a skill called "${name}"`)
    }
    await mkdir(directory, {recursive: true})
    try {
        if (picked.folder === undefined) {
            await writeFile(join(directory, 'SKILL.md'), source, 'utf8')
        } else {
            await copyBundle(picked.folder, directory)
        }
    } catch (error) {
        // Half a folder is worse than none: it is listed as a skill whose references are missing,
        // and the name it took is now the reason the second attempt is refused.
        await rm(directory, {recursive: true, force: true})
        throw error
    }
    return name
}

/** What the user picked: one Markdown file, or a folder with a `SKILL.md` in it. */
async function pickedSkill(sourcePath) {
    const info = await stat(sourcePath)
    if (!info.isDirectory()) return {skillFile: sourcePath}
    const skillFile = join(sourcePath, 'SKILL.md')
    if (!(await exists(skillFile))) {
        throw new Error(`"${basename(sourcePath)}" holds no SKILL.md, so it is not a skill`)
    }
    return {skillFile, folder: sourcePath}
}

/**
 * Copies a skill folder into the project, file by file, counting as it goes.
 *
 * Symbolic links are skipped rather than followed. A link inside the folder can name anything on
 * the disk, and following one would copy a file from outside the folder into the directory the
 * agent reads — the folder the user picked is the whole of what they agreed to hand over.
 *
 * `.git` is skipped for the same reason a repository is not a skill: a folder cloned from GitHub
 * carries one, it is the largest thing in there, and nothing in it is ever read.
 */
async function copyBundle(folder, destination) {
    let files = 0
    let bytes = 0
    const walk = async (from, to) => {
        for (const entry of await readdir(from, {withFileTypes: true})) {
            if (entry.name === '.git' || entry.isSymbolicLink()) continue
            const source = join(from, entry.name)
            const target = join(to, entry.name)
            if (entry.isDirectory()) {
                await mkdir(target, {recursive: true})
                await walk(source, target)
                continue
            }
            if (!entry.isFile()) continue
            files += 1
            bytes += (await stat(source)).size
            if (files > MAX_BUNDLE_FILES) {
                throw new Error(`A skill holds at most ${MAX_BUNDLE_FILES} files`)
            }
            if (bytes > MAX_BUNDLE_BYTES) {
                throw new Error('That folder is too large to be a skill')
            }
            await copyFile(source, target)
        }
    }
    await walk(folder, destination)
}

/**
 * The name a file claims, asked of the loader rather than of a regular expression here.
 *
 * The file is loaded from a temporary directory named after the fallback, so pi parses it exactly
 * as it will once it is in place — including deciding that a file with no `name` is named after
 * its parent.
 */
async function nameFor(env, sourcePath, source) {
    const fallback = fallbackName(sourcePath)
    // Refused here rather than by `validName` afterwards. An empty fallback makes the staging path
    // collapse to the temporary root itself, so the skill is named after a random `gofer-skill-…`
    // directory and the failure quotes a path the user never typed.
    if (fallback === '') {
        throw new Error(`"${basename(sourcePath)}" has no name a skill can be called`)
    }
    const root = await temporaryRoot(env)
    const staging = join(root, fallback)
    await mkdir(staging, {recursive: true})
    try {
        await writeFile(join(staging, 'SKILL.md'), source, 'utf8')
        const {skills} = await loadSkills(env, staging)
        return skills[0]?.name ?? fallback
    } finally {
        // The root, not `staging` inside it. `createTempDir` is a bare `mkdtemp` that nothing ever
        // collects, so removing only the child left an empty directory behind on every import.
        await rm(root, {recursive: true, force: true})
    }
}

async function exists(path) {
    return await access(path).then(
        () => true,
        () => false
    )
}

async function temporaryRoot(env) {
    const created = await env.createTempDir('gofer-skill-')
    if (!created.ok) throw new Error(created.error.message)
    return created.value
}

/** What a file is called when its frontmatter does not say — its own name, or its directory's. */
function fallbackName(sourcePath) {
    const file = basename(sourcePath).replace(/\.md$/iu, '')
    const named = file.toLowerCase() === 'skill' ? basename(join(sourcePath, '..')) : file
    return named
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
}
