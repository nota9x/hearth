import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import importX from 'eslint-plugin-import-x';
import playwright from 'eslint-plugin-playwright';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import svelte from 'eslint-plugin-svelte';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/.svelte-kit/**',
    '**/.wrangler/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/artifacts/**',
    '**/test-results/**',
    '**/playwright-report/**',
    'packages/core/bindings.d.ts',
    'packages/core/delivery-bindings.d.ts',
    'drizzle/meta/**',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,ts,svelte}'],
    extends: [js.configs.recommended, unicorn.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { 'import-x': importX, 'simple-import-sort': simpleImportSort },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-duplicates': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      // SQL NULL and explicit JSON null values are part of the application contract.
      'unicorn/no-null': 'off',
      // Keep established database modules and Cloudflare's Env naming convention.
      'unicorn/name-replacements': [
        'error',
        { allowList: { db: true, env: true, Env: true } },
      ],
      // These names appear in persisted schema and public API types.
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/no-non-function-verb-prefix': 'off',
      // Drizzle expressions are nested intentionally to mirror SQL predicates.
      'unicorn/max-nested-calls': 'off',
    },
  },
  {
    files: ['**/*.{ts,svelte}'],
    extends: [ts.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.svelte'],
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    extends: [svelte.configs.recommended],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { parser: ts.parser },
    },
    rules: {
      // The application is deployed at the origin root and also links to API endpoints.
      'svelte/no-navigation-without-resolve': 'off',
      'unicorn/filename-case': [
        'error',
        { cases: { kebabCase: true, pascalCase: true } },
      ],
      // Svelte rune state is declared at component scope and updated in handlers.
      'unicorn/no-top-level-assignment-in-function': 'off',
      // Modal actions are dispatched with independent state guards.
      'unicorn/prefer-else-if': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/prefer-simple-condition-first': 'off',
    },
  },
  {
    files: [
      '**/*.{js,mjs,cjs}',
      '*config.ts',
      'scripts/**/*.ts',
      'cli/**/*.ts',
      'tests/**/*.ts',
      'apps/web/*config.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['*config.{js,ts}', 'apps/web/*config.ts', 'cli/commands/*.ts'],
    rules: {
      // Tool configuration is constructed by each tool's configuration factory.
      'unicorn/no-top-level-side-effects': 'off',
    },
  },
  {
    files: [
      'cli/development/**/*.ts',
      'cli/index.ts',
      'cli/development/tool-process.mjs',
    ],
    rules: {
      // These CLI entry points own process shutdown and its shared state.
      'unicorn/no-process-exit': 'off',
      'unicorn/no-top-level-assignment-in-function': 'off',
    },
  },
  {
    files: ['tests/**/*.test.ts'],
    extends: [vitest.configs.recommended],
    rules: {
      // Vitest fixtures are initialized in beforeAll and shared by tests.
      'unicorn/no-top-level-assignment-in-function': 'off',
    },
  },
  {
    files: ['packages/core/upload.ts'],
    rules: {
      // Busboy events store a promise; its rejection must be handled asynchronously.
      'unicorn/prefer-await': 'off',
    },
  },
  {
    files: ['tests/**/*.spec.ts'],
    extends: [playwright.configs['flat/recommended']],
    rules: {
      // page.evaluate callbacks execute in the browser, with browser globals.
      'unicorn/isolated-functions': 'off',
    },
  },
  // Keep formatting in Prettier and disable conflicting ESLint/Svelte rules.
  prettier,
  svelte.configs.prettier,
);
