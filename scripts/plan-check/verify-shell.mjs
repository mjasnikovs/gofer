// The two VERIFY predicates, ported from pi-task rather than rewritten:
// verify-quality.ts (grep theater) and unfailable-command.ts (exit status
// destroyed by construction). Both are pure text analysis over one command.
//
// Ported, not adapted. The tables and the rule boundaries are theirs; the
// evidence behind them - a build "verified" by three greps that shipped broken
// for 14 tasks - is not evidence this repo re-gathered.

const STATIC_HEADS = new Set([
    'grep',
    'rg',
    'cat',
    'ls',
    'test',
    '[',
    '[[',
    'find',
    'wc',
    'head',
    'tail',
    'diff',
    'stat',
    'echo',
    'printf',
    'true',
    'false',
    'cd',
    'pwd',
    'which',
    'command',
    'file',
    'jq',
    'sed',
    'awk',
    'sort',
    'uniq',
    'cut',
    'tr',
    'sleep',
    'exit',
    // static-analysis tools: they read source, they don't run the deliverable
    'tsc',
    'eslint',
    'prettier',
    'biome'
])
const INSPECT_HEADS = new Set(['grep', 'rg', 'cat', 'head', 'tail', 'wc'])
const RUNNABLE_SRC_RE = /^[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|sh)$/
const CONTROL_PREFIX = new Set(['if', 'elif', 'while', 'until', 'then', 'else', 'do', '!'])
const CONTROL_ONLY = new Set(['}', ')', 'fi', 'done', 'esac'])

// An unknown head counts as execution and skips the block, so the error
// direction is a missed finding, never a false one.
function segmentHead(segment) {
    const tokens = segment.split(/\s+/).filter(t => t.length > 0)
    let i = 0
    while (i < tokens.length) {
        const t = tokens[i].replace(/^[({!]+/, '')
        if (t.length === 0 || CONTROL_PREFIX.has(t)) {
            i++
            continue
        }
        tokens[i] = t
        break
    }
    if (i >= tokens.length || CONTROL_ONLY.has(tokens[i])) return null
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
    if (i < tokens.length && tokens[i] === 'timeout') {
        i++
        if (i < tokens.length && /^\d/.test(tokens[i])) i++
    }
    if (i >= tokens.length) return null
    let head = tokens[i]
    if (head === 'bunx' || head === 'npx') {
        i++
        while (i < tokens.length && tokens[i].startsWith('-')) i++
        if (i >= tokens.length) return null
        head = tokens[i]
    }
    return {head, args: tokens.slice(i + 1)}
}

// One finding per runnable source file the block only inspects. Empty when any
// command in the block actually executes something.
export function findGrepOnlyVerify(cmds) {
    const inspected = new Map()
    for (const raw of cmds) {
        for (const segment of raw.split(/&&|\|\||;|\|/)) {
            const s = segmentHead(segment)
            if (s === null) continue
            if (!STATIC_HEADS.has(s.head)) return []
            if (!INSPECT_HEADS.has(s.head)) continue
            for (const arg of s.args) {
                if (arg.startsWith('-') || arg.startsWith("'") || arg.startsWith('"')) continue
                if (!RUNNABLE_SRC_RE.test(arg)) continue
                const lines = inspected.get(arg) ?? []
                if (!lines.includes(raw)) lines.push(raw)
                inspected.set(arg, lines)
            }
        }
    }
    return [...inspected.entries()].map(([target, lines]) => ({target, lines}))
}

// ─── exit status ─────────────────────────────────────────────────────────────

function splitTopLevel(s, seps) {
    const parts = []
    const ops = []
    let buf = ''
    let depth = 0
    let quote = null
    for (let i = 0; i < s.length; i++) {
        const c = s[i]
        if (quote !== null) {
            buf += c
            if (c === '\\' && quote === '"') {
                if (i + 1 < s.length) buf += s[++i]
                continue
            }
            if (c === quote) quote = null
            continue
        }
        if (c === '\\') {
            buf += c
            if (i + 1 < s.length) buf += s[++i]
            continue
        }
        if (c === '"' || c === "'" || c === '`') {
            quote = c
            buf += c
            continue
        }
        if (c === '(' || (c === '{' && /(?:^|\s)$/.test(buf))) {
            depth++
            buf += c
            continue
        }
        if (c === ')' || (c === '}' && depth > 0)) {
            depth = Math.max(0, depth - 1)
            buf += c
            continue
        }
        if (depth === 0) {
            const hit = seps.find(sep => s.startsWith(sep, i))
            if (hit !== undefined) {
                parts.push(buf)
                ops.push(hit)
                buf = ''
                i += hit.length - 1
                continue
            }
        }
        buf += c
    }
    parts.push(buf)
    return {parts, ops}
}

const segmentsOf = cmd =>
    splitTopLevel(cmd, [';'])
        .parts.map(p => p.trim())
        .filter(p => p.length > 0)
const chain = seg => {
    const {parts, ops} = splitTopLevel(seg, ['&&', '||'])
    return {parts: parts.map(p => p.trim()), ops}
}
const hasPipeline = seg => splitTopLevel(seg, ['||', '|']).ops.includes('|')

// Which commands of an &&/|| chain can be the LAST one executed. A chain that
// mixes the two operators after c_i always runs on past it.
function terminalIndices(ops, n) {
    const out = []
    for (let i = 0; i < n; i++) {
        if (i === n - 1) {
            out.push(i)
            continue
        }
        const rest = ops.slice(i, n - 1)
        if (rest.every(o => o === '&&') || rest.every(o => o === '||')) out.push(i)
    }
    return out
}

function commandWord(cmd) {
    let rest = cmd.trim()
    for (;;) {
        const m = /^(?:env\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)/.exec(rest)
        if (!m) break
        rest = rest.slice(m[0].length)
    }
    return /^[^\s]*/.exec(rest)?.[0] ?? ''
}

// A redirect CAN fail on a bad path, so an echo carrying one is not pure.
function isPureEcho(cmd) {
    const word = commandWord(cmd)
    if (word !== 'echo' && word !== 'printf') return false
    return !splitTopLevel(cmd, ['>>', '>']).ops.length
}

// console.assert prints and continues, in bun and node alike.
const ruleA = cmd =>
    cmd.includes('console.assert') && !/\bprocess\.exit\b|\bthrow\b|\bexit\s+\d/.test(cmd)
const ruleB = segs => segs.some((s, i) => i > 0 && s.includes('$?') && hasPipeline(segs[i - 1]))
function ruleC(seg) {
    const {parts, ops} = chain(seg)
    if (parts.length < 2) return false
    const terms = terminalIndices(ops, parts.length)
    return terms.length > 0 && terms.every(i => isPureEcho(parts[i]))
}

// Shapes this refuses to judge. `unknown` is a first-class answer.
function undecidable(t) {
    if (/(?:^|[;&|(]\s*)set\s+-[a-z]*e/.test(t)) return '`set -e` is in effect for this line'
    if (/^\$\([\s\S]*\)$/.test(t) || /^`[\s\S]*`$/.test(t))
        return 'the whole line is a command substitution'
    return null
}

export function classifyExitStatus(cmd) {
    const t = cmd.trim()
    if (t.length === 0) return {cls: 'can-fail', reason: ''}
    const skip = undecidable(t)
    if (skip !== null) return {cls: 'unknown', reason: skip}
    const segs = segmentsOf(t)
    if (segs.length === 0) return {cls: 'can-fail', reason: ''}
    if (ruleB(segs)) return {cls: 'unfailable', reason: 'B: `$?` is read after a pipeline'}
    const last = segs[segs.length - 1]
    if (ruleA(last)) return {cls: 'unfailable', reason: 'A: `console.assert` never exits non-zero'}
    if (ruleC(last))
        return {cls: 'unfailable', reason: 'C: every branch that can run LAST is an echo/printf'}
    return {cls: 'can-fail', reason: ''}
}
