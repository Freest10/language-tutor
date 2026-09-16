import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `desktop/build` — собранные бандлы оболочки и сервера, `desktop/resources`
    // и `desktop/.cache` — скачанные и собранные файлы whisper.cpp.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/build/**',
      'desktop/resources/**',
      'desktop/release/**',
      'desktop/.cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: [
      'eslint.config.js',
      'shared/**/*.ts',
      'server/**/*.ts',
      'desktop/**/*.ts',
      'desktop/scripts/*.mjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: [
      'web/vite.config.ts',
      'web/vitest.config.ts',
      'server/vitest.config.ts',
      'desktop/vitest.config.ts',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettierConfig,
);
