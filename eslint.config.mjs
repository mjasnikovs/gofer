import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    {ignores: ['dist', 'node_modules', 'src-tauri/target', 'src-tauri/gen', 'src-tauri/workers']},
    {
        files: ['**/*.{ts,tsx}'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.strictTypeChecked,
            ...tseslint.configs.stylisticTypeChecked,
            eslintConfigPrettier
        ],
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 2024,
            globals: globals.browser,
            parserOptions: {
                tsconfigRootDir: import.meta.dirname,
                projectService: true
            }
        },
        rules: {
            '@typescript-eslint/no-unsafe-call': 'warn',
            '@typescript-eslint/no-unsafe-member-access': 'warn',
            '@typescript-eslint/require-await': 'warn',
            '@typescript-eslint/no-unsafe-argument': 'warn',
            '@typescript-eslint/no-misused-promises': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                {
                    args: 'all',
                    argsIgnorePattern: '^_',
                    caughtErrors: 'all',
                    caughtErrorsIgnorePattern: '^_',
                    destructuredArrayIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    ignoreRestSiblings: true
                }
            ],
            '@typescript-eslint/unbound-method': 'warn',
            '@typescript-eslint/no-floating-promises': 'warn',
            '@typescript-eslint/no-explicit-any': 'error',
            'no-empty': ['error', {allowEmptyCatch: true}],
            'linebreak-style': ['error', 'unix'],
            quotes: ['error', 'single', {allowTemplateLiterals: true, avoidEscape: true}],
            semi: ['error', 'never'],
            'no-tabs': 'off',
            'object-curly-spacing': ['error', 'never'],
            'array-bracket-spacing': ['error', 'never'],
            'computed-property-spacing': ['error', 'never'],
            'brace-style': ['error', '1tbs'],
            'keyword-spacing': 'error',
            'eol-last': 'error',
            'no-trailing-spaces': 'error',
            'no-redeclare': 'error',
            'no-shadow': ['error', {allow: ['_']}],
            camelcase: 'off'
        }
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        "CallExpression[callee.object.name='vi'][callee.property.name='mock'] > Literal[value=/(^|\\u002f)desktop$/]",
                    message:
                        'Install a fake with src/test/desktop-driver.ts. Mocking services/desktop hides a renamed command from the tests that mount the most of the application.'
                }
            ]
        }
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        ignores: [
            'src/services/turn.ts',
            'src/models/chat-timeline.ts',
            'src/models/chat-timeline.test.ts',
            'src/components/workspace/ChatConversation.tsx'
        ],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/models/chat-timeline', './chat-timeline'],
                            message:
                                'Run turns through services/turn.ts. The timeline transformers are only correct in the order it applies them.'
                        }
                    ]
                }
            ]
        }
    },
    {
        files: ['src/**/*.{ts,tsx}'],
        extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite]
    },
    {
        files: ['vite.config.ts'],
        languageOptions: {globals: globals.node}
    },
    {
        // `astryx theme build` emits these; the triple-slash reference is its own.
        files: ['src/theme/gofer.d.ts', 'src/theme/gofer.variants.d.ts'],
        rules: {'@typescript-eslint/triple-slash-reference': 'off'}
    }
)
