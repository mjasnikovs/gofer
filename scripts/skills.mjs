import {access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {basename, join} from 'node:path'
import {formatSkillsForSystemPrompt, loadSkills} from '@earendil-works/pi-agent-core'

export const SKILLS_DIRECTORY = join('.gofer', 'skills')

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const MAX_NAME_LENGTH = 64

export const MAX_SKILL_BYTES = 256 * 1024

export function skillsDirectory(workspacePath) {
    return join(workspacePath, SKILLS_DIRECTORY)
}

export function skillPath(workspacePath, name) {
    return join(skillsDirectory(workspacePath), validName(name), 'SKILL.md')
}

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

export function explainDiagnostic(diagnostic) {
    if (diagnostic.code !== 'parse_failed') return diagnostic
    return {
        ...diagnostic,
        message: `${diagnostic.message.trim()}\n\nThe part between the --- lines is YAML. A description that contains a colon has to be quoted: description: "How to build a level: the rule".`
    }
}

export function skillsPromptBlock(skills, disabled = []) {
    const off = new Set(disabled)
    return formatSkillsForSystemPrompt(skills.filter(skill => !off.has(skill.name)))
}

export const MAX_SKILLS_PROMPT_BYTES = 32 * 1024

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

function withinBudget(skills, disabled) {
    let kept = skills
    let block = skillsPromptBlock(kept, disabled)
    while (kept.length > 0 && Buffer.byteLength(block) > MAX_SKILLS_PROMPT_BYTES) {
        kept = kept.slice(0, -1)
        block = skillsPromptBlock(kept, disabled)
    }
    return block
}

export const MAX_BUNDLE_FILES = 256
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024

export async function importSkillFile(env, workspacePath, sourcePath) {
    const picked = await pickedSkill(sourcePath)
    const source = await readFile(picked.skillFile, 'utf8')
    if (Buffer.byteLength(source) > MAX_SKILL_BYTES) {
        throw new Error('That file is too large to be a skill')
    }
    const name = validName(await nameFor(env, picked.skillFile, source))
    const directory = join(skillsDirectory(workspacePath), name)
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
        await rm(directory, {recursive: true, force: true})
        throw error
    }
    return name
}

async function pickedSkill(sourcePath) {
    const info = await stat(sourcePath)
    if (!info.isDirectory()) return {skillFile: sourcePath}
    const skillFile = join(sourcePath, 'SKILL.md')
    if (!(await exists(skillFile))) {
        throw new Error(`"${basename(sourcePath)}" holds no SKILL.md, so it is not a skill`)
    }
    return {skillFile, folder: sourcePath}
}

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

async function nameFor(env, sourcePath, source) {
    const fallback = fallbackName(sourcePath)
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

function fallbackName(sourcePath) {
    const file = basename(sourcePath).replace(/\.md$/iu, '')
    const named = file.toLowerCase() === 'skill' ? basename(join(sourcePath, '..')) : file
    return named
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
}
