import {expect} from '@wdio/globals'
import {browser} from '@wdio/tauri-service'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

type SkillRow = Readonly<{name: string; description: string; path: string}>
type SkillsResponse = Readonly<{skills: readonly SkillRow[]; warnings: readonly unknown[]}>

/** Invokes one of the application's own commands in the built renderer. */
function command<Response>(name: string, payload: Record<string, unknown>): Promise<Response> {
    return browser.execute(
        async (invoked: string, argument: Record<string, unknown>) => {
            const invoke = window.__TAURI__?.core?.invoke
            if (!invoke) throw new Error('Tauri invoke is unavailable in the built renderer')
            return invoke(invoked, argument)
        },
        name,
        payload
    ) as Promise<Response>
}

const workspace = process.env.GOFER_SKILLS_SMOKE_WORKSPACE ?? ''
const folder = process.env.GOFER_SKILLS_SMOKE_FOLDER ?? ''

describe('a skill that is a folder', () => {
    /**
     * The whole point of importing a folder. `SKILL.md` is the only part the model is told about,
     * and it names the rest by relative path — so a skill whose references were left behind is one
     * the agent is told about and then cannot read.
     */
    it('lands in the project with the files its SKILL.md points at', async () => {
        expect(workspace).not.toBe('')
        expect(folder).not.toBe('')

        const answer = await command<SkillsResponse>('import_skill', {sourcePath: folder})

        const imported = answer.skills.find(one => one.description.length > 0)
        expect(imported).toBeDefined()
        const directory = join(workspace, '.gofer', 'skills', imported?.name ?? '')
        expect(existsSync(join(directory, 'SKILL.md'))).toBe(true)

        // Every relative path the skill names is a file the agent will open. They have to be there.
        const body = readFileSync(join(directory, 'SKILL.md'), 'utf8')
        const referenced = [...body.matchAll(/`([\w./-]+\.md)`/gu)]
            .map(match => match[1])
            .filter((one): one is string => one !== undefined)
        expect(referenced.length).toBeGreaterThan(0)
        for (const reference of referenced) {
            expect(existsSync(join(directory, reference))).toBe(true)
        }

        // And the loader lists it, which is what the tab draws and what the prompt block is made of.
        const listed = await command<SkillsResponse>('list_skills', {})
        expect(listed.skills.map(one => one.name)).toContain(imported?.name)
    })

    /**
     * A folder with no SKILL.md is not a skill, and nothing is copied for it.
     *
     * The message rather than the code, because a command's failure crosses WebDriver as the text
     * of a script error: the structured `CommandError` the renderer receives does not survive the
     * trip out to the runner.
     */
    it('refuses a folder that holds no SKILL.md', async () => {
        await expect(command('import_skill', {sourcePath: workspace})).rejects.toThrow(
            /A skill folder holds a SKILL\.md/u
        )
    })
})
