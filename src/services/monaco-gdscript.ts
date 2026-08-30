import type * as Monaco from 'monaco-editor'

export const GDSCRIPT_LANGUAGE_ID = 'gdscript'

const KEYWORDS = [
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

const CONSTANTS = ['true', 'false', 'null', 'self', 'PI', 'TAU', 'INF', 'NAN']

const TYPES = [
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

const CONFIGURATION: Monaco.languages.LanguageConfiguration = {
    comments: {lineComment: '#'},
    brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')']
    ],
    autoClosingPairs: [
        {open: '{', close: '}'},
        {open: '[', close: ']'},
        {open: '(', close: ')'},
        {open: '"', close: '"', notIn: ['string']},
        {open: "'", close: "'", notIn: ['string']}
    ],
    surroundingPairs: [
        {open: '{', close: '}'},
        {open: '[', close: ']'},
        {open: '(', close: ')'},
        {open: '"', close: '"'},
        {open: "'", close: "'"}
    ],
    indentationRules: {
        increaseIndentPattern: /:\s*(#.*)?$/,
        decreaseIndentPattern: /^\s*(pass|return|break|continue)\b.*$/
    }
}

const TOKENIZER: Monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    keywords: KEYWORDS,
    constants: CONSTANTS,
    types: TYPES,
    tokenizer: {
        root: [
            [/#.*$/, 'comment'],
            [/@[A-Za-z_]\w*/, 'annotation'],
            [/[$%][A-Za-z_"][\w/"]*/, 'variable.predefined'],
            [/"""/, {token: 'string.quote', next: '@blockString'}],
            [/"/, {token: 'string.quote', next: '@stringDouble'}],
            [/'/, {token: 'string.quote', next: '@stringSingle'}],
            [/\b\d[\d_]*\.[\d_]*(e[+-]?\d+)?\b/, 'number.float'],
            [/\b0x[0-9a-fA-F_]+\b/, 'number.hex'],
            [/\b\d[\d_]*\b/, 'number'],
            [
                /[A-Za-z_]\w*/,
                {
                    cases: {
                        '@keywords': 'keyword',
                        '@constants': 'constant',
                        '@types': 'type',
                        '@default': 'identifier'
                    }
                }
            ],
            [/[{}()[\]]/, '@brackets'],
            [/[<>=!+\-*/%&|^~:]+/, 'operator']
        ],
        blockString: [
            [/"""/, {token: 'string.quote', next: '@pop'}],
            [/./, 'string']
        ],
        stringDouble: [
            [/\\./, 'string.escape'],
            [/"/, {token: 'string.quote', next: '@pop'}],
            [/[^\\"]+/, 'string']
        ],
        stringSingle: [
            [/\\./, 'string.escape'],
            [/'/, {token: 'string.quote', next: '@pop'}],
            [/[^\\']+/, 'string']
        ]
    }
}

export function registerGdscript(monaco: typeof Monaco): void {
    if (monaco.languages.getLanguages().some(language => language.id === GDSCRIPT_LANGUAGE_ID)) {
        return
    }
    monaco.languages.register({
        id: GDSCRIPT_LANGUAGE_ID,
        extensions: ['.gd'],
        aliases: ['GDScript', 'gdscript'],
        mimetypes: ['text/x-gdscript']
    })
    monaco.languages.setLanguageConfiguration(GDSCRIPT_LANGUAGE_ID, CONFIGURATION)
    monaco.languages.setMonarchTokensProvider(GDSCRIPT_LANGUAGE_ID, TOKENIZER)
}

export function languageForPath(path: string): string {
    return path.endsWith('.gd') ? GDSCRIPT_LANGUAGE_ID : 'plaintext'
}
