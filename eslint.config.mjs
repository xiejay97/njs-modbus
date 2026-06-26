import js from '@eslint/js';
import gitignore from 'eslint-config-flat-gitignore';
import importPlugin from 'eslint-plugin-import';
import prettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── 1. Global ignores ──
  gitignore(),

  // ── 2. Formatting (Prettier) ──
  prettierRecommended,

  // ── 3. JavaScript ──
  js.configs.recommended,

  // ── 4. TypeScript ──
  ...tseslint.configs.recommended,

  // ── 5. Import ──
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,

  {
    files: ['**/*.{js,ts,jsx,tsx,mjs,mts,cjs,cts}'],
    rules: {
      // Turn off rules that conflict with project setup
      'import/no-unresolved': 'off',
      '@typescript-eslint/no-require-imports': 'off',

      // JS rules
      curly: 'error',
      'no-unreachable': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],

      // TypeScript rules
      '@typescript-eslint/array-type': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/method-signature-style': 'error',
      '@typescript-eslint/no-confusing-non-null-assertion': 'error',
      '@typescript-eslint/no-inferrable-types': [
        'error',
        {
          ignoreParameters: true,
          ignoreProperties: true,
        },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          caughtErrors: 'none',
          ignoreRestSiblings: false,
        },
      ],
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': ['error'],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',

      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      // Import ordering
      'import/order': [
        'error',
        {
          groups: ['type', 'builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroupsExcludedImportTypes: ['type', 'builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: false,
          },
          warnOnUnassignedImports: true,
        },
      ],
    },
  },
);
