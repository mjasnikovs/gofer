export const GREP_TOOL_NAME = 'grep'

// Directories a project search is never about. `.gofer` as a whole is not one of them: the agent's
// own verification scripts live in `.gofer/checks` and it named them 93 times in one project's
// history. Prefix-matched against the workspace-relative path, so a nested `.git` is skipped too.
// `.gofer/skills` is the user's, and `bash` is already refused there — see workspace-confinement.
export const SKIPPED = ['.git', '.godot', '.gofer/skills', '.gofer/blobs']

export const DEFAULT_MATCH_LIMIT = 100

// DEFAULT_MAX_BYTES and GREP_MAX_LINE_LENGTH in pi-agent-core's harness/utils/truncate.js. Its
// exports map does not publish them, so they are redeclared rather than imported.
export const MAX_OUTPUT_BYTES = 50 * 1024
export const MAX_LINE_CHARS = 500

// The largest file worth searching. Above this it is generated, packed or a database, and the
// answer a model wants from it is not a line of text.
export const LARGEST_SEARCHED_FILE_BYTES = 1024 * 1024

// Extensions a project search is never about, skipped before the file is opened. The zero-byte
// check below is still the rule — this only spares a Godot project's assets, which are the bulk of
// its bytes and none of its text.
const NEVER_TEXT =
    /\.(?:png|jpe?g|gif|webp|bmp|ico|svgz|tga|exr|hdr|dds|ktx|wav|ogg|mp3|flac|opus|mp4|webm|ttf|otf|woff2?|zip|gz|zst|pck|so|dll|dylib|exe|wasm|sqlite|db|blend|psd|fbx|glb)$/iu

const DESCRIPTION =
    'Search the contents of the project files for a pattern, and return the matching lines with '
    + 'their paths and line numbers. Reach for this before a shell command: it searches scenes and '
    + 'resources the shell is not allowed to name, and it skips the editor cache. '
    + `Stops at ${DEFAULT_MATCH_LIMIT} matches a pattern or ${MAX_OUTPUT_BYTES / 1024}KB in all, `
    + 'whichever comes first, and says so when it does.'

const PARAMETERS = {
    type: 'object',
    properties: {
        pattern: {
            oneOf: [{type: 'string'}, {type: 'array', items: {type: 'string'}}],
            description:
                'A JavaScript regular expression, tested against each line on its own, so ^ and $ '
                + 'are the start and end of a line. This is not grep: [[:alpha:]], \\< and \\> mean '
                + 'nothing here. To search for text exactly as written, set literal. Pass a list '
                + 'to run several searches over the same files in one call, each answered under '
                + 'its own heading — that is one call and one pass, not one per pattern.'
        },
        path: {
            oneOf: [{type: 'string'}, {type: 'array', items: {type: 'string'}}],
            description:
                'A file to search, or a directory to search under, named the way the project does '
                + '— scripts/enemy, not its full path. Several are given as a list: '
                + '["scripts", "test_scenes"]. Leave it out to search the whole project.'
        },
        glob: {
            type: 'string',
            description:
                'Only search files whose name ends this way, as *.gd. Several are separated by '
                + 'commas: *.gd,*.tscn. It narrows a search of the project or a folder; a file '
                + 'named by path is searched either way.'
        },
        ignoreCase: {type: 'boolean', description: 'Match regardless of case.'},
        literal: {
            type: 'boolean',
            description: 'Search for pattern as exact text rather than as a regular expression.'
        },
        context: {
            type: 'integer',
            description: 'Lines of surrounding text to show each side of a match. None by default.'
        },
        limit: {
            type: 'integer',
            description: `Matches to return before stopping. ${DEFAULT_MATCH_LIMIT} by default.`
        },
        filesOnly: {
            type: 'boolean',
            description:
                'Return the paths of the files that match and no lines, to find where something '
                + 'lives before reading it.'
        },
        countOnly: {
            type: 'boolean',
            description:
                'Return how many lines match and nothing else, one number per pattern. Counting '
                + 'ignores limit, because a count of everything is still one number.'
        }
    },
    required: ['pattern']
}

/// Builds the line matcher.
///
/// No `g`: the matcher is reused per line, and a carried lastIndex would skip every other match.
/// No `m`: matching is line by line already. No `u`: with it, the GNU word marks a model reaches
/// for are a SyntaxError, and a refused call costs a whole request; without it they degrade to the
/// bare character.
// A list written as a string — `["scripts", "scenes"]` — is a list: a live turn wrote it that way,
// was told the file did not exist, and searched one folder instead of two.
function listWrittenAsText(path) {
    if (typeof path !== 'string' || !path.trim().startsWith('[')) return undefined
    try {
        const parsed = JSON.parse(path)
        return Array.isArray(parsed) ? parsed : undefined
    } catch {
        return undefined
    }
}

export function pathsOf(path) {
    const given = listWrittenAsText(path) ?? path
    const many = Array.isArray(given) ? given : [given ?? '.']
    const kept = many.filter(one => typeof one === 'string' && one !== '')
    return kept.length === 0 ? ['.'] : kept
}

export function patternsOf(pattern) {
    const many = Array.isArray(pattern) ? pattern : [pattern]
    const kept = many.filter(one => typeof one === 'string' && one !== '')
    if (kept.length === 0) throw new Error('grep needs a pattern to search for')
    return kept
}

export function matcherFor({pattern, literal, ignoreCase}) {
    const source = literal ? pattern.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&') : pattern
    try {
        return new RegExp(source, ignoreCase ? 'i' : '')
    } catch (error) {
        throw new Error(
            `grep could not read \`${pattern}\` as a JavaScript regular expression: `
                + `${error.message}. This is JavaScript syntax, not grep — [[:alpha:]], \\< and \\> `
                + 'are not part of it. To search for the text exactly as written, pass literal.'
        )
    }
}

export function suffixesOf(glob) {
    if (typeof glob !== 'string' || glob.trim() === '') return undefined
    const suffixes = glob
        .split(',')
        .map(one => one.trim().replace(/^\*/u, ''))
        .filter(one => one !== '')
    return suffixes.length > 0 ? suffixes : undefined
}

function isMedia(name) {
    return NEVER_TEXT.test(name)
}

function nameMatches(name, suffixes) {
    if (suffixes === undefined) return true
    return suffixes.some(suffix => name.endsWith(suffix))
}

export function isSkipped(relativePath) {
    return SKIPPED.some(one => relativePath === one || relativePath.startsWith(`${one}/`))
}

function truncatedLine(text) {
    if (text.length <= MAX_LINE_CHARS) return {text, cut: false}
    return {text: `${text.slice(0, MAX_LINE_CHARS)}... [truncated]`, cut: true}
}

/// The rows of one file that match, one block per match, already formatted and capped.
///
/// A block, rather than a flat list, is what lets the caller stop on the match the limit names and
/// still know a further one existed. Context is sliced from the same lines rather than merged:
/// overlapping context repeats, which is the shape of the output these models already know.
export function searchText(text, label, matcher, {context = 0, room}) {
    const lines = text.split('\n')
    const blocks = []
    let cut = false
    for (const [index, line] of lines.entries()) {
        if (blocks.length >= room) break
        if (!matcher.test(line)) continue
        const from = Math.max(0, index - context)
        const to = Math.min(lines.length - 1, index + context)
        const block = []
        for (let at = from; at <= to; at += 1) {
            const shown = truncatedLine(lines[at])
            cut ||= shown.cut
            const separator = at === index ? ':' : '-'
            block.push(`${label}${separator}${at + 1}${separator} ${shown.text}`)
        }
        blocks.push(block)
    }
    return {blocks, cut}
}

function noticesFor({limit, limitReached, bytesReached, cut, oversized, unreadable}) {
    const notices = []
    if (limitReached) {
        notices.push(
            `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`
        )
    }
    if (bytesReached) notices.push(`${MAX_OUTPUT_BYTES / 1024}.0KB limit reached`)
    if (cut) {
        notices.push(
            `Some lines truncated to ${MAX_LINE_CHARS} chars. Use read tool to see full lines`
        )
    }
    if (unreadable > 0) {
        notices.push(
            `${unreadable} ${unreadable === 1 ? 'folder' : 'folders'} could not be opened, so `
                + 'nothing in them was searched'
        )
    }
    if (oversized > 0) {
        notices.push(
            `${oversized} ${oversized === 1 ? 'file' : 'files'} skipped as too large to search. `
                + 'Read one with the read tool'
        )
    }
    return notices
}

/// The label a path is shown and matched under.
///
/// Both separators are folded to `/`, because the walk runs on whatever the OS hands back and the
/// skip list, the glob and every line the model reads are written one way.
export function workspaceRelative(root, path) {
    const flat = one => one.replace(/\\/gu, '/').replace(/\/+$/u, '')
    const flatRoot = flat(root)
    const flatPath = flat(path)
    if (flatPath === flatRoot) return ''
    return flatPath.startsWith(`${flatRoot}/`) ? flatPath.slice(flatRoot.length + 1) : flatPath
}

async function unwrap(result, what) {
    if (result.ok) return result.value
    throw new Error(`grep could not ${what}: ${result.error.message}`)
}

/// One block per pattern, and no heading at all when there is only one — a single search reads as
/// it always did, and a batch says which answer belongs to which pattern.
function answerText(searches, countOnly) {
    if (countOnly) return searches.map(one => `${one.pattern}: ${one.found}`).join('\n')
    if (searches.length === 1) {
        return searches[0].rows.length === 0 ? 'No matches found' : searches[0].rows.join('\n')
    }
    return searches
        .map(
            one =>
                `${one.pattern}:\n${one.rows.length === 0 ? 'No matches found' : one.rows.join('\n')}`
        )
        .join('\n\n')
}

export function createGrepTool() {
    return {
        name: GREP_TOOL_NAME,
        label: 'grep',
        description: DESCRIPTION,
        parameters: PARAMETERS,
        execute: async (_toolCallId, params, signal, _onUpdate, {env}) => {
            const given = params ?? {}
            const searches = patternsOf(given.pattern).map(pattern => ({
                pattern,
                matcher: matcherFor({...given, pattern}),
                rows: [],
                found: 0
            }))
            const suffixes = suffixesOf(given.glob)
            const limit = Math.max(1, given.limit ?? DEFAULT_MATCH_LIMIT)
            const context = Math.max(0, given.context ?? 0)
            const root = await unwrap(await env.absolutePath('.', signal), 'find the project root')
            const named = pathsOf(given.path)

            const state = {bytes: 0, oversized: 0, unreadable: 0, cut: false, full: false}
            const append = (search, row) => {
                const size = Buffer.byteLength(row) + 1
                if (state.bytes + size > MAX_OUTPUT_BYTES) {
                    state.full = true
                    return false
                }
                search.rows.push(row)
                state.bytes += size
                return true
            }

            // A count is not capped: counting every match still answers in one number, and a
            // count that stopped early would be a wrong answer rather than a short one.
            const roomFor = search => {
                if (given.countOnly) return Number.MAX_SAFE_INTEGER
                if (given.filesOnly) return 1
                return limit + 1 - search.found
            }

            const searchFile = async file => {
                if (file.size > LARGEST_SEARCHED_FILE_BYTES) {
                    state.oversized += 1
                    return
                }
                const bytes = await env.readBinaryFile(file.path, signal)
                if (!bytes.ok || bytes.value.includes(0)) return
                const label = workspaceRelative(root, file.path)
                const text = new TextDecoder().decode(bytes.value)
                for (const search of searches) {
                    if (state.full) return
                    if (!given.countOnly && search.found > limit) continue
                    const found = searchText(text, label, search.matcher, {
                        context,
                        room: roomFor(search)
                    })
                    state.cut ||= found.cut
                    if (given.countOnly) {
                        search.found += found.blocks.length
                        continue
                    }
                    if (given.filesOnly) {
                        if (found.blocks.length > 0 && append(search, label)) search.found += 1
                        continue
                    }
                    for (const block of found.blocks) {
                        search.found += 1
                        if (search.found > limit) break
                        for (const row of block) {
                            if (!append(search, row)) return
                        }
                    }
                }
            }

            const exhausted = () =>
                state.full || (!given.countOnly && searches.every(search => search.found > limit))

            const walk = async directory => {
                const entries = await env.listDir(directory, signal)
                if (!entries.ok) {
                    state.unreadable += 1
                    return
                }
                const sorted = [...entries.value].sort((a, b) => a.name.localeCompare(b.name))
                for (const entry of sorted.filter(one => one.kind === 'file')) {
                    if (exhausted()) return
                    if (isSkipped(workspaceRelative(root, entry.path))) continue
                    if (isMedia(entry.name) || !nameMatches(entry.name, suffixes)) continue
                    await searchFile(entry)
                }
                for (const entry of sorted.filter(one => one.kind === 'directory')) {
                    if (exhausted()) return
                    if (isSkipped(workspaceRelative(root, entry.path))) continue
                    await walk(entry.path)
                }
            }

            for (const one of named) {
                const start = await unwrap(await env.absolutePath(one, signal), `find ${one}`)
                const info = await unwrap(
                    await env.fileInfo(start, signal),
                    `open ${one}${one.includes(',') ? ' — one path, or a list of them: ["scripts", "scenes"]' : ''}`
                )
                if (info.kind === 'file') await searchFile(info)
                else if (info.kind === 'directory') await walk(start)
                else throw new Error(`grep cannot search ${one}, which is not a file or folder`)
            }

            const notices = noticesFor({
                limit,
                limitReached: !given.countOnly && searches.some(search => search.found > limit),
                bytesReached: state.full,
                cut: state.cut,
                oversized: state.oversized,
                unreadable: state.unreadable
            })
            const body = answerText(searches, given.countOnly === true)
            const text = notices.length === 0 ? body : `${body}\n\n[${notices.join('. ')}]`
            return {
                content: [{type: 'text', text}],
                details: {
                    matches: searches.reduce((total, search) => total + search.found, 0),
                    truncated: notices.length > 0
                }
            }
        }
    }
}
