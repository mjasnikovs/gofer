import type * as Monaco from 'monaco-editor'
import {CONSTANTS, GDSCRIPT_LANGUAGE_ID, KEYWORDS, TYPES} from './gdscript-syntax'

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
