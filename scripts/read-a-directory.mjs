// A model asks for the contents of a folder on its first turn, every turn, and it has no tool that
// answers one: it reaches for `bash ls`, and inside .gofer/skills that is refused twice over. So a
// read of a folder answers with what is in it rather than with an error about it not being a file.
export const LISTS_A_DIRECTORY =
    'Reading a folder answers with what is directly in it, one name a line, a folder marked with a '
    + 'trailing slash.'

export const MOST_ENTRIES = 500

export function listingOf(entries, {more = false} = {}) {
    if (entries.length === 0) return '(this folder is empty)'
    const named = entries.map(entry => (entry.kind === 'directory' ? `${entry.name}/` : entry.name))
    const body = named.sort((a, b) => a.localeCompare(b)).join('\n')
    return more ? `${body}\n\n[only the first ${MOST_ENTRIES} are shown]` : body
}

export function readsADirectory(tool) {
    return {
        ...tool,
        description: `${tool.description} ${LISTS_A_DIRECTORY}`,
        execute: async (id, params, signal, onUpdate, context) => {
            const listed = await listing(context?.env, params?.path, signal)
            if (listed !== undefined) return listed
            return tool.execute(id, params, signal, onUpdate, context)
        }
    }
}

async function listing(env, path, signal) {
    if (env === undefined || typeof path !== 'string') return undefined
    const at = await env.absolutePath(path, signal)
    if (!at.ok) return undefined
    const info = await env.fileInfo(at.value, signal)
    if (!info.ok || info.value.kind !== 'directory') return undefined
    const entries = await env.listDir(at.value, signal)
    if (!entries.ok) return undefined
    const shown = entries.value.slice(0, MOST_ENTRIES)
    const text = listingOf(shown, {more: entries.value.length > MOST_ENTRIES})
    return {content: [{type: 'text', text}], details: {entries: entries.value.length}}
}
