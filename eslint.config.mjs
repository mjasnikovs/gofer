import js from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    {ignores: ['dist', 'node_modules', 'src-tauri/target', 'src-tauri/gen']},
    {
        files: ['**/*.{ts,tsx}'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.strictTypeChecked,
            ...tseslint.configs.stylisticTypeChecked,
            reactHooks.configs.flat.recommended,
            reactRefresh.configs.vite,
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
        files: ['vite.config.ts'],
        languageOptions: {globals: globals.node}
    }
)
