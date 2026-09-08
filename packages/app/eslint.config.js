import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // *.d.ts files are tsc-generated build artifacts (committed as siblings,
  // regenerated in periodic chore commits) — not hand-maintained source.
  // The same applies to the compiled *.test.js twins tsc emits next to the
  // .ts suites (jest runs only .ts/.tsx, see jest.config testMatch), and to
  // the built web/widget bundles under site*/: their inlined
  // eslint-disable comments reference rules this flat config doesn't define,
  // which surfaced as dozens of "Definition for rule ... not found" errors
  // on every lint run.
  {
    ignores: [
      'dist',
      '**/*.d.ts',
      'src/**/*.test.js',
      'site/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Codebase convention: a leading underscore marks intentionally unused
      // bindings (placeholder args, rest-sibling exclusion destructuring).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Context files export the consumer hook next to its Provider — the
    // canonical React context pattern. Fast-refresh falls back to a full
    // reload for these files in dev; not worth restructuring (CS 2026-07-09).
    // NodeTrajectorySettings exports the pure clampOrder01 helper next to
    // the component, deliberately, for unit-testing the slider invariant —
    // same accepted trade-off.
    files: ['src/contexts/**/*.tsx', 'src/components/NodeTrajectorySettings.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
)
