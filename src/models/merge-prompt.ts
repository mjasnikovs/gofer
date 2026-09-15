/** The two refusals a merge answers with when the branches disagree, and only those. */
export function isMergeClash(code: string): boolean {
    return code === 'task_merge_conflicted' || code === 'task_merge_unfinished'
}

export function conflictPrompt(conflicts: readonly string[]): string {
    return [
        "I have brought the project's branch into this task and Git could not merge these files.",
        'Each one now holds both versions, marked with <<<<<<<, ======= and >>>>>>>:',
        ...conflicts.map(path => `- ${path}`),
        '',
        'Read each one, keep what both sides were trying to do, and remove every marker. Write a',
        'scene through the scene tools and a script through script.edit, not as raw text. When',
        'nothing is left holding both versions, say so and stop — I will merge from there.'
    ].join('\n')
}
