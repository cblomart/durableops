import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['dist/**', 'coverage/**', 'node_modules/**', 'test-harness/**', 'infra/**']),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  pluginVue.configs['flat/recommended'],

  {
    languageOptions: {
      // This is a browser-only app: no Node globals should resolve in src/.
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },

  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },

  {
    rules: {
      // The brief bans `any` outright.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',

      // Quality gates from the brief: build fails on breach.
      complexity: ['error', 10],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 3],

      // This tool must never persist anything but favourite app names, and must
      // never ship telemetry. These make a violation a build failure rather than
      // something a reviewer has to spot.
      'no-restricted-globals': [
        'error',
        {
          name: 'sessionStorage',
          message:
            'DurableOps persists nothing but favourite app names (localStorage). System keys and tokens are memory-only.',
        },
        {
          name: 'indexedDB',
          message: 'DurableOps must not persist Azure data. Keys and tokens are memory-only.',
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      // Complexity/length limits guard production maintainability; test fixtures
      // legitimately wire many branches (stubs per Azure route) and long tables.
      'max-lines-per-function': 'off',
      complexity: 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  // Config files are plain JS outside the app's tsconfig: lint them, but without
  // type-aware rules that need a program they were never part of.
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Build/test config runs under Node, unlike everything in src/.
  {
    files: ['vite.config.ts', 'playwright.config.ts', 'tests/e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  prettier,
]);
