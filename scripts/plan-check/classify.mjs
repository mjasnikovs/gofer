// Is this backticked token a claim about a file in the repo?
//
// Measured over 105 CONSTRAINTS sections in hub/.pi-tasks: keying on
// "has a dot or a slash" leaves 32% of tokens unresolvable, and none of
// that 32% was a phantom path. Each rejection below removes one measured
// shape - npm specifiers, URL routes, MIME types, bare extensions,
// relative import specifiers, dotted code expressions - and together they
// bring it to 3.4%.

const SRC_EXT =
    /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|ya?ml|css|html|gd|tscn|tres|rs|toml|sh|py|go|txt|lock)$/
// `…` is U+2026, not three dots - real plans elide with the character.
const GLOB = /[*?…]|\.\.\./

export function isFileClaim(token) {
    if (GLOB.test(token)) return false
    // `<data_root>/sketches/<id>.html` - a template, not a path.
    if (token.includes('<') || token.includes('>')) return false
    // `.ts/.tsx` - a pair of extensions written as one token, not a directory.
    if (/^\.\w+\//.test(token)) return false
    if (token.startsWith('@')) return false
    if (token.startsWith('/')) return false
    if (token.startsWith('./') || token.startsWith('../')) return false
    if (token.startsWith('.') && !token.includes('/')) return false
    return SRC_EXT.test(token)
}
