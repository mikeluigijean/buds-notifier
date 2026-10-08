// Lint the extension and tests:  npx eslint@9 .
import js from '@eslint/js';

const gjsGlobals = {
    console: 'readonly',
    print: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
};

export default [
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', caughtErrors: 'none'}],
            'prefer-const': 'error',
            'no-var': 'error',
            eqeqeq: ['error', 'always'],
        },
    },
];
