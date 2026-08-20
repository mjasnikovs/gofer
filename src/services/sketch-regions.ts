/**
 * What a sketch asks the world for, and what it will not get.
 *
 * The frame runs under a policy that refuses everything remote, and it has no console anybody reads.
 * So a webfont that never arrived reaches the agent as "the user says it looks wrong" with no cause
 * attached — unless somebody says so, which is what this file is for.
 */

/**
 * Every remote thing a sketch asks for, read out of the markup rather than waited for.
 *
 * The listener in `SketchFrame` catches what the policy refuses, but only from the moment it is
 * attached — and a frame has already parsed its markup and started fetching by the time its `load`
 * event fires. Measured against a real WebKitGTK: a remote `<img>` in the first revision is refused
 * and reported to nobody. So the markup is read as well, which needs no timing to be right.
 *
 * Deliberately only what *loads*. A link to a web page is a link, harmless and often the point; a
 * stylesheet, a font, an image or a frame is a hole in the layout the user is being asked to judge.
 */
export function remoteReferences(html: string): readonly string[] {
    const found: string[] = []
    for (const pattern of [
        // src= and href= on anything that fetches. `href` is read only on <link>, because on an
        // anchor it is a destination and not a request.
        /<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/giu,
        /\bsrc\s*=\s*["']([^"']+)["']/giu,
        // Up to the first space as well as the first comma: a srcset entry is a URL followed by
        // its descriptor, and "hero@2x.jpg 2x" is not something anybody asked the network for.
        /\bsrcset\s*=\s*["']([^"',\s]+)/giu,
        // url(...) inside a style block or attribute, and @import in either form.
        /url\(\s*["']?([^"')]+)/giu,
        /@import\s+["']([^"']+)["']/giu
    ]) {
        for (const match of html.matchAll(pattern)) {
            const value = match[1]?.trim()
            if (value && isRemote(value)) found.push(value)
        }
    }
    return describeBlocked(found)
}

/**
 * Anything that leaves the machine.
 *
 * `data:` and `blob:` are already in the document. `res://` is Godot's own spelling for the project
 * root, and the backend has already read those out of the workspace and put them in the page — one
 * that is still spelt that way by the time it reaches here is reported as a missing project file,
 * which is a different mistake with a different fix.
 */
function isRemote(value: string): boolean {
    if (/^(?:data|blob|about|res):/iu.test(value)) return false
    return /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(value)
}

/**
 * The resources the policy refused, deduplicated and shortened.
 *
 * A blocked URL arrives as whatever the sketch asked for, which for a webfont is a query string
 * longer than the sentence carrying it. The origin and the filename are the two parts that identify
 * it; the rest is noise in a tool result the agent pays for by the character.
 */
export function describeBlocked(uris: readonly string[]): readonly string[] {
    const seen = new Set<string>()
    for (const uri of uris) {
        const trimmed = uri.trim()
        if (!trimmed) continue
        seen.add(shorten(trimmed))
        if (seen.size >= 8) break
    }
    return [...seen]
}

function shorten(uri: string): string {
    const withoutQuery = uri.split(/[?#]/u)[0] ?? uri
    // The scheme is optional: a protocol-relative `//host/path` is a request like any other, and
    // reading it the same way keeps every entry in the list the same shape.
    const match = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/]+)(\/.*)?$/iu.exec(withoutQuery)
    if (!match) return withoutQuery.slice(0, 80)
    const [, origin = '', path = ''] = match
    const file = path.split('/').filter(Boolean).pop()
    return file ? `${origin}/…/${file}` : origin
}
