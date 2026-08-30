export type Skill = Readonly<{
    name: string
    description: string
    path: string
    enabled: boolean
    hidden: boolean
}>

export type SkillWarning = Readonly<{
    code: string
    message: string
    path: string
}>

export type SkillsResponse = Readonly<{
    skills: readonly Skill[]
    warnings: readonly SkillWarning[]
}>

export function skillTemplate(name: string) {
    return `---\nname: ${name}\ndescription: \n---\n\n`
}
