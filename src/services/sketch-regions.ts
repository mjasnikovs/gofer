export function remoteReferences(html: string): readonly string[] {
    const found: string[] = []
    for (const pattern of [
        /<link\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/giu,
        /\bsrc\s*=\s*["']([^"']+)["']/giu,
        /\bsrcset\s*=\s*["']([^"',\s]+)/giu,
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

function isRemote(value: string): boolean {
    if (/^(?:data|blob|about|res):/iu.test(value)) return false
    return /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(value)
}

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
    const match = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/]+)(\/.*)?$/iu.exec(withoutQuery)
    if (!match) return withoutQuery.slice(0, 80)
    const [, origin = '', path = ''] = match
    const file = path.split('/').filter(Boolean).pop()
    return file ? `${origin}/…/${file}` : origin
}
