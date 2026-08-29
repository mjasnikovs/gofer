/**
 * Skills: the instructions this project adds to its agent, as the Skills tab reads them.
 *
 * A skill is `.gofer/skills/<name>/SKILL.md`. Only its name and description reach the model; the
 * body is read by the agent's own read tool, on the turn whose work matches the description. So
 * the description is not decoration here — it is the only thing deciding whether a skill is ever
 * used, which is why the tab shows it on the row rather than behind the editor.
 */

export type Skill = Readonly<{
    name: string
    description: string
    /** Where the agent will read it, which is what the prompt block hands the model. */
    path: string
    /** Whether this project sends it. */
    enabled: boolean
    /**
     * Turned off by the file's own `disable-model-invocation`, which the project cannot override.
     * Shown so the row explains itself rather than looking like a toggle that will not stick.
     */
    hidden: boolean
}>

/**
 * A file under `.gofer/skills` that is not a skill, and why.
 *
 * Shown rather than swallowed. A `SKILL.md` with no description loads as nothing at all, so
 * without the warning beside it the row would simply never appear and the user would have no way
 * to find out what was wrong with a file they had just added.
 */
export type SkillWarning = Readonly<{
    code: string
    message: string
    path: string
}>

export type SkillsResponse = Readonly<{
    skills: readonly Skill[]
    warnings: readonly SkillWarning[]
}>

/** The frontmatter a new skill starts with, so the first save is a skill and not a warning. */
export function skillTemplate(name: string) {
    return `---\nname: ${name}\ndescription: \n---\n\n`
}
