import type {SyntaxToken} from '@astryxdesign/core/CodeBlock'

export const GDSCRIPT_LANGUAGE_ID = 'gdscript'

export const KEYWORDS = [
    'and',
    'as',
    'assert',
    'await',
    'break',
    'breakpoint',
    'class',
    'class_name',
    'const',
    'continue',
    'elif',
    'else',
    'enum',
    'extends',
    'for',
    'func',
    'if',
    'in',
    'is',
    'match',
    'not',
    'or',
    'pass',
    'preload',
    'return',
    'signal',
    'static',
    'super',
    'var',
    'when',
    'while',
    'yield'
]

export const CONSTANTS = ['true', 'false', 'null', 'self', 'PI', 'TAU', 'INF', 'NAN']

export const TYPES = [
    'Array',
    'Basis',
    'Callable',
    'Color',
    'Dictionary',
    'NodePath',
    'Object',
    'PackedByteArray',
    'PackedColorArray',
    'PackedFloat32Array',
    'PackedFloat64Array',
    'PackedInt32Array',
    'PackedInt64Array',
    'PackedStringArray',
    'PackedVector2Array',
    'PackedVector3Array',
    'Plane',
    'Quaternion',
    'RID',
    'Rect2',
    'Rect2i',
    'Signal',
    'String',
    'StringName',
    'Transform2D',
    'Transform3D',
    'Vector2',
    'Vector2i',
    'Vector3',
    'Vector3i',
    'Vector4',
    'Vector4i',
    'bool',
    'float',
    'int',
    'void'
]

const KEYWORD_SET = new Set(KEYWORDS)
const CONSTANT_SET = new Set(CONSTANTS)
const TYPE_SET = new Set(TYPES)

const FENCE_ALIASES = new Set(['gd', 'gdscript', 'godot'])

export function gdscriptFenceLanguage(fence: string | undefined): string | undefined {
    if (fence === undefined) return undefined
    return FENCE_ALIASES.has(fence.toLowerCase()) ? GDSCRIPT_LANGUAGE_ID : undefined
}

const BLOCK_QUOTE = '"""'
const PUNCTUATION = '{}()[],.;'
const OPERATOR = /[<>=!+\-*/%&|^~:]+/y
const NUMBER = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?/y
const ANNOTATION = /@[A-Za-z_]\w*/y
const NODE_PATH = /[$%](?:"[^"]*"|[A-Za-z_][\w/]*)/y
const WORD = /[A-Za-z_]\w*/y
const VALUE_END = /[\w)\]"']/

type LineScan = Readonly<{tokens: SyntaxToken[]; opensBlockString: boolean}>

function matchAt(pattern: RegExp, line: string, start: number): number {
    pattern.lastIndex = start
    const match = pattern.exec(line)
    return match === null ? -1 : start + match[0].length
}

/** Undefined where the code element's own colour is already right, which halves the token count. */
function wordType(word: string, line: string, end: number): string | undefined {
    if (KEYWORD_SET.has(word)) return 'keyword'
    if (CONSTANT_SET.has(word)) return 'constant'
    if (TYPE_SET.has(word)) return 'type'
    let next = end
    while (line[next] === ' ' || line[next] === '\t') next++
    return line[next] === '(' ? 'function' : undefined
}

/** `%Health` is a unique-name path, `a % b` is modulo, and only what precedes them tells the two apart. */
function followsValue(line: string, index: number): boolean {
    let previous = index - 1
    while (line[previous] === ' ' || line[previous] === '\t') previous--
    const before = line[previous]
    return before !== undefined && VALUE_END.test(before)
}

function quotedEnd(line: string, start: number): number {
    const quote = line[start]
    let end = start + 1
    while (end < line.length) {
        if (line[end] === '\\') {
            end += 2
            continue
        }
        if (line[end] === quote) return end + 1
        end++
    }
    return line.length
}

/**
 * Offsets are line-relative. A token spanning a newline would be mis-placed by Astryx's
 * flatTokensToLines, which assigns every token to the line holding its start.
 */
function scanLine(line: string, insideBlockString: boolean): LineScan {
    const tokens: SyntaxToken[] = []
    let index = 0
    if (insideBlockString) {
        const close = line.indexOf(BLOCK_QUOTE)
        if (close === -1) {
            if (line.length > 0) tokens.push({type: 'string', start: 0, end: line.length})
            return {tokens, opensBlockString: true}
        }
        index = close + BLOCK_QUOTE.length
        tokens.push({type: 'string', start: 0, end: index})
    }
    while (index < line.length) {
        const char = line[index] ?? ''
        if (char === ' ' || char === '\t') {
            index++
            continue
        }
        if (char === '#') {
            tokens.push({type: 'comment', start: index, end: line.length})
            break
        }
        if (line.startsWith(BLOCK_QUOTE, index)) {
            const close = line.indexOf(BLOCK_QUOTE, index + BLOCK_QUOTE.length)
            if (close === -1) {
                tokens.push({type: 'string', start: index, end: line.length})
                return {tokens, opensBlockString: true}
            }
            const end = close + BLOCK_QUOTE.length
            tokens.push({type: 'string', start: index, end})
            index = end
            continue
        }
        if (char === '"' || char === "'") {
            const end = quotedEnd(line, index)
            tokens.push({type: 'string', start: index, end})
            index = end
            continue
        }
        const annotationEnd = char === '@' ? matchAt(ANNOTATION, line, index) : -1
        if (annotationEnd !== -1) {
            tokens.push({type: 'attribute', start: index, end: annotationEnd})
            index = annotationEnd
            continue
        }
        const isPath = char === '$' || (char === '%' && !followsValue(line, index))
        const pathEnd = isPath ? matchAt(NODE_PATH, line, index) : -1
        if (pathEnd !== -1) {
            tokens.push({type: 'property', start: index, end: pathEnd})
            index = pathEnd
            continue
        }
        const numberEnd = char >= '0' && char <= '9' ? matchAt(NUMBER, line, index) : -1
        if (numberEnd !== -1) {
            tokens.push({type: 'number', start: index, end: numberEnd})
            index = numberEnd
            continue
        }
        const wordEnd = matchAt(WORD, line, index)
        if (wordEnd !== -1) {
            const type = wordType(line.slice(index, wordEnd), line, wordEnd)
            if (type !== undefined) tokens.push({type, start: index, end: wordEnd})
            index = wordEnd
            continue
        }
        if (PUNCTUATION.includes(char)) {
            tokens.push({type: 'punctuation', start: index, end: index + 1})
            index++
            continue
        }
        const operatorEnd = matchAt(OPERATOR, line, index)
        if (operatorEnd !== -1) {
            tokens.push({type: 'operator', start: index, end: operatorEnd})
            index = operatorEnd
            continue
        }
        index++
    }
    return {tokens, opensBlockString: false}
}

export function tokenizeGdscript(code: string): SyntaxToken[] {
    const tokens: SyntaxToken[] = []
    let lineStart = 0
    let insideBlockString = false
    for (const line of code.split('\n')) {
        const scan = scanLine(line, insideBlockString)
        for (const token of scan.tokens) {
            tokens.push({
                type: token.type,
                start: lineStart + token.start,
                end: lineStart + token.end
            })
        }
        insideBlockString = scan.opensBlockString
        lineStart += line.length + 1
    }
    return tokens
}
