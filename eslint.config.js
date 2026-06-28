// ESLint v10+ flat config.
// Migrado desde .eslintrc.json (legacy format).
// https://eslint.org/docs/latest/use/configure/configuration-files

import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  // Ignorar archivos generados y dependencias
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // Reglas base (subset de eslint:recommended aplicables a TS)
  {
    rules: {
      'no-unused-vars': 'off', // Lo maneja @typescript-eslint/no-unused-vars
      'no-undef': 'off',       // TS lo maneja con su propio sistema de tipos
      'no-redeclare': 'off',   // TS detecta redeclaraciones
    },
  },

  // Configuración TypeScript para src/ y tests/
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        // Node.js globals
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // Vitest globals
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'warn',
      'eqeqeq': 'error',
      'curly': 'error',
    },
  },
];