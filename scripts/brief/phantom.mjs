/**
 * A path refine ASSERTS is already there, that is not.
 *
 * refine reads little and writes confidently, so it names files by the shape it expects
 * them to have. A path it invented rides through every later phase unchallenged — research
 * looks up what it was asked about, compose is told to use only paths the research holds,
 * and the implementer ends up creating the invented file to satisfy the rule.
 *
 * Only assertions are checked. A path the task is meant to CREATE is absent on purpose, so
 * a line that says so is left alone; the check is for the ones nothing claims to write.
 */

import {access} from 'node:fs/promises'
import {isAbsolute, join, normalize} from 'node:path'

const TOKEN = /`([^`\s]+)`/gu

const SOURCE = /\.(?:gd|tscn|tres|gdshader|godot|cfg|json|import|uid|png|md|ts|mjs)$/iu

/** Words that make a line a plan to write the file rather than a claim it is there. */
/// "new" alone is not one of them: the word appears in prose about files that already exist,
/// and matching it exempted every line holding it from the check.
const CREATES = /\b(?:create[sd]?|creating|scaffold|generate[sd]?|does not exist|not exist yet)\b/iu

const strip = path => path.replace(/^res:\/\//u, '').replace(/^\.\//u, '')

/// A `user://` path is written at runtime and a glob names no one file, so neither is ever on disk.
const NOT_A_FILE = /^user:\/\/|[*?[\]]/u

/** Paths named as files of this project: a real extension, and not a bare class name. */
export function namedPaths(text) {
    const found = new Map()
    for (const line of (text ?? '').split('\n')) {
        if (CREATES.test(line)) continue
        for (const match of line.matchAll(TOKEN)) {
            const path = strip(match[1])
            if (NOT_A_FILE.test(match[1])) continue
            if (!SOURCE.test(path)) continue
            if (isAbsolute(path) || normalize(path).startsWith('..')) continue
            // Keyed by the resolved path, valued by the spelling the task used: a
            // correction that renames res:// to a bare path reads as a second mistake.
            if (!found.has(path)) found.set(path, match[0])
        }
    }
    return found
}

const onDisk = async full => {
    try {
        await access(full)
        return true
    } catch {
        return false
    }
}

/** Every asserted path that is not in the workspace, in the spelling the task used. */
export async function findPhantomPaths(text, workspacePath, exists = onDisk) {
    const named = namedPaths(text)
    const missing = []
    for (const [path, token] of named) {
        if (!(await exists(join(workspacePath, path)))) missing.push(token)
    }
    return missing
}

/**
 * The correction, as its own bare-headed section so compose folds it into CONSTRAINTS.
 *
 * Appended rather than subtracted, unlike a refutation: an absent path does not make the
 * rule around it wrong, it makes the spelling wrong, and only a person knows which.
 */
export function formatPathCorrections(missing) {
    if (missing.length === 0) return ''
    const lines = missing.map(
        token => `- ${token} is not in this project; the task names it as if it were already there`
    )
    return `CORRECTIONS\n${lines.join('\n')}`
}
